import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../src/runtime/events.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import { reduce } from "../src/runtime/reducer.ts";

const events: RunEvent[] = [
  {
    schemaVersion: 1,
    eventId: "run-ledger#1",
    runId: "run-ledger",
    sequence: 1,
    type: "run_started",
    at: 10,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      workflow: "wf",
      workspace: "w1",
      cwd: "/tmp/run-ledger",
      splitDirection: "down",
      tabId: "w1:t1",
      controllerPaneId: "w1:p1",
      fixedPoint: null,
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-ledger#2",
    runId: "run-ledger",
    laneId: "lane-1",
    sequence: 2,
    type: "lane_registered",
    at: 20,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      laneId: "lane-1",
      paneId: "w1:p2",
      logFile: "/tmp/lane-1.log",
      sentinelToken: "FLOW_run-ledger_LANE_lane-1_EXIT",
      steps: 1,
      stepDelaySeconds: 0,
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-ledger#3",
    runId: "run-ledger",
    laneId: "lane-1",
    sequence: 3,
    type: "lane_live",
    at: 30,
    actor: "runtime",
    controllerEpoch: 0,
    data: {},
  },
  {
    schemaVersion: 1,
    eventId: "run-ledger#4",
    runId: "run-ledger",
    laneId: "lane-1",
    sequence: 4,
    type: "lane_checkpoint",
    at: 40,
    actor: "agent",
    controllerEpoch: 0,
    data: { semanticState: "complete", checkpointFile: "/tmp/checkpoint.json" },
  },
  {
    schemaVersion: 1,
    eventId: "run-ledger#5",
    runId: "run-ledger",
    laneId: "lane-1",
    sequence: 5,
    type: "lane_contract_evaluated",
    at: 50,
    actor: "validator",
    controllerEpoch: 0,
    data: { contractState: "satisfied", resultFile: "/tmp/result.json", errors: [] },
  },
  {
    schemaVersion: 1,
    eventId: "run-ledger#6",
    runId: "run-ledger",
    laneId: "lane-1",
    sequence: 6,
    type: "lane_verification_recorded",
    at: 60,
    actor: "runner",
    controllerEpoch: 0,
    data: { verificationState: "verified", evidenceFile: "/tmp/evidence.json" },
  },
];

describe("InMemoryLedger", () => {
  test("load replays committed events through the shared reducer", async () => {
    const ledger = new InMemoryLedger();
    for (const event of events) await ledger.commit(event);

    let expected;
    for (const event of events) expected = reduce(expected, event);
    const loaded = await ledger.load("run-ledger");

    expect(loaded).toEqual(expected!);
    expect(loaded!.lanes["lane-1"]).toMatchObject({
      runtimeState: "running",
      semanticState: "complete",
      contractState: "satisfied",
      verificationState: "verified",
    });
    expect(loaded!.lastAppliedSequence).toBe(6);
    expect(await ledger.list()).toEqual([{ runId: "run-ledger" }]);
  });

  test("rejects an invalid append without changing the loaded run", async () => {
    const ledger = new InMemoryLedger();
    await ledger.commit(events[0]!);

    await expect(ledger.commit(events[0]!)).rejects.toThrow(/sequence/);
    expect((await ledger.load("run-ledger"))!.lastAppliedSequence).toBe(1);
  });

  test("provides an explicitly trivial ephemeral lease handle", async () => {
    const ledger = new InMemoryLedger();
    const lease = await ledger.acquireLease("run-ledger", {
      controllerId: "controller-1",
      pid: 123,
    });
    await expect(lease.release()).resolves.toBeUndefined();
  });
});
