import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "./events.ts";
import { assertHandleId } from "./ids.ts";
import type { LeaseHandle, Ledger } from "./ledger.ts";
import { reduce, type RunView } from "./reducer.ts";

interface ReplayResult {
  readonly byEventId: ReadonlyMap<string, RunEvent>;
  readonly view: RunView | null;
  readonly validByteLength: number;
  readonly needsLeadingNewline: boolean;
}

interface CommitState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly state: "idle" | "writing";
}

interface ControllerLeaseRecord {
  readonly schemaVersion: 1;
  readonly controllerId: string;
  readonly pid: number;
  readonly epoch: number;
  readonly acquiredAt: number;
}

let snapshotSequence = 0;
let commitStateSequence = 0;
let leaseSequence = 0;
const COMMIT_INTENT_FILE = "commit-intent.json";
const COMMIT_STATE_FILE = "commit-state.json";
const STABLE_READ_ATTEMPTS = 3;

function realPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

export function resolveLedgerRoot(environment = process.env): string {
  const configured = environment.FLOW_LEDGER_ROOT;
  if (configured && configured.length > 0) return configured;
  const xdgStateHome = environment.XDG_STATE_HOME;
  if (xdgStateHome && xdgStateHome.length > 0) {
    return join(xdgStateHome, "agent-flow");
  }
  return join(homedir(), ".local", "state", "agent-flow");
}

