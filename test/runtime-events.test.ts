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

class RejectingInMemoryLedger extends InMemoryLedger {
  protected override beforeCommit(_event: RunEvent): void {
    throw new Error("fake: synchronous smoke append rejected");
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
  private readonly committedEvents: RunEvent[] = [];
  private readonly delegate = new InMemoryLedger();

  constructor(private readonly rejectedType?: RunEvent["type"]) {}

  // Keep the #13 assertions focused on their original envelope vocabulary;
  // #14 fact-event behavior is covered through the public durable ledger seam.
  get events(): RunEvent[] {
    return this.committedEvents
      .filter(
        (event) =>
          event.type !== "lane_checkpoint" &&
          event.type !== "lane_contract_evaluated" &&
          event.type !== "lane_verification_recorded",
      )
      .map((event) => structuredClone(event));
  }

  async commit(event: RunEvent): Promise<void> {
    if (event.type === this.rejectedType) {
      throw new Error(`fake: ${event.type} append rejected`);
    }
    await this.delegate.commit(event);
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

  test("a mid-topology split failure leaves no committed run", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      failSplitPaneAfter: 1,
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
        ],
      }),
    ).rejects.toThrow(/splitPane failed/);
    await expect(runtime.inspectWorkflow("run1")).rejects.toThrow(/unknown runId/);
    expect(await ledger.load("run1")).toBeNull();
    expect(ledger.events).toHaveLength(0);
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
    expect(await fresh.attachRun(await source.exportRun(handle.runId))).toEqual(handle);

    expect(await freshLedger.load(handle.runId)).toEqual(
      await sourceLedger.load(handle.runId),
    );
    expect((await fresh.inspectWorkflow(handle.runId)).lanes[0]!.state).toBe(
      "running",
    );
  });

  test("smoke attach rejects a failed append without registering a live view", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const sourceLedger = new InMemoryLedger();
    const source = new SmokeRuntime({
      adapter,
      ledger: sourceLedger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await source.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });

    const rejectingLedger = new RejectingInMemoryLedger();
    const fresh = new SmokeRuntime({
      adapter,
      ledger: rejectingLedger,
      clock: clock.now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      fresh.attachRun(await source.exportRun(handle.runId)),
    ).rejects.toThrow(/synchronous smoke append rejected/);
    await expect(fresh.inspectWorkflow(handle.runId)).rejects.toThrow(
      /unknown runId/,
    );
    expect(await rejectingLedger.load(handle.runId)).toBeNull();
  });

  test("smoke export refuses a pending checkpoint until an async operation flushes it", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new SmokeRuntime({
      adapter,
      ledger: new InMemoryLedger(),
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
    await expect(runtime.exportRun(handle.runId)).rejects.toThrow(
      /pending transition.*await an async public operation/i,
    );
    await runtime.inspectWorkflow(handle.runId);
    const history = JSON.parse(await runtime.exportRun(handle.runId)) as {
      events: RunEvent[];
    };
    expect(history.events.some((event) => event.type === "checkpoint_announced")).toBe(
      true,
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
      "running",
    );
    expect((await ledger.load(handle.runId))!.lanes["lane-1"]!.runtimeState).toBe(
      "pending",
    );
  });

  test("serializes concurrent lane transitions into consecutive events", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const ledger = new RecordingLedger();
    const runtime = new InspectableSmokeRuntime({
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
      lanes: [
        { laneId: "lane-1", steps: 1 },
        { laneId: "lane-2", steps: 1 },
      ],
    });

    expect(
      await Promise.all(
        handle.laneIds.map((laneId) =>
          runtime.confirmLaneStarted(handle.runId, laneId),
        ),
      ),
    ).toEqual([true, true]);
    const liveEvents = ledger.events.filter((event) => event.type === "lane_live");
    expect(liveEvents.map((event) => event.sequence)).toEqual([6, 7]);
    expect(await ledger.load(handle.runId)).toEqual(
      runtime.reducedView(handle.runId),
    );
  });

  test("deduplicates concurrent live observations for the same lane", async () => {
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

    expect(
      await Promise.all([
        runtime.confirmLaneStarted(handle.runId, "lane-1"),
        runtime.confirmLaneStarted(handle.runId, "lane-1"),
      ]),
    ).toEqual([true, true]);
    expect(
      ledger.events.filter((item) => item.type === "lane_live"),
    ).toHaveLength(1);
  });

  test("deduplicates concurrent terminal observations for the same lane and run", async () => {
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

    const results = await Promise.all([
      runtime.awaitLane(handle.runId, "lane-1", 1_000),
      runtime.awaitLane(handle.runId, "lane-1", 1_000),
    ]);

    expect(results.map((result) => result.state)).toEqual([
      "complete",
      "complete",
    ]);
    expect(
      ledger.events.filter((item) => item.type === "lane_exited"),
    ).toHaveLength(1);
    expect(
      ledger.events.filter((item) => item.type === "run_finished"),
    ).toHaveLength(1);
  });

  test("projects a dispatched pending lane as publicly running", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new SmokeRuntime({
      adapter,
      ledger: new InMemoryLedger(),
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

    expect((await runtime.inspectLaneResult(handle.runId, "lane-1")).state).toBe(
      "running",
    );
  });

  test("measures process startup from before dispatch call latency", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      advances: { runInPane: 10, processInfo: 5 },
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new SmokeRuntime({
      adapter,
      ledger: new InMemoryLedger(),
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

    expect(
      (await runtime.inspectWorkflow(handle.runId)).metrics.perLane["lane-1"]!
        .processStartup,
    ).toEqual({ kind: "measured", ms: 15 });
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
      "running",
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
    expect(ledger.events.map((event) => event.eventId)).toEqual([
      "run1#1",
      "run1#2",
      "run1#3",
      "run1#4",
      "run1#5",
      "run1#6",
      "run1#7",
      "run1#11",
    ]);
    expect(ledger.events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 11,
    ]);
    expect(
      ledger.events.every(
        (event) =>
          event.schemaVersion === 1 &&
          event.eventId === `${event.runId}#${event.sequence}` &&
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

  test("records a gone lane without execution evidence as lost", async () => {
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

    await expect(runtime.awaitLane(handle.runId, "lane-1", 1000)).rejects.toThrow(
      /lost.*dispatch-outcome-unknown/i,
    );
    expect(
      ledger.events.filter((event) => event.type === "lane_lost"),
    ).toHaveLength(1);
    expect(
      ledger.events.filter((event) => event.type === "lane_crashed"),
    ).toHaveLength(0);
    expect((await ledger.load(handle.runId))!.lanes["lane-1"]).toMatchObject({
      runtimeState: "lost",
      lostCause: "dispatch-outcome-unknown",
    });
    expect((await runtime.inspectLaneResult(handle.runId, "lane-1")).state).toBe(
      "failed",
    );
  });

  test("does not record waitMatched when the matched process is still alive", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "lane-1",
          exitCode: 0,
          waitMatches: true,
          staysRunningAfterMatch: true,
        },
      ],
    });
    const runtime = new SmokeRuntime({
      adapter,
      ledger: new InMemoryLedger(),
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      processGoneTimeoutMs: 1,
      processGoneIntervalMs: 1,
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/ev",
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");

    await expect(runtime.awaitLane(handle.runId, "lane-1", 1000)).rejects.toThrow(
      /still running/,
    );
    expect(
      (await runtime.inspectLaneResult(handle.runId, "lane-1")).waitMatched,
    ).toBe(false);
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
    runtime.markCheckpoint(handle.runId);
    await runtime.inspectWorkflow(handle.runId);

    const eventCount = ledger.events.length;
    expect((await runtime.interruptLane(handle.runId, "lane-1")).delivered).toBe(
      false,
    );
    expect(ledger.events).toHaveLength(eventCount);
    expect(ledger.events.some((event) => event.type === "human_interrupt")).toBe(
      false,
    );
    expect(
      (await runtime.inspectWorkflow(handle.runId)).metrics.perLane["lane-1"]!
        .humanCoordination,
    ).toEqual({
      kind: "unavailable",
      reason: "no human checkpoint touched this lane",
    });
  });

  test("wraps a dispatched append rejection with the physically started lane handle", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger("lane_dispatched");
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    let caught: unknown;
    try {
      await runtime.startWorkflow({
        workflow: "wf",
        workspace: "w1",
        cwd: "/tmp/ev",
        lanes: [{ laneId: "lane-1", steps: 1 }],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PartialDispatchError);
    const partial = caught as PartialDispatchError;
    expect(partial.runId).toBe("run1");
    expect(partial.startedLaneIds).toEqual(["lane-1"]);
    expect(partial.cause).toEqual(
      new Error("fake: lane_dispatched append rejected"),
    );
    expect((await runtime.inspectWorkflow("run1")).lanes[0]!.laneId).toBe(
      "lane-1",
    );
    expect((await runtime.interruptLane("run1", "lane-1")).delivered).toBe(
      true,
    );
  });

  test("wraps a sibling rejection append failure without losing earlier lane handles", async () => {
    const clock = createClock();
    const adapter = new FakeHerdrAdapter({
      clock,
      failRunInPaneAfter: 1,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new RecordingLedger("lane_failed_to_start");
    const runtime = new SmokeRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run1",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    let caught: unknown;
    try {
      await runtime.startWorkflow({
        workflow: "wf",
        workspace: "w1",
        cwd: "/tmp/ev",
        lanes: [
          { laneId: "lane-1", steps: 1 },
          { laneId: "lane-2", steps: 1 },
        ],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PartialDispatchError);
    const partial = caught as PartialDispatchError;
    expect(partial.runId).toBe("run1");
    expect(partial.startedLaneIds).toEqual(["lane-1"]);
    expect(partial.cause).toEqual(
      new Error("fake: lane_failed_to_start append rejected"),
    );
    expect((await runtime.inspectWorkflow("run1")).lanes).toHaveLength(2);
    expect((await runtime.interruptLane("run1", "lane-1")).delivered).toBe(
      true,
    );
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
