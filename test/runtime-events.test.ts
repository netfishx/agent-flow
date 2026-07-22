import { describe, expect, test } from "bun:test";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import { InMemoryLedger, type Ledger, type LeaseHandle } from "../src/runtime/ledger.ts";
import type { RunView } from "../src/runtime/reducer.ts";
import { PartialDispatchError } from "../src/runtime/runtime.ts";
import { SmokeRuntime } from "../src/smoke/smoke-runtime.ts";

class InspectableSmokeRuntime extends SmokeRuntime {
  reducedView(runId: string): RunView {
    return this.runView(runId);
  }
}

class RejectingLedger implements Ledger {
  async commit(_event: RunEvent): Promise<void> {
    throw new Error("fake: event append rejected");
  }

  async load(_runId: string): Promise<RunView | null> {
    return null;
  }

  async list(): Promise<{ runId: string }[]> {
    return [];
  }

  async acquireLease(
    _runId: string,
    _controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    return { release: async () => {} };
  }
}

class RecordingLedger implements Ledger {
  readonly events: RunEvent[] = [];
  private readonly delegate = new InMemoryLedger();

  constructor(private readonly rejectedType?: RunEvent["type"]) {}

  async commit(event: RunEvent): Promise<void> {
    if (event.type === this.rejectedType) {
      throw new Error(`fake: ${event.type} append rejected`);
    }
    await this.delegate.commit(event);
    this.events.push(structuredClone(event));
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
    return this.delegate.acquireLease(runId, controller);
  }
}

describe("WorkflowRuntime event commits", () => {
  test("an append rejection leaves the transition externally uncommitted", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({ clock });
    const ledger = new RejectingLedger();
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      runtime.startWorkflow({
        workflow: "wf",
        workspace: "w1",
        cwd: "/tmp/ev",
        lanes: [{ laneId: "lane-1", steps: 1 }],
      }),
    ).rejects.toThrow(/append rejected/);
    await expect(runtime.inspectWorkflow("run1")).rejects.toThrow(/unknown runId/);
    expect(await ledger.load("run1")).toBeNull();
  });

  test("smoke export and attach rebuild the run by committing event history", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const sourceLedger = new InMemoryLedger();
    const makeRuntime = (ledger: Ledger) =>
      new InspectableSmokeRuntime({
        adapter,
        ledger,
        clock: clock.now,
        idgen: () => "run1",
        readResultFile: adapter.readResultFile,
        sleep: async () => {},
      });
    const source = makeRuntime(sourceLedger);
    const handle = await source.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await source.confirmLaneStarted(handle.runId, "lane-1");
    expect(await sourceLedger.load(handle.runId)).toEqual(
      source.reducedView(handle.runId),
    );

    const freshLedger = new InMemoryLedger();
    const fresh = makeRuntime(freshLedger);
    expect(fresh.attachRun(source.exportRun(handle.runId))).toEqual(handle);

    expect(await freshLedger.load(handle.runId)).toEqual(
      await sourceLedger.load(handle.runId),
    );
    expect((await fresh.inspectWorkflow(handle.runId)).lanes[0]!.state).toBe(
      "running",
    );
  });

  test("a rejected lane transition is absent from both live and replayed views", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger("lane_live");
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });

    await expect(
      runtime.confirmLaneStarted(handle.runId, "lane-1"),
    ).rejects.toThrow(/lane_live append rejected/);
    expect((await runtime.inspectLaneResult(handle.runId, "lane-1")).state).toBe(
      "starting",
    );
    expect((await ledger.load(handle.runId))!.lanes["lane-1"]!.runtimeState).toBe(
      "pending",
    );
  });

  test("a synchronous checkpoint surfaces append failure at the next async boundary", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger("checkpoint_announced");
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });

    runtime.markCheckpoint(handle.runId);
    await expect(
      runtime.inspectLaneResult(handle.runId, "lane-1"),
    ).rejects.toThrow(/checkpoint_announced append rejected/);
    expect((await runtime.inspectLaneResult(handle.runId, "lane-1")).state).toBe(
      "starting",
    );
    expect((await ledger.load(handle.runId))!.checkpointAnnouncedAt).toBeNull();
  });

  test("emits deterministic envelopes without consuming extra run ids", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger();
    let idCalls = 0;
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => {
        idCalls++;
        return "run1";
      },
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");
    runtime.markCheckpoint(handle.runId);
    await runtime.interruptLane(handle.runId, "lane-1");
    await runtime.awaitLane(handle.runId, "lane-1", 1000);

    expect(idCalls).toBe(1);
    expect(ledger.events.map((event) => event.type)).toEqual([
      "run_started",
      "lane_registered",
      "lane_dispatched",
      "lane_live",
      "checkpoint_announced",
      "human_interrupt",
      "lane_exited",
      "run_finished",
    ]);
    expect(ledger.events.map((event) => event.eventId)).toEqual(
      ledger.events.map((_, index) => `run1#${index + 1}`),
    );
    expect(
      ledger.events.every(
        (event, index) =>
          event.schemaVersion === 1 &&
          event.sequence === index + 1 &&
          event.controllerEpoch === 0,
      ),
    ).toBe(true);
  });

  test("records a confirmed gone lane without a sentinel as crashed", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0, emitSentinel: false }],
    });
    const ledger = new RecordingLedger();
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");

    await expect(runtime.awaitLane(handle.runId, "lane-1", 1000)).rejects.toThrow(
      /no sentinel/,
    );
    expect(ledger.events.slice(-2).map((event) => event.type)).toEqual([
      "lane_crashed",
      "run_finished",
    ]);
    expect((await ledger.load(handle.runId))!.lanes["lane-1"]!.runtimeState).toBe(
      "crashed",
    );
  });

  test("finishes cleanly and emits nothing for an undelivered interrupt", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger();
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");
    await runtime.awaitLane(handle.runId, "lane-1", 1000);
    expect((await ledger.load(handle.runId))!.finishStatus).toBe("clean");

    const eventCount = ledger.events.length;
    expect((await runtime.interruptLane(handle.runId, "lane-1")).delivered).toBe(
      false,
    );
    expect(ledger.events).toHaveLength(eventCount);
  });

  test("records explicit rejection for the failed dispatch and aborted siblings", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      failRunInPaneAfter: 1,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger();
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      runtime.startWorkflow({
        workflow: "wf",
        workspace: "w1",
        cwd: "/tmp/ev",
        lanes: [
          { laneId: "lane-1", steps: 1 },
          { laneId: "lane-2", steps: 1 },
          { laneId: "lane-3", steps: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(PartialDispatchError);
    expect(
      ledger.events
        .filter((event) => event.type === "lane_failed_to_start")
        .map((event) => [event.laneId, event.data.rejection]),
    ).toEqual([
      ["lane-2", "fake: runInPane failed"],
      ["lane-3", "dispatch aborted after earlier lane failed"],
    ]);
  });
});
