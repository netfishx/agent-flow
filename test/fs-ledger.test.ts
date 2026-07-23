import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import { reduce } from "../src/runtime/reducer.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-ledger-"));
  roots.push(root);
  return root;
}

function started(runId = "run-fs"): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `${runId}#1`,
    runId,
    sequence: 1,
    type: "run_started",
    at: 10,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      workflow: "cross-review",
      workspace: "w1",
      cwd: "/tmp/work",
      splitDirection: "down",
      tabId: "w1:t1",
      controllerPaneId: "w1:p1",
      fixedPoint: null,
    },
  };
}

function registered(sequence = 2, runId = "run-fs"): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `${runId}#${sequence}`,
    runId,
    laneId: "lane-1",
    sequence,
    type: "lane_registered",
    at: 20,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      laneId: "lane-1",
      paneId: "w1:p2",
      logFile: "/tmp/work/lane.log",
      stderrFile: "/tmp/work/lane.stderr.log",
      sentinelToken: "FLOW_run-fs_LANE_lane-1_EXIT",
      steps: 1,
      stepDelaySeconds: 0,
    },
  };
}

function exited(sequence = 3, exitCode = 0, runId = "run-fs"): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `${runId}#${sequence}`,
    runId,
    laneId: "lane-1",
    sequence,
    type: "lane_exited",
    at: 30,
    actor: "runtime",
    controllerEpoch: 0,
    data: { exitCode, waitMatched: true },
  };
}

function finished(
  sequence: number,
  status: "clean" | "degraded",
  breakdown: {
    exitedZero: number;
    exitedNonZero: number;
    crashed: number;
    lost: number;
    failedToStart: number;
  },
  runId = "run-fs",
): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `${runId}#${sequence}`,
    runId,
    sequence,
    type: "run_finished",
    at: 40,
    actor: "runtime",
    controllerEpoch: 0,
    data: { status, breakdown },
  };
}

async function seedEventFile(root: string, lines: readonly string[]): Promise<void> {
  const runDir = join(root, "runs", "run-fs");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "events.jsonl"), lines.join(""), "utf8");
}

class AmbiguousAppendFailureLedger extends FsLedger {
  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    throw new Error("injected append fsync failure");
  }

  protected override async rollbackAppend(
    _handle: FileHandle,
    _originalSize: number,
  ): Promise<void> {
    throw new Error("injected truncate rollback failure");
  }

  protected override async clearCommitIntent(): Promise<void> {
    throw new Error("injected marker cleanup failure");
  }
}

class IntentWriteFailureLedger extends FsLedger {
  appendAttempted = false;

  protected override async writeCommitIntent(): Promise<void> {
    throw new Error("injected intent fsync failure");
  }

  protected override async appendAndSync(
    _handle: FileHandle,
    _contents: string,
  ): Promise<void> {
    this.appendAttempted = true;
  }
}

class IntentCleanupFailureLedger extends FsLedger {
  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    throw new Error("injected append fsync failure");
  }

  protected override async clearCommitIntent(): Promise<void> {
    throw new Error("injected marker cleanup failure");
  }
}

class SnapshotWriteFailureLedger extends FsLedger {
  protected override async writeSnapshotFile(
    path: string,
    _contents: string,
  ): Promise<void> {
    await writeFile(path, "partial snapshot", "utf8");
    throw new Error("injected snapshot write failure");
  }
}

class BlockingAppendLedger extends FsLedger {
  private resolveExposed!: () => void;
  private releaseAppend!: () => void;
  readonly exposed = new Promise<void>((resolve) => {
    this.resolveExposed = resolve;
  });
  private readonly appendRelease = new Promise<void>((resolve) => {
    this.releaseAppend = resolve;
  });

  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    this.resolveExposed();
    await this.appendRelease;
    await handle.sync();
  }

  release(): void {
    this.releaseAppend();
  }
}

class RollbackAfterReplayLedger extends FsLedger {
  private resolveExposed!: () => void;
  private allowRollback!: () => void;
  readonly exposed = new Promise<void>((resolve) => {
    this.resolveExposed = resolve;
  });
  private readonly rollbackAllowed = new Promise<void>((resolve) => {
    this.allowRollback = resolve;
  });

  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    this.resolveExposed();
    await this.rollbackAllowed;
    throw new Error("injected append failure after reader replay");
  }

  finishRejectedAppend(): void {
    this.allowRollback();
  }
}

class InterleavedReaderLedger extends FsLedger {
  private beforeReplaySeen = false;

  constructor(
    root: string,
    private readonly beforeReplay: () => Promise<void>,
    private readonly afterReplay: () => Promise<void> = async () => {},
  ) {
    super(root);
  }

  protected override async afterStableReadPhase(
    _runId: string,
    phase: "before-replay" | "after-replay",
  ): Promise<void> {
    if (phase === "before-replay" && !this.beforeReplaySeen) {
      this.beforeReplaySeen = true;
      await this.beforeReplay();
    }
    if (phase === "after-replay") await this.afterReplay();
  }
}

