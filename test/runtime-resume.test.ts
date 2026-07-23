import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClock,
  FakeHerdrAdapter,
} from "../src/herdr/fake-adapter.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import {
  InMemoryLedger,
  type LeaseHandle,
  type Ledger,
} from "../src/runtime/ledger.ts";
import type { RunView } from "../src/runtime/reducer.ts";
import {
  PartialDispatchError,
  WorkflowRuntime,
} from "../src/runtime/runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempWork(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-resume-"));
  roots.push(root);
  return root;
}

class RejectDispatchedLedger extends InMemoryLedger {
  protected override beforeCommit(event: RunEvent): void {
    if (event.type === "lane_dispatched") {
      throw new Error("injected lane_dispatched failure");
    }
  }
}

class ObservedLedger implements Ledger {
  readonly committedTypes: RunEvent["type"][] = [];
  readonly committedEvents: RunEvent[] = [];
  leaseAcquisitions = 0;

  constructor(private readonly delegate = new InMemoryLedger()) {}

  async commit(event: RunEvent): Promise<void> {
    await this.delegate.commit(event);
    this.committedTypes.push(event.type);
    this.committedEvents.push(structuredClone(event));
  }

  load(runId: string): Promise<RunView | null> {
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    this.leaseAcquisitions++;
    return this.delegate.acquireLease(runId, controller);
  }
}

class LeaseFreeLedger implements Ledger {
  constructor(private readonly delegate: Ledger) {}

  commit(event: RunEvent): Promise<void> {
    return this.delegate.commit(event);
  }

  load(runId: string): Promise<RunView | null> {
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  async acquireLease(): Promise<LeaseHandle> {
    return { release: async () => {} };
  }
}

class FinishBetweenLoadsLedger implements Ledger {
  readonly committedTypes: RunEvent["type"][] = [];
  private loadCount = 0;
  private leaseHeld = false;

  constructor(
    private readonly firstView: RunView,
    private readonly delegate: Ledger,
  ) {}

  async commit(event: RunEvent): Promise<void> {
    await this.delegate.commit(event);
    this.committedTypes.push(event.type);
  }

  load(runId: string): Promise<RunView | null> {
    if (this.loadCount++ === 0) {
      return Promise.resolve(structuredClone(this.firstView));
    }
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  async acquireLease(
    _runId: string,
    _controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    if (this.leaseHeld) throw new Error("test lease already held");
    this.leaseHeld = true;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.leaseHeld = false;
      },
    };
  }
}

