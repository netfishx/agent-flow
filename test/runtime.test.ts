import { describe, expect, test } from "bun:test";
import {
  createClock,
  FakeHerdrAdapter,
  type FakeAdvances,
  type FakeLaneProgram,
} from "../src/herdr/fake-adapter.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
import type { LaneSpec } from "../src/runtime/types.ts";

interface SetupOptions {
  lanes?: FakeLaneProgram[];
  advances?: FakeAdvances;
  failRunInPane?: boolean;
  clockStart?: number;
}

function setup(opts: SetupOptions = {}) {
  const clock = createClock(opts.clockStart ?? 0);
  const fake = new FakeHerdrAdapter({
    clock,
    lanes: opts.lanes,
    advances: opts.advances,
    failRunInPane: opts.failRunInPane,
  });
  let n = 0;
  const runtime = new WorkflowRuntime({
    adapter: fake,
    clock: clock.now,
    idgen: () => `run${++n}`,
    readResultFile: fake.readResultFile,
    sleep: async () => {},
  });
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

async function startAndConfirm(runtime: WorkflowRuntime, ids: string[]) {
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

describe("controller loss", () => {
  test("the launcher leaving does not tear down lanes", async () => {
    const { runtime } = setup({
      lanes: [
        { laneId: "lane-1", exitCode: 0 },
        { laneId: "lane-2", exitCode: 0 },
      ],
    });
    const handle = await startAndConfirm(runtime, ["lane-1", "lane-2"]);

    const loss = await runtime.runControllerMarker(handle.runId, 1000);
    expect(loss.markerMatched).toBe(true);
    expect(loss.controllerBackAtShell).toBe(true);

    // Lanes are still alive right after the controller left.
    const mid = await runtime.inspectWorkflow(handle.runId);
    expect(mid.lanes.every((l) => l.state === "running")).toBe(true);

    // And they still complete afterward.
    const r1 = await runtime.awaitLane(handle.runId, "lane-1", 1000);
    const r2 = await runtime.awaitLane(handle.runId, "lane-2", 1000);
    expect(r1.state).toBe("complete");
    expect(r2.state).toBe("complete");
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

  test("a failed dispatch command surfaces", async () => {
    const { runtime } = setup({ failRunInPane: true });
    await expect(
      runtime.startWorkflow(config(laneSpecs("lane-1"))),
    ).rejects.toThrow(/runInPane failed/);
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
    // executionWait = the wait-output advance (11ms). inspectWorkflow refreshes
    // a terminal lane without re-timing, so the deltas stay exact.
    expect(lane.processStartup).toEqual({ kind: "measured", ms: 5 });
    expect(lane.executionWait).toEqual({ kind: "measured", ms: 11 });
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
