import { describe, expect, test } from "bun:test";
import {
  createClock,
  FakeHerdrAdapter,
  type FakeAdvances,
  type FakeLaneProgram,
  type MutableClock,
  scanSingleQuoted,
} from "../src/herdr/fake-adapter.ts";
import { PartialDispatchError } from "../src/runtime/runtime.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import type { LaneSpec, RuntimeDeps } from "../src/runtime/types.ts";
import { SmokeRuntime } from "../src/smoke/smoke-runtime.ts";

interface SetupOptions {
  lanes?: FakeLaneProgram[];
  advances?: FakeAdvances;
  failRunInPane?: boolean;
  failRunInPaneAfter?: number;
  processGoneTimeoutMs?: number;
  processGoneIntervalMs?: number;
  clockStart?: number;
}

function makeRuntime(
  fake: FakeHerdrAdapter,
  clock: MutableClock,
  opts: SetupOptions = {},
): SmokeRuntime {
  let n = 0;
  const deps: RuntimeDeps = {
    adapter: fake,
    ledger: new InMemoryLedger(),
    clock: clock.now,
    idgen: () => `run${++n}`,
    readResultFile: fake.readResultFile,
    sleep: async () => {},
    processGoneTimeoutMs: opts.processGoneTimeoutMs,
    processGoneIntervalMs: opts.processGoneIntervalMs,
  };
  // SmokeRuntime IS-A WorkflowRuntime, so it exercises the same public behavior
  // while also exposing the smoke's export/attach handoff for the tests below.
  return new SmokeRuntime(deps);
}

function setup(opts: SetupOptions = {}) {
  const clock = createClock(opts.clockStart ?? 0);
  const fake = new FakeHerdrAdapter({
    clock,
    lanes: opts.lanes,
    advances: opts.advances,
    failRunInPane: opts.failRunInPane,
    failRunInPaneAfter: opts.failRunInPaneAfter,
  });
  const runtime = makeRuntime(fake, clock, opts);
  return { runtime, fake, clock };
}

function laneSpecs(...ids: string[]): LaneSpec[] {
  return ids.map((laneId) => ({ laneId, steps: 3, stepDelaySeconds: 0.01 }));
}

const config = (lanes: LaneSpec[]) => ({
  workflow: "wf",
  workspace: "w1",
  cwd: "/tmp/ev",
  lanes,
});

async function startAndConfirm(runtime: SmokeRuntime, ids: string[]) {
  const handle = await runtime.startWorkflow(config(laneSpecs(...ids)));
  for (const laneId of handle.laneIds) {
    await runtime.confirmLaneStarted(handle.runId, laneId);
  }
  return handle;
}

describe("workflow creation", () => {
  test("creates a controller and multiple logical lanes", async () => {
    const { runtime } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
        { laneId: "lane-3", exitCode: 0 },
      ],
    });
    const handle = await runtime.startWorkflow(
      config(laneSpecs("lane-1", "lane-2", "lane-3")),
    );
    expect(handle.runId).toBe("run1");
    expect(handle.laneIds).toEqual(["lane-1", "lane-2", "lane-3"]);
  });

  test("rejects a run with no lanes", async () => {
    const { runtime } = setup();
    await expect(runtime.startWorkflow(config([]))).rejects.toThrow(
      /at least one lane/,
    );
  });

  test("rejects an invalid lane id", async () => {
    const { runtime } = setup();
    await expect(
      runtime.startWorkflow(config([{ laneId: "lane_1", steps: 1 }])),
    ).rejects.toThrow(/invalid laneId/);
  });

  test("rejects duplicate lane ids (no double dispatch, no lost handle)", async () => {
    const { runtime, fake } = setup();
    await expect(
      runtime.startWorkflow(config(laneSpecs("lane-1", "lane-1"))),
    ).rejects.toThrow(/duplicate laneId/);
    // Nothing was dispatched — the run is rejected before any lane runs.
    expect(fake.dispatched).toHaveLength(0);
  });
});