describe("WorkflowRuntime resume", () => {
  test("reconciles a human-owned live lane without automatically driving it", async () => {
    const cwd = await tempWork();
    const clock = createClock(5_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "owned", exitCode: 0 },
        { laneId: "managed", exitCode: 0 },
      ],
    });
    const ledger = new ObservedLedger();
    const deps = () => ({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-human-owned",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const dispatch = new WorkflowRuntime(deps());
    const handle = await dispatch.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "owned", steps: 1 },
        { laneId: "managed", steps: 1 },
      ],
    });
    for (const laneId of handle.laneIds) {
      await dispatch.confirmLaneStarted(handle.runId, laneId);
    }
    const ownedPaneId = adapter.paneIdForLane("owned")!;
    const managedPaneId = adapter.paneIdForLane("managed")!;
    await adapter.waitForOutput({ id: managedPaneId }, "ignored", 1);
    await dispatch.takeoverLane(handle.runId, "owned");
    const piBefore = adapter.processInfoPaneIds.length;

    const status = await new WorkflowRuntime(deps()).resumeWorkflow(
      handle.runId,
      1_000,
    );
    const loaded = await ledger.load(handle.runId);

    expect(status.state).toBe("running");
    expect(loaded).toMatchObject({
      finishStatus: null,
      lanes: {
        managed: { runtimeState: "exited" },
        owned: {
          runtimeState: "running",
          controlMode: "human_owned",
        },
      },
    });
    expect(loaded!.lanes["owned"]!.liveAt).not.toBeNull();
    expect(adapter.processInfoPaneIds.slice(piBefore)).toContain(ownedPaneId);
    expect(adapter.waitedPaneIds).not.toContain(ownedPaneId);
    expect(adapter.interruptedPaneIds).not.toContain(ownedPaneId);
  });

  test("release survives controller loss and restores managed automatic drive", async () => {
    const cwd = await tempWork();
    const clock = createClock(7_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "owned", exitCode: 0 }],
    });
    const ledger = new ObservedLedger();
    const deps = () => ({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-release-owned",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const dispatch = new WorkflowRuntime(deps());
    const handle = await dispatch.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "owned", steps: 1 }],
    });
    await dispatch.confirmLaneStarted(handle.runId, "owned");
    const ownedPaneId = adapter.paneIdForLane("owned")!;
    await dispatch.takeoverLane(handle.runId, "owned");
    await new WorkflowRuntime(deps()).resumeWorkflow(handle.runId, 1_000);

    await new WorkflowRuntime(deps()).releaseLane(handle.runId, "owned");
    const status = await new WorkflowRuntime(deps()).resumeWorkflow(
      handle.runId,
      1_000,
    );
    const reloaded = await ledger.load(handle.runId);

    expect(status.state).toBe("complete");
    expect(adapter.waitedPaneIds).toContain(ownedPaneId);
    expect(reloaded).toMatchObject({
      finishStatus: "clean",
      lanes: {
        owned: {
          runtimeState: "exited",
          controlMode: "managed",
        },
      },
    });
  });

  test("ownership flips are idempotent, lease-free, and fail loudly for invalid targets", async () => {
    const cwd = await tempWork();
    const clock = createClock(9_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "owned", exitCode: 0 },
        { laneId: "managed", exitCode: 0 },
      ],
    });
    const ledger = new ObservedLedger();
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-ownership-idempotency",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "owned", steps: 1 },
        { laneId: "managed", steps: 1 },
      ],
    });
    const leaseAcquisitions = ledger.leaseAcquisitions;

    await runtime.takeoverLane(handle.runId, "owned");
    await runtime.takeoverLane(handle.runId, "owned");
    await runtime.releaseLane(handle.runId, "managed");

    expect(
      ledger.committedTypes.filter((type) => type === "lane_takeover"),
    ).toHaveLength(1);
    expect(
      ledger.committedTypes.filter((type) => type === "lane_release"),
    ).toHaveLength(0);
    expect(ledger.leaseAcquisitions).toBe(leaseAcquisitions);
    await expect(runtime.takeoverLane("missing", "owned")).rejects.toThrow(
      'run not found: "missing"',
    );
    await expect(
      runtime.takeoverLane(handle.runId, "unknown"),
    ).rejects.toThrow(
      `unknown laneId "unknown" in run "${handle.runId}"`,
    );
  });

  test("reconciles the unobserved window, reattaches live lanes, and finishes runtime outcomes", async () => {
    const cwd = await tempWork();
    const clock = createClock(10_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "alive", exitCode: 0 },
        { laneId: "exited", exitCode: 130 },
        {
          laneId: "crashed",
          exitCode: 1,
          emitSentinel: false,
          waitMatches: true,
        },
        {
          laneId: "output-only",
          exitCode: 1,
          emitSentinel: false,
          waitMatches: true,
          extraOutput: ["lane began executing"],
        },
        {
          laneId: "lost",
          exitCode: 1,
          emitSentinel: false,
          waitMatches: true,
        },
      ],
    });
    const ledger = new ObservedLedger();
    const deps = () => ({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-resume",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const dispatch = new WorkflowRuntime(deps());
    const handle = await dispatch.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "alive", steps: 1 },
        { laneId: "exited", steps: 1 },
        { laneId: "crashed", steps: 1 },
        { laneId: "output-only", steps: 1 },
        { laneId: "lost", steps: 1 },
      ],
    });
    for (const laneId of ["alive", "exited", "crashed"]) {
      await dispatch.confirmLaneStarted(handle.runId, laneId);
    }
    for (const laneId of ["exited", "crashed", "output-only", "lost"]) {
      await adapter.waitForOutput(
        { id: adapter.paneIdForLane(laneId)! },
        "ignored",
        1,
      );
    }

    const resumed = new WorkflowRuntime(deps());
    const status = await resumed.resumeWorkflow(handle.runId, 1_000);
    const loaded = await ledger.load(handle.runId);

    expect(status).toMatchObject({
      state: "partial",
      lanes: [
        { laneId: "alive", state: "complete", exitCode: 0 },
        { laneId: "exited", state: "interrupted", exitCode: 130 },
        { laneId: "crashed", state: "failed", exitCode: null },
        { laneId: "output-only", state: "failed", exitCode: null },
        { laneId: "lost", state: "failed", exitCode: null },
      ],
    });
    expect(loaded).toMatchObject({
      controllerEpoch: 1,
      controller: { controllerId: `runtime-${process.pid}`, pid: process.pid },
      finishStatus: "degraded",
      breakdown: {
        exitedZero: 1,
        exitedNonZero: 1,
        crashed: 2,
        lost: 1,
        failedToStart: 0,
      },
    });
    expect(loaded!.lanes["crashed"]).toMatchObject({
      runtimeState: "crashed",
      semanticState: "unknown",
      contractState: "violated",
      verificationState: "failed",
    });
    expect(loaded!.lanes["exited"]).toMatchObject({
      runtimeState: "exited",
      exitCode: 130,
      signal: "SIGINT",
    });
    expect(loaded!.lanes["lost"]).toMatchObject({
      runtimeState: "lost",
      lostCause: "dispatch-outcome-unknown",
      semanticState: "unknown",
      contractState: "violated",
      verificationState: "failed",
    });
    expect(loaded!.lanes["output-only"]).toMatchObject({
      runtimeState: "crashed",
      liveAt: null,
    });
    const attachedIndex = ledger.committedEvents.findIndex(
      (event) => event.type === "controller_attached",
    );
    expect(ledger.committedEvents[attachedIndex]).toMatchObject({
      controllerEpoch: 0,
      data: { epoch: 1 },
    });
    expect(
      ledger.committedEvents
        .slice(attachedIndex + 1)
        .every((event) => event.controllerEpoch === 1),
    ).toBe(true);
  });

  test("recovers an intent-only live lane without fabricating its dispatch command", async () => {
    const cwd = await tempWork();
    const clock = createClock(20_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "uncertain", exitCode: 0 }],
    });
    const ledger = new RejectDispatchedLedger();
    const deps = () => ({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-uncertain",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const dispatch = new WorkflowRuntime(deps());

    await expect(
      dispatch.startWorkflow({
        workflow: "cross-review",
        workspace: "w1",
        cwd,
        lanes: [{ laneId: "uncertain", steps: 1 }],
      }),
    ).rejects.toBeInstanceOf(PartialDispatchError);

    const status = await new WorkflowRuntime(deps()).resumeWorkflow(
      "run-uncertain",
      1_000,
    );
    const loaded = await ledger.load("run-uncertain");

    expect(status).toMatchObject({
      state: "complete",
      lanes: [{ laneId: "uncertain", state: "complete", exitCode: 0 }],
    });
    expect(loaded).toMatchObject({
      finishStatus: "clean",
      breakdown: {
        exitedZero: 1,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    });
    expect(loaded!.lanes["uncertain"]).toMatchObject({
      runtimeState: "exited",
      dispatchIntentAt: 20_000,
      dispatchedAt: null,
      dispatchedCommand: null,
      verificationState: "failed",
    });
  });

  test("reports a finished run without acquiring a lease or appending an event", async () => {
    const cwd = await tempWork();
    const clock = createClock(30_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "done", exitCode: 0 }],
    });
    const ledger = new ObservedLedger();
    const deps = () => ({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-done",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const source = new WorkflowRuntime(deps());
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "done", steps: 1 }],
    });
    await source.confirmLaneStarted(handle.runId, "done");
    await source.awaitLane(handle.runId, "done", 1_000);
    const eventCount = ledger.committedTypes.length;
    const leaseAcquisitions = ledger.leaseAcquisitions;

    const status = await new WorkflowRuntime(deps()).resumeWorkflow(handle.runId);

    expect(status.state).toBe("complete");
    expect(ledger.committedTypes).toHaveLength(eventCount);
    expect(ledger.leaseAcquisitions).toBe(leaseAcquisitions);
  });

  test("reports read-only when the run finishes before the authoritative reload", async () => {
    const cwd = await tempWork();
    const clock = createClock(35_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "done", exitCode: 0 }],
    });
    const sourceLedger = new ObservedLedger();
    const source = new WorkflowRuntime({
      adapter,
      ledger: sourceLedger,
      clock: clock.now,
      idgen: () => "run-finished-during-acquire",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "done", steps: 1 }],
    });
    const unfinished = await sourceLedger.load(handle.runId);
    await source.confirmLaneStarted(handle.runId, "done");
    await source.awaitLane(handle.runId, "done", 1_000);
    const eventCount = sourceLedger.committedEvents.length;
    const racingLedger = new FinishBetweenLoadsLedger(
      unfinished!,
      sourceLedger,
    );
    const resumed = new WorkflowRuntime({
      adapter,
      ledger: racingLedger,
      clock: clock.now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    const status = await resumed.resumeWorkflow(handle.runId);

    expect(status.state).toBe("complete");
    expect(racingLedger.committedTypes).toEqual([]);
    expect(sourceLedger.committedEvents).toHaveLength(eventCount);
    const reacquired = await racingLedger.acquireLease(
      handle.runId,
      { controllerId: "next-controller", pid: process.pid },
    );
    await expect(reacquired.release()).resolves.toBeUndefined();
  });

  test("fails before lease acquisition when the run does not exist", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({ clock });
    const ledger = new ObservedLedger();
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(runtime.resumeWorkflow("missing")).rejects.toThrow(
      'run not found: "missing"',
    );
    expect(ledger.leaseAcquisitions).toBe(0);
  });

  test("refuses resume while the durable controller lease holder is alive", async () => {
    const root = await tempWork();
    const clock = createClock(40_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "live", exitCode: 0 }],
    });
    const sourceLedger = new FsLedger(join(root, "ledger"), () => true);
    const source = new WorkflowRuntime({
      adapter,
      ledger: sourceLedger,
      clock: clock.now,
      idgen: () => "run-live-controller",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd: join(root, "work"),
      lanes: [{ laneId: "live", steps: 1 }],
    });
    const resumeLedger = new FsLedger(join(root, "ledger"), () => true);
    const resumed = new WorkflowRuntime({
      adapter,
      ledger: resumeLedger,
      clock: clock.now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      resumed.resumeWorkflow("run-live-controller"),
    ).rejects.toThrow(
      'controller lease for run "run-live-controller" is already held',
    );
    expect(
      (await resumeLedger.load("run-live-controller"))!.controllerEpoch,
    ).toBe(0);
  });

  test("rejects when a reattached live lane does not terminate before timeout", async () => {
    const root = await tempWork();
    const clock = createClock(50_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "slow-lane",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
      ],
    });
    const ledger = new LeaseFreeLedger(
      new FsLedger(join(root, "ledger")),
    );
    const deps = () => ({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-resume-timeout",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    await new WorkflowRuntime(deps()).startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd: join(root, "work"),
      lanes: [{ laneId: "slow-lane", steps: 1 }],
    });

    await expect(
      new WorkflowRuntime(deps()).resumeWorkflow("run-resume-timeout", 1),
    ).rejects.toThrow(/did not terminate.*slow-lane/);
    expect(await ledger.load("run-resume-timeout")).toMatchObject({
      controllerEpoch: 1,
      finishStatus: null,
      lanes: {
        "slow-lane": {
          runtimeState: "running",
          liveAt: 50_000,
        },
      },
    });
  });

  test("releases its durable controller lease after a resume failure", async () => {
    const root = await tempWork();
    const clock = createClock(60_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "slow-lane",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
      ],
    });
    const durableLedger = new FsLedger(
      join(root, "ledger"),
      (pid) => pid === process.pid,
    );
    const source = new WorkflowRuntime({
      adapter,
      ledger: new LeaseFreeLedger(durableLedger),
      clock: clock.now,
      idgen: () => "run-release-after-failure",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd: join(root, "work"),
      lanes: [{ laneId: "slow-lane", steps: 1 }],
    });
    const resumed = new WorkflowRuntime({
      adapter,
      ledger: durableLedger,
      clock: clock.now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      resumed.resumeWorkflow("run-release-after-failure", 1),
    ).rejects.toThrow(/did not terminate.*slow-lane/);
    const reacquired = await durableLedger.acquireLease(
      "run-release-after-failure",
      { controllerId: "next-controller", pid: process.pid },
    );
    await expect(reacquired.release()).resolves.toBeUndefined();
  });
});