function corruption(path: string, line: number, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`corrupt event stream "${path}" at line ${line}: ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function replayFile(path: string): Promise<ReplayResult> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        byEventId: new Map(),
        view: null,
        validByteLength: 0,
        needsLeadingNewline: false,
      };
    }
    throw error;
  }

  const endsWithNewline = contents.endsWith("\n");
  const lines = contents.split("\n");
  if (endsWithNewline) lines.pop();

  const byEventId = new Map<string, RunEvent>();
  let state: RunView | undefined;
  let validByteLength = Buffer.byteLength(contents);
  let ignoredTrailingPartial = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let event: RunEvent;
    try {
      event = JSON.parse(line) as RunEvent;
    } catch (error) {
      if (!endsWithNewline && index === lines.length - 1) {
        const validPrefix = lines.slice(0, index).join("\n");
        validByteLength = Buffer.byteLength(
          index === 0 ? "" : `${validPrefix}\n`,
        );
        ignoredTrailingPartial = true;
        break;
      }
      throw corruption(path, index + 1, error);
    }

    const prior = byEventId.get(event.eventId);
    if (prior) {
      if (!isDeepStrictEqual(prior, event)) {
        throw corruption(
          path,
          index + 1,
          `eventId "${event.eventId}" has conflicting payloads`,
        );
      }
      continue;
    }

    try {
      state = reduce(state, event);
    } catch (error) {
      throw corruption(path, index + 1, error);
    }
    byEventId.set(event.eventId, event);
  }
  return {
    byEventId,
    view: state ?? null,
    validByteLength,
    needsLeadingNewline:
      !ignoredTrailingPartial && contents.length > 0 && !endsWithNewline,
  };
}

export class FsLedger implements Ledger {
  private readonly commitTails = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly isPidAlive: (pid: number) => boolean = realPidIsAlive,
  ) {
    if (root.length === 0) throw new Error("FsLedger root must not be empty");
  }

  commit(event: RunEvent): Promise<void> {
    assertHandleId("runId", event.runId);
    const prior = this.commitTails.get(event.runId) ?? Promise.resolve();
    const commit = prior.then(async () => {
      const runDir = this.runDir(event.runId);
      const eventFile = join(runDir, "events.jsonl");
      const replayed = await this.readStableReplay(event.runId);
      const duplicate = replayed.byEventId.get(event.eventId);
      if (duplicate) {
        if (!isDeepStrictEqual(duplicate, event)) {
          throw new Error(
            `eventId "${event.eventId}" already exists with a different payload`,
          );
        }
      }

      const next = duplicate
        ? replayed.view
        : reduce(replayed.view ?? undefined, event);
      await mkdir(runDir, { recursive: true });
      const writingState = await this.enterCommitState(runDir, event.runId);
      if (duplicate) {
        try {
          await this.truncateTrailingPartial(eventFile, replayed);
        } finally {
          await this.leaveCommitState(runDir, writingState);
        }
        return;
      }
      if (!next) throw new Error("commit reducer produced no run view");
      let snapshotTemp: string;
      try {
        snapshotTemp = await this.writeSnapshotTemp(runDir, next);
      } catch (snapshotError) {
        try {
          await this.leaveCommitState(runDir, writingState);
        } catch (stateError) {
          throw new Error(
            `snapshot write failed: ${errorMessage(snapshotError)}; commit state cleanup failed: ${errorMessage(stateError)}`,
            { cause: snapshotError },
          );
        }
        throw snapshotError;
      }
      try {
        await this.writeCommitIntent(runDir, {
          eventId: event.eventId,
          lastValidByteLength: replayed.validByteLength,
        });
      } catch (error) {
        await unlink(snapshotTemp).catch(() => {});
        try {
          await this.clearCommitIntent(runDir);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error(
              `commit intent write failed: ${errorMessage(error)}; marker cleanup failed: ${errorMessage(cleanupError)}`,
              { cause: error },
            );
          }
        }
        await this.leaveCommitState(runDir, writingState);
        throw error;
      }

      let handle: FileHandle | undefined;
      try {
        try {
          handle = await open(eventFile, "a+");
        } catch (openError) {
          await unlink(snapshotTemp).catch(() => {});
          try {
            await this.clearCommitIntent(runDir);
          } catch (cleanupError) {
            throw new Error(
              `event file open failed: ${errorMessage(openError)}; marker cleanup failed: ${errorMessage(cleanupError)}`,
              { cause: openError },
            );
          }
          await this.leaveCommitState(runDir, writingState);
          throw openError;
        }
        const currentSize = (await handle.stat()).size;
        if (currentSize < replayed.validByteLength) {
          throw new Error(`event stream "${eventFile}" changed during commit`);
        }
        const originalSize = replayed.validByteLength;
        try {
          if (currentSize > originalSize) {
            await handle.truncate(originalSize);
            await handle.sync();
          }
          const separator = replayed.needsLeadingNewline ? "\n" : "";
          await this.appendAndSync(
            handle,
            `${separator}${JSON.stringify(event)}\n`,
          );
        } catch (appendError) {
          try {
            await this.rollbackAppend(handle, originalSize);
          } catch (rollbackError) {
            const compound = new Error(
              `event append failed: ${errorMessage(appendError)}; rollback failed: ${errorMessage(rollbackError)}`,
              { cause: appendError },
            );
            // The write-ahead marker is intentionally retained. A fresh
            // process will refuse the run rather than replay the orphan.
            throw compound;
          }
          await unlink(snapshotTemp).catch(() => {});
          try {
            await this.clearCommitIntent(runDir);
          } catch (cleanupError) {
            throw new Error(
              `event append failed: ${errorMessage(appendError)}; marker cleanup failed: ${errorMessage(cleanupError)}`,
              { cause: appendError },
            );
          }
          await this.leaveCommitState(runDir, writingState);
          throw appendError;
        }
      } catch (error) {
        await unlink(snapshotTemp).catch(() => {});
        throw error;
      } finally {
        await handle?.close().catch(() => {});
      }
      // The event fsync above is the commit point. A snapshot is only a cache;
      // replay must remain authoritative even if materialization is interrupted.
      try {
        await rename(snapshotTemp, join(runDir, "run.json"));
      } catch {
        await unlink(snapshotTemp).catch(() => {});
      }
      try {
        await this.clearCommitIntent(runDir);
      } catch {
        // The durable append is already the commit point. Resolving here keeps
        // the event from becoming rejected-but-readable; if the marker still
        // exists, later readers conservatively refuse the run.
        return;
      }
      try {
        await this.leaveCommitState(runDir, writingState);
      } catch {
        // The event is durably committed and the persisted state remains
        // "writing". Readers fail closed until repair rather than allowing a
        // rejected event to become visible after this promise settles.
      }
    });
    const tail = commit.then(
      () => undefined,
      () => undefined,
    );
    this.commitTails.set(event.runId, tail);
    void tail.then(() => {
      if (this.commitTails.get(event.runId) === tail) {
        this.commitTails.delete(event.runId);
      }
    });
    return commit;
  }

  async load(runId: string): Promise<RunView | null> {
    assertHandleId("runId", runId);
    return (await this.readStableReplay(runId)).view;
  }

  async list(): Promise<{ runId: string }[]> {
    const runsDir = join(this.root, "runs");
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ runId: entry.name }))
      .sort((left, right) => left.runId.localeCompare(right.runId));
  }

  async acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    assertHandleId("runId", runId);
    const runDir = this.runDir(runId);
    await mkdir(runDir, { recursive: true });
    const lockFile = join(runDir, "controller.lock");
    const record = (
      epoch: number,
    ): ControllerLeaseRecord => ({
      schemaVersion: 1,
      ...controller,
      epoch,
      acquiredAt: Date.now(),
    });
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await this.readControllerLease(lockFile, runId);
      if (this.isPidAlive(holder.pid)) {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      await this.replaceControllerLease(
        runDir,
        lockFile,
        record(holder.epoch + 1),
      );
    }
    if (handle) {
      try {
        await handle.writeFile(`${JSON.stringify(record(0))}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close();
        await unlink(lockFile).catch(() => {});
        throw error;
      }
      await handle.close();
    }

    let released = false;
    let releaseInFlight: Promise<void> | null = null;
    return {
      release: () => {
        if (released) return Promise.resolve();
        if (releaseInFlight) return releaseInFlight;
        releaseInFlight = unlink(lockFile)
          .then(() => {
            released = true;
          })
          .finally(() => {
            releaseInFlight = null;
          });
        return releaseInFlight;
      },
    };
  }

  private async readControllerLease(
    lockFile: string,
    runId: string,
  ): Promise<ControllerLeaseRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(lockFile, "utf8"));
    } catch (error) {
      throw new Error(`corrupt controller lease for run "${runId}"`, {
        cause: error,
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      typeof (parsed as { controllerId?: unknown }).controllerId !== "string" ||
      !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
      (parsed as { pid: number }).pid <= 0 ||
      !Number.isSafeInteger((parsed as { epoch?: unknown }).epoch) ||
      (parsed as { epoch: number }).epoch < 0 ||
      !Number.isFinite((parsed as { acquiredAt?: unknown }).acquiredAt)
    ) {
      throw new Error(`corrupt controller lease for run "${runId}"`);
    }
    return parsed as ControllerLeaseRecord;
  }

  private async replaceControllerLease(
    runDir: string,
    lockFile: string,
    record: ControllerLeaseRecord,
  ): Promise<void> {
    const temp = join(
      runDir,
      `.controller.lock.tmp-${process.pid}-${++leaseSequence}`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temp, "wx");
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, lockFile);
      const directory = await open(runDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  private runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  protected async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  }

  protected async rollbackAppend(
    handle: FileHandle,
    originalSize: number,
  ): Promise<void> {
    await handle.truncate(originalSize);
    await handle.sync();
  }

  protected async writeSnapshotFile(
    path: string,
    contents: string,
  ): Promise<void> {
    await writeFile(path, contents, "utf8");
  }

  private async readStableReplay(runId: string): Promise<ReplayResult> {
    const eventFile = join(this.runDir(runId), "events.jsonl");
    let lastReason = "commit state changed during replay";
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
      const before = await this.readCommitState(runId);
      if (before.state !== "idle") {
        lastReason = `generation ${before.generation} is writing`;
        continue;
      }
      try {
        await this.assertNoCommitIntent(runId);
      } catch (error) {
        lastReason = errorMessage(error);
        continue;
      }
      await this.afterStableReadPhase(runId, "before-replay");
      const replayed = await replayFile(eventFile);
      await this.afterStableReadPhase(runId, "after-replay");
      const after = await this.readCommitState(runId);
      try {
        await this.assertNoCommitIntent(runId);
      } catch (error) {
        lastReason = errorMessage(error);
        continue;
      }
      if (
        after.state === "idle" &&
        after.generation === before.generation
      ) {
        return replayed;
      }
      lastReason = `generation changed from ${before.generation}/${before.state} to ${after.generation}/${after.state}`;
    }
    throw new Error(
      `run "${runId}" has an ambiguous commit: cannot obtain a stable committed view; ${lastReason}`,
    );
  }

  /** Test seam for deterministically interleaving a public load with a commit. */
  protected async afterStableReadPhase(
    _runId: string,
    _phase: "before-replay" | "after-replay",
  ): Promise<void> {}

  private async readCommitState(runId: string): Promise<CommitState> {
    const path = join(this.runDir(runId), COMMIT_STATE_FILE);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, generation: 0, state: "idle" };
      }
      throw new Error(`cannot read commit state for run "${runId}"`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`corrupt commit state for run "${runId}"`, {
        cause: error,
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Number.isSafeInteger((parsed as { generation?: unknown }).generation) ||
      ((parsed as { generation: number }).generation < 0) ||
      ((parsed as { state?: unknown }).state !== "idle" &&
        (parsed as { state?: unknown }).state !== "writing")
    ) {
      throw new Error(`corrupt commit state for run "${runId}"`);
    }
    const state = parsed as CommitState;
    if (
      (state.state === "idle" && state.generation % 2 !== 0) ||
      (state.state === "writing" && state.generation % 2 !== 1)
    ) {
      throw new Error(`corrupt commit state for run "${runId}"`);
    }
    return state;
  }

  private async enterCommitState(
    runDir: string,
    runId: string,
  ): Promise<CommitState> {
    const current = await this.readCommitState(runId);
    if (current.state !== "idle") {
      throw new Error(
        `run "${runId}" has an ambiguous commit at generation ${current.generation}`,
      );
    }
    await this.assertNoCommitIntent(runId);
    const writing: CommitState = {
      schemaVersion: 1,
      generation: current.generation + 1,
      state: "writing",
    };
    await this.writeCommitState(runDir, writing);
    return writing;
  }

  private async leaveCommitState(
    runDir: string,
    writing: CommitState,
  ): Promise<void> {
    await this.writeCommitState(runDir, {
      schemaVersion: 1,
      generation: writing.generation + 1,
      state: "idle",
    });
  }

  protected async writeCommitState(
    runDir: string,
    state: CommitState,
  ): Promise<void> {
    const target = join(runDir, COMMIT_STATE_FILE);
    const temp = join(
      runDir,
      `.${COMMIT_STATE_FILE}.tmp-${process.pid}-${++commitStateSequence}`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temp, "wx");
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, target);
      const directory = await open(runDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  private async assertNoCommitIntent(runId: string): Promise<void> {
    const path = join(this.runDir(runId), COMMIT_INTENT_FILE);
    let marker: string;
    try {
      marker = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`cannot verify commit intent for run "${runId}"`, {
        cause: error,
      });
    }
    throw new Error(
      `run "${runId}" has an ambiguous commit: ${marker.trim() || "commit intent marker present"}`,
    );
  }

  protected async writeCommitIntent(
    runDir: string,
    intent: {
      eventId: string;
      lastValidByteLength: number;
    },
  ): Promise<void> {
    const path = join(runDir, COMMIT_INTENT_FILE);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx");
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, ...intent }, null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle?.close().catch(() => {});
    }
    const directory = await open(runDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  protected async clearCommitIntent(runDir: string): Promise<void> {
    await unlink(join(runDir, COMMIT_INTENT_FILE));
    const directory = await open(runDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async truncateTrailingPartial(
    eventFile: string,
    replayed: ReplayResult,
  ): Promise<void> {
    let handle;
    try {
      handle = await open(eventFile, "r+");
      const size = (await handle.stat()).size;
      if (size > replayed.validByteLength) {
        await handle.truncate(replayed.validByteLength);
        await handle.sync();
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async writeSnapshotTemp(runDir: string, view: RunView): Promise<string> {
    const temp = join(
      runDir,
      `.run.json.tmp-${process.pid}-${++snapshotSequence}`,
    );
    try {
      await this.writeSnapshotFile(
        temp,
        `${JSON.stringify(view, null, 2)}\n`,
      );
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    return temp;
  }
}
