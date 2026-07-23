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
import type { LeaseHandle } from "../src/runtime/ledger.ts";
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

type ControllerTakeoverPhase =
  | "after-dead-marker-read"
  | "before-lock-replace";

class PausingTakeoverLedger extends FsLedger {
  private resolveReached!: () => void;
  private resumeTakeover!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.resolveReached = resolve;
  });
  private readonly takeoverResumed = new Promise<void>((resolve) => {
    this.resumeTakeover = resolve;
  });
  private paused = false;

  constructor(
    root: string,
    isPidAlive: (pid: number) => boolean,
    private readonly pauseAt: ControllerTakeoverPhase,
  ) {
    super(root, isPidAlive);
  }

  protected override async afterControllerTakeoverPhase(
    _runId: string,
    phase: ControllerTakeoverPhase,
  ): Promise<void> {
    if (this.paused || phase !== this.pauseAt) return;
    this.paused = true;
    this.resolveReached();
    await this.takeoverResumed;
  }

  resume(): void {
    this.resumeTakeover();
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
    const ledger = new FsLedger(await tempRoot(), () => true);
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

  test("takes over a dead holder with an epoch bump and then refuses a live holder", async () => {
    const root = await tempRoot();
    const firstLedger = new FsLedger(root, () => false);
    await firstLedger.acquireLease("run-fs", {
      controllerId: "controller-1",
      pid: 101,
    });
    const takeoverLedger = new FsLedger(root, (pid) => pid === 202);
    const takeover = await takeoverLedger.acquireLease("run-fs", {
      controllerId: "controller-2",
      pid: 202,
    });

    expect(
      JSON.parse(
        await readFile(
          join(root, "runs", "run-fs", "controller.lock"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      controllerId: "controller-2",
      pid: 202,
      epoch: 1,
    });
    await expect(
      takeoverLedger.acquireLease("run-fs", {
        controllerId: "controller-3",
        pid: 303,
      }),
    ).rejects.toThrow('controller lease for run "run-fs" is already held');
    await takeover.release();
  });

  test("admits exactly one concurrent takeover of the same dead holder", async () => {
    const root = await tempRoot();
    await new FsLedger(root, () => false).acquireLease("run-fs", {
      controllerId: "dead-controller",
      pid: 101,
    });
    const contenders = [
      { controllerId: "controller-2", pid: 202 },
      { controllerId: "controller-3", pid: 303 },
    ] as const;

    const results = await Promise.allSettled(
      contenders.map((controller) =>
        new FsLedger(root, (pid) => pid !== 101).acquireLease(
          "run-fs",
          controller,
        ),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    const winner = JSON.parse(
      await readFile(
        join(root, "runs", "run-fs", "controller.lock"),
        "utf8",
      ),
    ) as { pid: number };
    await expect(
      new FsLedger(root, (pid) => pid === winner.pid).acquireLease("run-fs", {
        controllerId: "controller-4",
        pid: 404,
      }),
    ).rejects.toThrow('controller lease for run "run-fs" is already held');
    const winningResult = results.find(
      (result): result is PromiseFulfilledResult<LeaseHandle> =>
        result.status === "fulfilled",
    );
    await winningResult!.value.release();
  });

  test("the fulfilled takeover owns the final lock across a distinct-pid ABA interleave", async () => {
    const root = await tempRoot();
    await new FsLedger(root, () => false).acquireLease("run-fs", {
      controllerId: "dead-controller",
      pid: 100,
    });
    const runDir = join(root, "runs", "run-fs");
    const deadMarker = `${JSON.stringify({
      schemaVersion: 1,
      pid: 400,
    })}\n`;
    await writeFile(
      join(runDir, ".controller.takeover.epoch-0"),
      deadMarker,
      "utf8",
    );
    const isPidAlive = (pid: number) => pid === 200 || pid === 300;
    const contenderB = new PausingTakeoverLedger(
      root,
      isPidAlive,
      "after-dead-marker-read",
    );
    const contenderC = new PausingTakeoverLedger(
      root,
      isPidAlive,
      "before-lock-replace",
    );
    const controllers = [
      { controllerId: "controller-b", pid: 200 },
      { controllerId: "controller-c", pid: 300 },
    ] as const;

    const resultB = contenderB.acquireLease("run-fs", controllers[0]);
    await contenderB.reached;
    const resultC = contenderC.acquireLease("run-fs", controllers[1]);
    await contenderC.reached;
    contenderB.resume();
    await resultB.catch(() => {});
    contenderC.resume();
    const results = await Promise.allSettled([resultB, resultC]);

    const winners = results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? [{ controller: controllers[index]!, handle: result.value }]
        : [],
    );
    expect(winners).toHaveLength(1);
    const finalLock = JSON.parse(
      await readFile(join(runDir, "controller.lock"), "utf8"),
    ) as { controllerId: string };
    expect(finalLock.controllerId).toBe(winners[0]!.controller.controllerId);
    await winners[0]!.handle.release();
  });

  test("reclaims a dead takeover marker and completes the dead-holder takeover", async () => {
    const root = await tempRoot();
    await new FsLedger(root, () => false).acquireLease("run-fs", {
      controllerId: "dead-controller",
      pid: 101,
    });
    const runDir = join(root, "runs", "run-fs");
    await writeFile(
      join(runDir, ".controller.takeover.epoch-0"),
      `${JSON.stringify({ schemaVersion: 1, pid: 102 })}\n`,
      "utf8",
    );

    const takeover = await new FsLedger(root, () => false).acquireLease(
      "run-fs",
      { controllerId: "controller-2", pid: 202 },
    );

    expect(
      JSON.parse(await readFile(join(runDir, "controller.lock"), "utf8")),
    ).toMatchObject({
      controllerId: "controller-2",
      pid: 202,
      epoch: 1,
    });
    await expect(takeover.release()).resolves.toBeUndefined();
  });

  test("advances beyond accumulated dead reclaim guards", async () => {
    const root = await tempRoot();
    await new FsLedger(root, () => false).acquireLease("run-fs", {
      controllerId: "dead-controller",
      pid: 100,
    });
    const runDir = join(root, "runs", "run-fs");
    await writeFile(
      join(runDir, ".controller.takeover.epoch-0"),
      `${JSON.stringify({ schemaVersion: 1, pid: 101 })}\n`,
      "utf8",
    );
    for (let ordinal = 0; ordinal <= 3; ordinal++) {
      await writeFile(
        join(
          runDir,
          `.controller.takeover.epoch-0.reclaim-${ordinal}`,
        ),
        `${JSON.stringify({ schemaVersion: 1, pid: 110 + ordinal })}\n`,
        "utf8",
      );
    }

    const takeover = await new FsLedger(
      root,
      (pid) => pid === 200,
    ).acquireLease("run-fs", {
      controllerId: "fresh-controller",
      pid: 200,
    });

    expect(
      JSON.parse(await readFile(join(runDir, "controller.lock"), "utf8")),
    ).toMatchObject({
      controllerId: "fresh-controller",
      pid: 200,
      epoch: 1,
    });
    await expect(takeover.release()).resolves.toBeUndefined();
  });

  test("refuses takeover while the existing takeover marker holder is alive", async () => {
    const root = await tempRoot();
    await new FsLedger(root, () => false).acquireLease("run-fs", {
      controllerId: "dead-controller",
      pid: 101,
    });
    const runDir = join(root, "runs", "run-fs");
    const claim = `${JSON.stringify({ schemaVersion: 1, pid: 102 })}\n`;
    await writeFile(
      join(runDir, ".controller.takeover.epoch-0"),
      claim,
      "utf8",
    );

    await expect(
      new FsLedger(root, (pid) => pid === 102).acquireLease("run-fs", {
        controllerId: "controller-2",
        pid: 202,
      }),
    ).rejects.toThrow('controller lease for run "run-fs" is already held');
    expect(
      await readFile(
        join(runDir, ".controller.takeover.epoch-0"),
        "utf8",
      ),
    ).toBe(claim);
  });

  test("fails closed on a corrupt takeover marker", async () => {
    const root = await tempRoot();
    await new FsLedger(root, () => false).acquireLease("run-fs", {
      controllerId: "dead-controller",
      pid: 101,
    });
    const runDir = join(root, "runs", "run-fs");
    await writeFile(
      join(runDir, ".controller.takeover.epoch-0"),
      "{corrupt",
      "utf8",
    );

    await expect(
      new FsLedger(root, () => false).acquireLease("run-fs", {
        controllerId: "controller-2",
        pid: 202,
      }),
    ).rejects.toThrow(/corrupt controller takeover marker/);
    expect(
      await readFile(
        join(runDir, ".controller.takeover.epoch-0"),
        "utf8",
      ),
    ).toBe("{corrupt");
  });

  test("fails closed on a corrupt existing controller lock", async () => {
    const root = await tempRoot();
    const runDir = join(root, "runs", "run-fs");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "controller.lock"), "{corrupt", "utf8");

    await expect(
      new FsLedger(root, () => false).acquireLease("run-fs", {
        controllerId: "controller-2",
        pid: 202,
      }),
    ).rejects.toThrow(/corrupt controller lease/);
    expect(
      await readFile(join(runDir, "controller.lock"), "utf8"),
    ).toBe("{corrupt");
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
