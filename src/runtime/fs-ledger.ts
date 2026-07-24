import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

interface ControllerTakeoverMarker {
  readonly schemaVersion: 1;
  readonly pid: number;
}

interface CommitLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
}

type Sleep = (milliseconds: number) => Promise<void>;

let snapshotSequence = 0;
let commitStateSequence = 0;
let leaseSequence = 0;
let commitLockSequence = 0;
const COMMIT_INTENT_FILE = "commit-intent.json";
const COMMIT_STATE_FILE = "commit-state.json";
const COMMIT_LOCK_FILE = "commit.lock";
const COMMIT_LOCK_BACKOFF_MS = [25, 50, 100, 200, 400] as const;
const COMMIT_LOCK_RECLAIM_GUARD_ATTEMPTS = 4;
const TAKEOVER_ATTEMPTS = 4;
const TAKEOVER_GUARD_ACQUIRE_ATTEMPTS = 4;
const STABLE_READ_ATTEMPTS = 3;

const realSleep: Sleep = (milliseconds) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function realPidIsAlive(pid: number): boolean {
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
    private readonly sleep: Sleep = realSleep,
    private readonly nonceGen: () => string = randomUUID,
  ) {
    if (root.length === 0) throw new Error("FsLedger root must not be empty");
  }

  commit(event: RunEvent): Promise<void> {
    assertHandleId("runId", event.runId);
    const prior = this.commitTails.get(event.runId) ?? Promise.resolve();
    const commit = prior.then(async () => {
      const runDir = this.runDir(event.runId);
      await mkdir(runDir, { recursive: true });
      return this.withCommitLock(runDir, event.runId, async () => {
        const eventFile = join(runDir, "events.jsonl");
        const replayed = await this.readStableReplay(event.runId);
        await this.afterStableReplayPhase(event.runId);
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
      await this.takeOverControllerLease(
        runDir,
        lockFile,
        runId,
        holder,
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

  private async takeOverControllerLease(
    runDir: string,
    lockFile: string,
    runId: string,
    observed: ControllerLeaseRecord,
    replacement: ControllerLeaseRecord,
  ): Promise<void> {
    let holder = observed;
    const marker: ControllerTakeoverMarker = {
      schemaVersion: 1,
      pid: replacement.pid,
    };

    for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt++) {
      const markerFile = join(
        runDir,
        `.controller.takeover.epoch-${holder.epoch}`,
      );
      if (await this.createControllerTakeoverMarker(markerFile, marker)) {
        await this.afterControllerTakeoverPhase(
          runId,
          "before-lock-replace",
        );
        const currentMarker = await this.readControllerTakeoverMarker(
          markerFile,
          runId,
        );
        const currentHolder = await this.readControllerLease(lockFile, runId);
        if (currentHolder.epoch > holder.epoch) {
          if (this.isPidAlive(currentHolder.pid)) {
            throw new Error(
              `controller lease for run "${runId}" is already held`,
            );
          }
          holder = currentHolder;
          continue;
        }
        if (
          !isDeepStrictEqual(currentMarker, marker) ||
          !isDeepStrictEqual(currentHolder, holder) ||
          this.isPidAlive(currentHolder.pid)
        ) {
          throw new Error(
            `controller lease for run "${runId}" is already held`,
          );
        }
        await this.replaceControllerLease(runDir, lockFile, {
          ...replacement,
          epoch: holder.epoch + 1,
        });
        return;
      }

      const currentHolder = await this.readControllerLease(lockFile, runId);
      if (currentHolder.epoch > holder.epoch) {
        if (this.isPidAlive(currentHolder.pid)) {
          throw new Error(
            `controller lease for run "${runId}" is already held`,
          );
        }
        holder = currentHolder;
        continue;
      }
      if (
        !isDeepStrictEqual(currentHolder, holder) ||
        this.isPidAlive(currentHolder.pid)
      ) {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      const existingMarker = await this.readControllerTakeoverMarker(
        markerFile,
        runId,
      );
      if (this.isPidAlive(existingMarker.pid)) {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      await this.afterControllerTakeoverPhase(runId, "after-dead-marker-read");
      await this.acquireControllerTakeoverReclaimGuard(
        runDir,
        runId,
        holder.epoch,
        replacement.pid,
      );

      const guardedHolder = await this.readControllerLease(lockFile, runId);
      if (guardedHolder.epoch > holder.epoch) {
        if (this.isPidAlive(guardedHolder.pid)) {
          throw new Error(
            `controller lease for run "${runId}" is already held`,
          );
        }
        holder = guardedHolder;
        continue;
      }
      if (!isDeepStrictEqual(guardedHolder, holder)) {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      const guardedMarker = await this.readControllerTakeoverMarker(
        markerFile,
        runId,
      );
      if (
        !isDeepStrictEqual(guardedMarker, existingMarker) ||
        this.isPidAlive(guardedMarker.pid)
      ) {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      await unlink(markerFile);
    }
    throw new Error(`controller lease for run "${runId}" is already held`);
  }

  private async createControllerTakeoverMarker(
    markerFile: string,
    marker: ControllerTakeoverMarker,
  ): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(markerFile, "wx");
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return true;
    } catch (error) {
      await handle?.close().catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      if (handle) await unlink(markerFile).catch(() => {});
      throw error;
    }
  }

  private async acquireControllerTakeoverReclaimGuard(
    runDir: string,
    runId: string,
    epoch: number,
    pid: number,
  ): Promise<void> {
    const guard: ControllerTakeoverMarker = {
      schemaVersion: 1,
      pid,
    };
    for (
      let attempt = 0;
      attempt < TAKEOVER_GUARD_ACQUIRE_ATTEMPTS;
      attempt++
    ) {
      const guards = await this.readControllerTakeoverReclaimGuards(
        runDir,
        runId,
        epoch,
      );
      const highest = guards.at(-1);
      if (
        highest &&
        (highest.marker.pid === process.pid ||
          this.isPidAlive(highest.marker.pid))
      ) {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      const ordinal = highest ? highest.ordinal + 1 : 0;
      if (!Number.isSafeInteger(ordinal)) {
        throw new Error(
          `corrupt controller takeover guard ordinal for run "${runId}"`,
        );
      }
      const guardFile = join(
        runDir,
        `.controller.takeover.epoch-${epoch}.reclaim-${ordinal}`,
      );
      if (await this.createControllerTakeoverMarker(guardFile, guard)) return;
    }
    throw new Error(`controller lease for run "${runId}" is already held`);
  }

  private async readControllerTakeoverReclaimGuards(
    runDir: string,
    runId: string,
    epoch: number,
  ): Promise<
    Array<{ ordinal: number; marker: ControllerTakeoverMarker }>
  > {
    const prefix = `.controller.takeover.epoch-${epoch}.reclaim-`;
    const guards: Array<{
      ordinal: number;
      marker: ControllerTakeoverMarker;
    }> = [];
    for (const name of await readdir(runDir)) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^(?:0|[1-9]\d*)$/.test(suffix)) {
        throw new Error(
          `corrupt controller takeover guard ordinal for run "${runId}"`,
        );
      }
      const ordinal = Number(suffix);
      if (!Number.isSafeInteger(ordinal)) {
        throw new Error(
          `corrupt controller takeover guard ordinal for run "${runId}"`,
        );
      }
      guards.push({
        ordinal,
        marker: await this.readControllerTakeoverMarker(
          join(runDir, name),
          runId,
        ),
      });
    }
    guards.sort((left, right) => left.ordinal - right.ordinal);
    return guards;
  }

  private async readControllerTakeoverMarker(
    markerFile: string,
    runId: string,
  ): Promise<ControllerTakeoverMarker> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(markerFile, "utf8"));
    } catch (error) {
      throw new Error(`corrupt controller takeover marker for run "${runId}"`, {
        cause: error,
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
      (parsed as { pid: number }).pid <= 0
    ) {
      throw new Error(`corrupt controller takeover marker for run "${runId}"`);
    }
    return parsed as ControllerTakeoverMarker;
  }

  private runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  protected async withCommitLock(
    runDir: string,
    runId: string,
    commit: () => Promise<void>,
  ): Promise<void> {
    let owned: CommitLockRecord | undefined;
    let commitError: unknown;
    try {
      owned = await this.acquireCommitLock(runDir, runId);
      await this.afterCommitLockPhase(runId, "acquired");
      await commit();
    } catch (error) {
      commitError = error;
      throw error;
    } finally {
      if (owned) {
        let cleanupError: unknown;
        try {
          await this.afterCommitLockPhase(runId, "before-release");
        } catch (error) {
          cleanupError = error;
        }
        try {
          await this.releaseCommitLock(runDir, owned.nonce);
        } catch (releaseError) {
          cleanupError = cleanupError
            ? new Error(
                `commit lock before-release phase failed: ${errorMessage(cleanupError)}; commit lock release failed: ${errorMessage(releaseError)}`,
                { cause: cleanupError },
              )
            : releaseError;
        }
        if (cleanupError) {
          if (commitError) {
            throw new Error(
              `commit failed: ${errorMessage(commitError)}; commit lock release failed: ${errorMessage(cleanupError)}`,
              { cause: commitError },
            );
          }
          // The commit body resolves only after the event fsync commit point.
          // Post-commit lock cleanup cannot turn a durable event into rejection.
        }
      }
    }
  }

  private async acquireCommitLock(
    runDir: string,
    runId: string,
  ): Promise<CommitLockRecord> {
    const lockFile = join(runDir, COMMIT_LOCK_FILE);
    const record = this.nextCommitLockRecord();
    for (
      let attempt = 0;
      attempt <= COMMIT_LOCK_BACKOFF_MS.length;
      attempt++
    ) {
      if (await this.createCommitLock(runDir, lockFile, runId, record)) {
        return record;
      }
      const holder = await this.readCommitLock(lockFile, runId);
      if (holder && !this.isPidAlive(holder.pid)) {
        const reclaimed = await this.reclaimCommitLock(
          runDir,
          lockFile,
          runId,
          holder,
        );
        if (reclaimed) return reclaimed;
      }
      const backoff = COMMIT_LOCK_BACKOFF_MS[attempt];
      if (backoff === undefined) {
        throw new Error(`commit lock for run "${runId}" is contended`);
      }
      await this.sleep(backoff);
    }
    throw new Error(`commit lock for run "${runId}" is contended`);
  }

  private nextCommitLockRecord(): CommitLockRecord {
    const nonce = this.nonceGen();
    if (typeof nonce !== "string" || nonce.length === 0) {
      throw new Error("commit lock nonce must not be empty");
    }
    return { schemaVersion: 1, pid: process.pid, nonce };
  }

  private async createCommitLock(
    runDir: string,
    lockFile: string,
    runId: string,
    record: CommitLockRecord,
  ): Promise<boolean> {
    return this.installCommitLockRecord(
      runDir,
      lockFile,
      runId,
      "lock",
      record,
    );
  }

  private async installCommitLockRecord(
    runDir: string,
    targetFile: string,
    runId: string,
    target: "lock" | "reclaim-guard",
    record: CommitLockRecord,
  ): Promise<boolean> {
    const temp = join(
      runDir,
      `.${COMMIT_LOCK_FILE}.tmp-${process.pid}-${++commitLockSequence}`,
    );
    let handle: FileHandle | undefined;
    let installed = false;
    let tempExists = false;
    try {
      handle = await open(temp, "wx");
      tempExists = true;
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.afterCommitLockTempPhase(runId, target);
      try {
        // A hardlink publishes the already-synced inode without exposing an
        // empty target between exclusive creation and record initialization.
        await link(temp, targetFile);
        installed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await unlink(temp);
      tempExists = false;
      await this.syncDirectory(runDir);
      return installed;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (tempExists) await unlink(temp).catch(() => {});
      if (installed) await unlink(targetFile).catch(() => {});
      throw error;
    }
  }

  private async readCommitLock(
    lockFile: string,
    runId: string,
  ): Promise<CommitLockRecord | null> {
    let contents: string;
    try {
      contents = await readFile(lockFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`corrupt commit lock for run "${runId}"`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`corrupt commit lock for run "${runId}"`, {
        cause: error,
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
      (parsed as { pid: number }).pid <= 0 ||
      typeof (parsed as { nonce?: unknown }).nonce !== "string" ||
      (parsed as { nonce: string }).nonce.length === 0
    ) {
      throw new Error(`corrupt commit lock for run "${runId}"`);
    }
    return parsed as CommitLockRecord;
  }

  private async reclaimCommitLock(
    runDir: string,
    lockFile: string,
    runId: string,
    observed: CommitLockRecord,
  ): Promise<CommitLockRecord | null> {
    if (
      !(await this.acquireCommitLockReclaimGuard(
        runDir,
        runId,
        observed.nonce,
      ))
    ) {
      return null;
    }
    await this.afterCommitReclaimPhase(runId, "before-lock-replace");
    const current = await this.readCommitLock(lockFile, runId);
    if (
      !current ||
      !isDeepStrictEqual(current, observed) ||
      this.isPidAlive(current.pid)
    ) {
      return null;
    }
    const replacement = this.nextCommitLockRecord();
    await this.replaceCommitLock(runDir, lockFile, replacement);
    return replacement;
  }

  private async acquireCommitLockReclaimGuard(
    runDir: string,
    runId: string,
    nonce: string,
  ): Promise<boolean> {
    const record: CommitLockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      nonce,
    };
    for (
      let attempt = 0;
      attempt < COMMIT_LOCK_RECLAIM_GUARD_ATTEMPTS;
      attempt++
    ) {
      const guards = await this.readCommitLockReclaimGuards(
        runDir,
        runId,
        nonce,
      );
      const highest = guards.at(-1);
      if (
        highest &&
        (highest.record.pid === process.pid ||
          this.isPidAlive(highest.record.pid))
      ) {
        return false;
      }
      if (highest) {
        await this.afterCommitReclaimPhase(runId, "after-dead-guard-read");
      }
      const ordinal = highest ? highest.ordinal + 1 : 0;
      if (!Number.isSafeInteger(ordinal)) {
        throw new Error(
          `corrupt commit lock reclaim guard ordinal for run "${runId}"`,
        );
      }
      const guardFile = join(
        runDir,
        `commit.lock.reclaim.${nonce}.ord-${ordinal}`,
      );
      if (
        await this.installCommitLockRecord(
          runDir,
          guardFile,
          runId,
          "reclaim-guard",
          record,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private async readCommitLockReclaimGuards(
    runDir: string,
    runId: string,
    nonce: string,
  ): Promise<Array<{ ordinal: number; record: CommitLockRecord }>> {
    const guards: Array<{
      ordinal: number;
      record: CommitLockRecord;
    }> = [];
    const prefix = `commit.lock.reclaim.${nonce}.ord-`;
    for (const name of await readdir(runDir)) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^(?:0|[1-9]\d*)$/.test(suffix)) {
        throw new Error(
          `corrupt commit lock reclaim guard ordinal for run "${runId}"`,
        );
      }
      const ordinal = Number(suffix);
      if (!Number.isSafeInteger(ordinal)) {
        throw new Error(
          `corrupt commit lock reclaim guard ordinal for run "${runId}"`,
        );
      }
      const record = await this.readCommitLock(join(runDir, name), runId);
      if (!record || record.nonce !== nonce) {
        throw new Error(`corrupt commit lock reclaim guard for run "${runId}"`);
      }
      guards.push({ ordinal, record });
    }
    guards.sort((left, right) => left.ordinal - right.ordinal);
    return guards;
  }

  private async replaceCommitLock(
    runDir: string,
    lockFile: string,
    record: CommitLockRecord,
  ): Promise<void> {
    const temp = join(
      runDir,
      `.${COMMIT_LOCK_FILE}.tmp-${process.pid}-${++commitLockSequence}`,
    );
    let handle: FileHandle | undefined;
    let replaced = false;
    try {
      handle = await open(temp, "wx");
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, lockFile);
      replaced = true;
      await this.syncDirectory(runDir);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      if (replaced) await unlink(lockFile).catch(() => {});
      throw error;
    }
  }

  protected async releaseCommitLock(
    runDir: string,
    ownedNonce: string,
  ): Promise<void> {
    const lockFile = join(runDir, COMMIT_LOCK_FILE);
    const current = await this.readCommitLock(lockFile, basename(runDir));
    if (!current || current.nonce !== ownedNonce) return;
    try {
      await unlink(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
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

  /** Test seam for deterministically interleaving commit-lock holders. */
  protected async afterCommitLockPhase(
    _runId: string,
    _phase: "acquired" | "before-release",
  ): Promise<void> {}

  /** Test seam for observing a durable temp before its atomic hardlink. */
  protected async afterCommitLockTempPhase(
    _runId: string,
    _target: "lock" | "reclaim-guard",
  ): Promise<void> {}

  /** Test seam after a commit captures its stable replay. */
  protected async afterStableReplayPhase(_runId: string): Promise<void> {}

  /** Test seam for deterministically interleaving commit-lock reclaimers. */
  protected async afterCommitReclaimPhase(
    _runId: string,
    _phase: "after-dead-guard-read" | "before-lock-replace",
  ): Promise<void> {}

  /** Test seam for deterministically interleaving controller takeovers. */
  protected async afterControllerTakeoverPhase(
    _runId: string,
    _phase: "after-dead-marker-read" | "before-lock-replace",
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