describe("handle mapping and encapsulation", () => {
  test("logical handles map to internal panes", async () => {
    const { runtime, fake } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    // Each logical lane resolved to a distinct internal pane.
    const p1 = fake.paneIdForLane("lane-1");
    const p2 = fake.paneIdForLane("lane-2");
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1).not.toBe(p2);
    void handle;
  });

  test("the public API never leaks pane or tab identifiers", async () => {
    const { runtime } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    await runtime.awaitLane(handle.runId, "lane-1", 1000);
    await runtime.awaitLane(handle.runId, "lane-2", 1000);
    const status = await runtime.inspectWorkflow(handle.runId);
    const result = await runtime.inspectLaneResult(handle.runId, "lane-1");
    const serialized = JSON.stringify({ handle, status, result });
    expect(serialized).not.toContain("wf:p");
    expect(serialized).not.toContain("wf:t");
    expect(Object.keys(handle).sort()).toEqual(["laneIds", "runId"]);
  });
});

describe("run+lane-specific sentinels", () => {
  test("each lane carries a distinct token, distinct across runs", async () => {
    const { runtime } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const run1 = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    const a1 = await runtime.inspectLaneResult(run1.runId, "lane-1");
    const a2 = await runtime.inspectLaneResult(run1.runId, "lane-2");
    expect(a1.sentinelToken).toBe("FLOW_run1_LANE_lane-1_EXIT");
    expect(a2.sentinelToken).toBe("FLOW_run1_LANE_lane-2_EXIT");
    expect(a1.sentinelToken).not.toBe(a2.sentinelToken);

    const run2 = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    const b1 = await runtime.inspectLaneResult(run2.runId, "lane-1");
    expect(b1.sentinelToken).toBe("FLOW_run2_LANE_lane-1_EXIT");
    expect(b1.sentinelToken).not.toBe(a1.sentinelToken);
  });
});

describe("control routing", () => {
  test("focus routes to the correct lane's pane and tab", async () => {
    const { runtime, fake } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    await runtime.focusLane(handle.runId, "lane-2");
    const lane2Pane = fake.paneIdForLane("lane-2");
    expect(lane2Pane).toBeDefined();
    expect(fake.focusedPaneId).toBe(lane2Pane!);
    expect(fake.focusedTabId).toBe("wf:t1");
  });

  test("result inspection routes to the correct lane", async () => {
    const { runtime } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    const r = await runtime.inspectLaneResult(handle.runId, "lane-2");
    expect(r.laneId).toBe("lane-2");
    expect(r.sentinelToken).toBe("FLOW_run1_LANE_lane-2_EXIT");
  });

  test("unknown run or lane is rejected", async () => {
    const { runtime } = setup({ lanes: [{ laneId: "lane-1", exitCode: 0 }] });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    await expect(runtime.focusLane("nope", "lane-1")).rejects.toThrow(
      /unknown runId/,
    );
    await expect(
      runtime.interruptLane(handle.runId, "lane-9"),
    ).rejects.toThrow(/unknown laneId/);
  });
});

