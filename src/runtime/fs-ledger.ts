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
import {
  internalRegisterCommittedEventReader,
  type LeaseHandle,
  type Ledger,
} from "./ledger.ts";
import { reduce, type RunView } from "./reducer.ts";

interface ReplayResult {
  readonly events: readonly RunEvent[];
  readonly byEventId: ReadonlyMap<string, RunEvent>;
  readonly view: RunView | null;
  readonly validByteLength: number;
  readonly needsLeadingNewline: boolean;
}

let snapshotSequence = 0;
const COMMIT_INTENT_FILE = "commit-intent.json";

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
        events: [],
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

  const events: RunEvent[] = [];
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
    events.push(event);
  }
  return {
    events,
    byEventId,
    view: state ?? null,
    validByteLength,
    needsLeadingNewline:
      !ignoredTrailingPartial && contents.length > 0 && !endsWithNewline,
  };
}

export class FsLedger implements Ledger {
  private readonly commitTails = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {
    if (root.length === 0) throw new Error("FsLedger root must not be empty");
    internalRegisterCommittedEventReader(this, async (runId) => {
      assertHandleId("runId", runId);
      await this.assertNoCommitIntent(runId);
      const replayed = await replayFile(join(this.runDir(runId), "events.jsonl"));
      return replayed.events.map((event) => structuredClone(event));
    });
  }

  commit(event: RunEvent): Promise<void> {
    assertHandleId("runId", event.runId);
    const prior = this.commitTails.get(event.runId) ?? Promise.resolve();
    const commit = prior.then(async () => {
      await this.assertNoCommitIntent(event.runId);
      const runDir = this.runDir(event.runId);
      const eventFile = join(runDir, "events.jsonl");
      const replayed = await replayFile(eventFile);
      const duplicate = replayed.byEventId.get(event.eventId);
      if (duplicate) {
        if (isDeepStrictEqual(duplicate, event)) {
          await this.truncateTrailingPartial(eventFile, replayed);
          return;
        }
        throw new Error(
          `eventId "${event.eventId}" already exists with a different payload`,
        );
      }

      const next = reduce(replayed.view ?? undefined, event);
      await mkdir(runDir, { recursive: true });
      const snapshotTemp = await this.writeSnapshotTemp(runDir, next);
      try {
        await this.writeCommitIntent(runDir, {
          eventId: event.eventId,
          lastValidByteLength: replayed.validByteLength,
        });
      } catch (error) {
        await unlink(snapshotTemp).catch(() => {});
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
    await this.assertNoCommitIntent(runId);
    return (await replayFile(join(this.runDir(runId), "events.jsonl"))).view;
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
    let handle;
    try {
      handle = await open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`controller lease for run "${runId}" is already held`);
      }
      throw error;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ ...controller, acquiredAt: Date.now() })}\n`,
        "utf8",
      );
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(lockFile).catch(() => {});
      throw error;
    }
    await handle.close();

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