describe("FsLedger public capabilities", () => {
  test("append, load, and list round-trip through the shared reducer", async () => {
    const ledger = new FsLedger(await tempRoot());
    const event = started();

    await ledger.commit(event);

    expect(await ledger.load(event.runId)).toEqual(reduce(undefined, event));
    expect(await ledger.list()).toEqual([{ runId: event.runId }]);
  });

  test("silently deduplicates an identical event and rejects an id conflict", async () => {
    const ledger = new FsLedger(await tempRoot());
    const event = started();
    await ledger.commit(event);

    await expect(ledger.commit(structuredClone(event))).resolves.toBeUndefined();
    expect((await ledger.load(event.runId))!.lastAppliedSequence).toBe(1);

    await expect(
      ledger.commit({ ...event, at: event.at + 1 }),
    ).rejects.toThrow(/different payload/);
    expect((await ledger.load(event.runId))!.updatedAt).toBe(event.at);
  });

  test("fails closed when replay encounters a sequence gap", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      `${JSON.stringify(registered(3))}\n`,
    ]);

    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(/sequence 3/);
  });

  test("commit rejects run_finished unless lanes, terminality, breakdown, and status agree", async () => {
    const root = await tempRoot();

    const zeroLane = new FsLedger(root);
    await zeroLane.commit(started("zero-lane"));
    await expect(
      zeroLane.commit(
        finished(2, "clean", {
          exitedZero: 0,
          exitedNonZero: 0,
          crashed: 0,
          lost: 0,
          failedToStart: 0,
        }, "zero-lane"),
      ),
    ).rejects.toThrow(/at least one lane/);

    const pending = new FsLedger(root);
    await pending.commit(started("pending-run"));
    await pending.commit(registered(2, "pending-run"));
    await expect(
      pending.commit(
        finished(3, "degraded", {
          exitedZero: 0,
          exitedNonZero: 0,
          crashed: 0,
          lost: 0,
          failedToStart: 0,
        }, "pending-run"),
      ),
    ).rejects.toThrow(/runtime-terminal/);

    const wrongBreakdown = new FsLedger(root);
    await wrongBreakdown.commit(started("wrong-breakdown"));
    await wrongBreakdown.commit(registered(2, "wrong-breakdown"));
    await wrongBreakdown.commit(exited(3, 0, "wrong-breakdown"));
    await expect(
      wrongBreakdown.commit(
        finished(4, "clean", {
          exitedZero: 0,
          exitedNonZero: 1,
          crashed: 0,
          lost: 0,
          failedToStart: 0,
        }, "wrong-breakdown"),
      ),
    ).rejects.toThrow(/breakdown/);

    const wrongStatus = new FsLedger(root);
    await wrongStatus.commit(started("wrong-status"));
    await wrongStatus.commit(registered(2, "wrong-status"));
    await wrongStatus.commit(exited(3, 0, "wrong-status"));
    await expect(
      wrongStatus.commit(
        finished(4, "degraded", {
          exitedZero: 1,
          exitedNonZero: 0,
          crashed: 0,
          lost: 0,
          failedToStart: 0,
        }, "wrong-status"),
      ),
    ).rejects.toThrow(/status/);

    const extraBreakdownKey = new FsLedger(root);
    await extraBreakdownKey.commit(started("extra-breakdown-key"));
    await extraBreakdownKey.commit(registered(2, "extra-breakdown-key"));
    await extraBreakdownKey.commit(exited(3, 0, "extra-breakdown-key"));
    const extraKeyEvent = finished(4, "clean", {
      exitedZero: 1,
      exitedNonZero: 0,
      crashed: 0,
      lost: 0,
      failedToStart: 0,
    }, "extra-breakdown-key") as RunEvent & {
      data: { breakdown: Record<string, number> };
    };
    extraKeyEvent.data.breakdown.unexpected = 1;
    await expect(extraBreakdownKey.commit(extraKeyEvent)).rejects.toThrow(
      /breakdown/,
    );
  });

  test("load fails closed on a hand-written illegal run_finished event", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      `${JSON.stringify(registered())}\n`,
      `${JSON.stringify(exited())}\n`,
      `${JSON.stringify(finished(4, "clean", {
        exitedZero: 0,
        exitedNonZero: 1,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      }))}\n`,
    ]);

    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(
      /corrupt event stream.*breakdown/,
    );
  });

  test("fails closed on mid-file corruption and event id conflicts", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      "{not-json}\n",
      `${JSON.stringify(registered())}\n`,
    ]);
    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(
      /corrupt event stream.*line 2/,
    );

    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      `${JSON.stringify({ ...started(), at: 99 })}\n`,
    ]);
    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(
      /conflicting payloads/,
    );
  });

  test("ignores exactly one trailing partial JSON line", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [`${JSON.stringify(started())}\n`, '{"schemaVersion":']);

    expect((await new FsLedger(root).load("run-fs"))!.lastAppliedSequence).toBe(1);
  });

  test("the next commit truncates a tolerated trailing partial line", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [`${JSON.stringify(started())}\n`, '{"schemaVersion":']);
    const ledger = new FsLedger(root);
    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(1);

    await ledger.commit(registered());

    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(2);
  });

  test("replay ignores a missing or torn materialized snapshot", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    await ledger.commit(started());
    const snapshot = join(root, "runs", "run-fs", "run.json");

    await writeFile(snapshot, "{torn", "utf8");
    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(1);
    await unlink(snapshot);
    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(1);
  });

  test("refuses a lease while held and permits reacquire after release", async () => {
    const ledger = new FsLedger(await tempRoot());
    const first = await ledger.acquireLease("run-fs", {
      controllerId: "controller-1",
      pid: 101,
    });

    await expect(
      ledger.acquireLease("run-fs", { controllerId: "controller-2", pid: 202 }),
    ).rejects.toThrow(/already held/);
    await first.release();
    const second = await ledger.acquireLease("run-fs", {
      controllerId: "controller-2",
      pid: 202,
    });
    await expect(second.release()).resolves.toBeUndefined();
  });

  test("load never returns an event exposed inside an active commit", async () => {
    const root = await tempRoot();
    await new FsLedger(root).commit(started());
    const writer = new BlockingAppendLedger(root);
    let commit!: Promise<void>;
    const reader = new InterleavedReaderLedger(root, async () => {
      commit = writer.commit(registered());
      await writer.exposed;
    });

    await expect(reader.load("run-fs")).rejects.toThrow(
      /stable committed view/,
    );
    writer.release();
    await commit;

    expect((await new FsLedger(root).load("run-fs"))!.lastAppliedSequence).toBe(
      2,
    );
  });

  test("load detects marker ABA and never returns a rolled-back event", async () => {
    const root = await tempRoot();
    await new FsLedger(root).commit(started());
    const writer = new RollbackAfterReplayLedger(root);
    let commit!: Promise<void>;
    let commitSettled!: Promise<void>;
    const reader = new InterleavedReaderLedger(
      root,
      async () => {
        commit = writer.commit(registered());
        commitSettled = commit.catch(() => {});
        await writer.exposed;
      },
      async () => {
        writer.finishRejectedAppend();
        await commitSettled;
      },
    );

    const loaded = await reader.load("run-fs");
    await expect(commit).rejects.toThrow(/failure after reader replay/);
    expect(loaded!.lastAppliedSequence).toBe(1);
    expect((await new FsLedger(root).load("run-fs"))!.lastAppliedSequence).toBe(
      1,
    );
  });

  test("a normal commit is loadable through a fresh stable reader", async () => {
    const root = await tempRoot();
    const writer = new FsLedger(root);
    await writer.commit(started());
    await writer.commit(registered());

    expect((await new FsLedger(root).load("run-fs"))!.lastAppliedSequence).toBe(
      2,
    );
  });

  test("write-ahead intent failure forbids the event append", async () => {
    const root = await tempRoot();
    const ledger = new IntentWriteFailureLedger(root);

    await expect(ledger.commit(started())).rejects.toThrow(/intent fsync failure/);
    expect(ledger.appendAttempted).toBe(false);
    await expect(
      readFile(join(root, "runs", "run-fs", "events.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an ambiguous append stays fail-closed across fresh ledger instances", async () => {
    const root = await tempRoot();
    const runDir = join(root, "runs", "run-fs");
    await mkdir(runDir, { recursive: true });
    // Defeats the old best-effort post-failure poison write: open(wx) sees an
    // existing entry while readFile sees ENOENT through the dangling target.
    await symlink(join(root, "missing-poison-target"), join(runDir, "poison.json"));
    const ledger = new AmbiguousAppendFailureLedger(root);

    await expect(ledger.commit(started())).rejects.toThrow(
      /append fsync failure.*truncate rollback failure/,
    );
    const fresh = new FsLedger(root);
    await expect(fresh.load("run-fs")).rejects.toThrow(/ambiguous commit/);
    await expect(fresh.commit(registered())).rejects.toThrow(/ambiguous commit/);

    await expect(ledger.commit(registered())).rejects.toThrow(/ambiguous commit/);
  });

  test("a rejected append remains unreadable when intent cleanup fails", async () => {
    const root = await tempRoot();
    const ledger = new IntentCleanupFailureLedger(root);

    await expect(ledger.commit(started())).rejects.toThrow(
      /append fsync failure.*marker cleanup failure/,
    );
    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(
      /ambiguous commit/,
    );
  });

  test("removes a partially written snapshot temp when its write fails", async () => {
    const root = await tempRoot();
    const ledger = new SnapshotWriteFailureLedger(root);

    await expect(ledger.commit(started())).rejects.toThrow(
      /snapshot write failure/,
    );

    const runDir = join(root, "runs", "run-fs");
    expect((await readdir(runDir)).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
    expect(await ledger.load("run-fs")).toBeNull();
  });
});