describe("interrupt isolation", () => {
  test("interrupting one lane yields exit 130; the others complete", async () => {
    const { runtime } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
        { laneId: "lane-3", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2", "lane-3"]);

    const outcome = await runtime.interruptLane(handle.runId, "lane-2");
    expect(outcome.laneId).toBe("lane-2");
    expect(outcome.signal).toBe("SIGINT");
    expect(outcome.delivered).toBe(true);

    const r1 = await runtime.awaitLane(handle.runId, "lane-1", 1000);
    const r2 = await runtime.awaitLane(handle.runId, "lane-2", 1000);
    const r3 = await runtime.awaitLane(handle.runId, "lane-3", 1000);

    expect(r1.state).toBe("complete");
    expect(r1.exitCode).toBe(0);
    expect(r2.state).toBe("interrupted");
    expect(r2.exitCode).toBe(130);
    expect(r3.state).toBe("complete");
    expect(r3.exitCode).toBe(0);
  });
});

describe("controller loss (export / attach)", () => {
  test("a fresh controller attaches, sees the lanes alive, and collects them", async () => {
    const { runtime, fake, clock } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2"]);
    const topology = runtime.exportRun(handle.runId);

    // A fresh controller (new runtime) over the SAME adapter — as if the
    // dispatching controller had exited and the lanes kept running under Herdr.
    const fresh = makeRuntime(fake, clock);
    const attached = fresh.attachRun(topology);
    expect(attached.runId).toBe(handle.runId);
    expect(attached.laneIds).toEqual(["lane-1", "lane-2"]);

    // The fresh controller sees the lanes still running.
    const status = await fresh.inspectWorkflow(handle.runId);
    expect(status.lanes.every((l) => l.state === "running")).toBe(true);

    // ...and can drive them to completion through logical handles.
    const r1 = await fresh.awaitLane(handle.runId, "lane-1", 1000);
    const r2 = await fresh.awaitLane(handle.runId, "lane-2", 1000);
    expect(r1.state).toBe("complete");
    expect(r2.state).toBe("complete");
  });

  test("attach rejects an unsupported topology version", () => {
    const { runtime } = setup();
    expect(() => runtime.attachRun(JSON.stringify({ v: 2 }))).toThrow(
      /unsupported run topology/,
    );
  });

  test("exportRun rejects an unknown run", () => {
    const { runtime } = setup();
    expect(() => runtime.exportRun("nope")).toThrow(/unknown runId/);
  });
});

describe("wait-output match vs real exit code", () => {
  test("a matched wait with a 130 sentinel is interrupted, not complete", async () => {
    const { runtime } = setup({
      lanes: [{ laneId: "lane-1", exitCode: 130, waitMatches: true }],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    const r = await runtime.awaitLane(handle.runId, "lane-1", 1000);
    expect(r.waitMatched).toBe(true); // the sentinel appeared
    expect(r.exitCode).toBe(130); // but the real code came from the durable log
    expect(r.state).toBe("interrupted");
  });

  test("a matched wait with a non-zero, non-130 sentinel is failed", async () => {
    const { runtime } = setup({
      lanes: [{ laneId: "lane-1", exitCode: 2, waitMatches: true }],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    const r = await runtime.awaitLane(handle.runId, "lane-1", 1000);
    expect(r.waitMatched).toBe(true);
    expect(r.exitCode).toBe(2);
    expect(r.state).toBe("failed");
  });
});

describe("error paths", () => {
  test("a missing sentinel is an error, not a silent success", async () => {
    const { runtime } = setup({
      lanes: [{ laneId: "lane-1", exitCode: 0, emitSentinel: false }],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    await expect(
      runtime.awaitLane(handle.runId, "lane-1", 1000),
    ).rejects.toThrow(/no sentinel/);
  });

  test("a dispatched lane's durable read error propagates (no fail-open)", async () => {
    const { runtime } = setup({
      lanes: [{ laneId: "lane-1", exitCode: 0, readErrors: true }],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    // lane-1 was accepted, so a broken durable read must throw, not return an
    // empty result that disguises the evidence failure.
    await expect(
      runtime.inspectLaneResult(handle.runId, "lane-1"),
    ).rejects.toThrow(/durable read failed/);
  });

  test("a failed dispatch command surfaces as PartialDispatchError", async () => {
    const { runtime } = setup({ failRunInPane: true });
    await expect(
      runtime.startWorkflow(config(laneSpecs("lane-1"))),
    ).rejects.toBeInstanceOf(PartialDispatchError);
  });

  test("a partial dispatch leaves the whole run inspectable and started lanes controllable", async () => {
    // Three lanes: lane-1 dispatches, lane-2's dispatch throws, lane-3 is never
    // dispatched — the case the two-lane test missed.
    const { runtime } = setup({
      failRunInPaneAfter: 1,
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
        { laneId: "lane-3", exitCode: 0 },
      ],
    });
    let error: PartialDispatchError | null = null;
    try {
      await runtime.startWorkflow(config(laneSpecs("lane-1", "lane-2", "lane-3")));
    } catch (caught) {
      error = caught as PartialDispatchError;
    }
    expect(error).toBeInstanceOf(PartialDispatchError);
    expect(error!.startedLaneIds).toEqual(["lane-1"]);

    // inspectWorkflow must NOT throw on the never-dispatched lane-3's idle pane.
    const status = await runtime.inspectWorkflow(error!.runId);
    expect(status.lanes.find((l) => l.laneId === "lane-1")?.state).toBe("running");
    expect(status.lanes.find((l) => l.laneId === "lane-2")?.state).toBe("failed");
    // lane-3 was never dispatched — a clear terminal state, not "starting".
    expect(status.lanes.find((l) => l.laneId === "lane-3")?.state).toBe("failed");
    // A run with a running lane aggregates to "running", even though dispatch
    // aborted before run.dispatchedAt was stamped.
    expect(status.state).toBe("running");

    // inspectLaneResult on the never-dispatched lane must not throw either.
    const r3 = await runtime.inspectLaneResult(error!.runId, "lane-3");
    expect(r3.state).toBe("failed");
    expect(r3.exitCode).toBeNull();

    // The started lane stays controllable.
    const outcome = await runtime.interruptLane(error!.runId, "lane-1");
    expect(outcome.delivered).toBe(true);
  });
});

describe("durable log isolation", () => {
  test("the durable log path is scoped by runId (no cross-run truncation)", async () => {
    const { runtime, fake } = setup({ lanes: [{ laneId: "lane-1", exitCode: 0 }] });
    const h1 = await startAndConfirm(runtime, ["lane-1"]);
    const h2 = await startAndConfirm(runtime, ["lane-1"]);
    // Recover each dispatched command's logFile argument (token index 3).
    const logs = fake.dispatched.map((d) => scanSingleQuoted(d.command)[3]);
    expect(logs[0]).toContain(h1.runId);
    expect(logs[1]).toContain(h2.runId);
    expect(logs[0]).not.toBe(logs[1]);
  });
});

describe("process-info gated completion", () => {
  test("a matched sentinel over a still-running process is not completion", async () => {
    const { runtime, fake } = setup({
      processGoneTimeoutMs: 3,
      processGoneIntervalMs: 1,
      lanes: [
        { laneId: "lane-1", exitCode: 0, waitMatches: true, staysRunningAfterMatch: true },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    const before = fake.processInfoCalls;
    await expect(
      runtime.awaitLane(handle.runId, "lane-1", 1000),
    ).rejects.toThrow(/still running/);
    // process-info was actually consulted (the gate is load-bearing).
    expect(fake.processInfoCalls).toBeGreaterThan(before);
  });
});

describe("measured / unavailable metrics", () => {
  test("simulated model and tokens are unavailable; wall-clock is measured", async () => {
    const { runtime } = setup({
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    await runtime.awaitLane(handle.runId, "lane-1", 1000);
    const { metrics } = await runtime.inspectWorkflow(handle.runId);

    expect(metrics.startupLatency.kind).toBe("measured");
    expect(metrics.tokenUsage.kind).toBe("unavailable");
    if (metrics.tokenUsage.kind === "unavailable") {
      expect(metrics.tokenUsage.reason.length).toBeGreaterThan(0);
    }

    const lane = metrics.perLane["lane-1"]!;
    expect(lane.processStartup.kind).toBe("measured");
    expect(lane.executionWait.kind).toBe("measured");
    expect(lane.modelInference.kind).toBe("unavailable");
    expect(lane.humanCoordination.kind).toBe("unavailable");
    if (lane.modelInference.kind === "unavailable") {
      expect(lane.modelInference.reason).toContain("model");
    }
  });

  test("phase timings carry the exact measured deltas", async () => {
    const { runtime } = setup({
      advances: { processInfo: 5 },
      lanes: [{ laneId: "lane-1", exitCode: 0, execMs: 11 }],
    });
    const handle = await runtime.startWorkflow(config(laneSpecs("lane-1")));
    await runtime.confirmLaneStarted(handle.runId, "lane-1");
    await runtime.awaitLane(handle.runId, "lane-1", 1000);
    const { metrics } = await runtime.inspectWorkflow(handle.runId);
    const lane = metrics.perLane["lane-1"]!;

    // processStartup = the single live-confirming process-info advance (5ms).
    // executionWait = the wait-output advance (11ms) plus the one process-info
    // call that confirms the process has exited before finalizing (5ms) = 16ms.
    // inspectWorkflow refreshes a terminal lane without re-timing, so the deltas
    // stay exact.
    expect(lane.processStartup).toEqual({ kind: "measured", ms: 5 });
    expect(lane.executionWait).toEqual({ kind: "measured", ms: 16 });
  });

  test("human coordination is measured from checkpoint to interrupt", async () => {
    const { runtime } = setup({
      advances: { interruptPane: 7 },
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const handle = await startAndConfirm(runtime, ["lane-1"]);
    runtime.markCheckpoint(handle.runId);
    await runtime.interruptLane(handle.runId, "lane-1");
    const { metrics } = await runtime.inspectWorkflow(handle.runId);
    expect(metrics.perLane["lane-1"]!.humanCoordination).toEqual({
      kind: "measured",
      ms: 7,
    });
  });
});
