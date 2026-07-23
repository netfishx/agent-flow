import { describe, expect, test } from "bun:test";
import type { RunEvent, RunEventDataByType, RunEventType } from "../src/runtime/events.ts";
import {
  projectRunState,
  reduce,
  type RunView,
} from "../src/runtime/reducer.ts";

function event<T extends RunEventType>(
  sequence: number,
  type: T,
  options: {
    actor?: RunEvent["actor"];
    laneId?: string;
    data: RunEventDataByType[T];
  },
): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `run-1#${sequence}`,
    runId: "run-1",
    ...(options.laneId === undefined ? {} : { laneId: options.laneId }),
    sequence,
    type,
    at: sequence * 10,
    actor: options.actor ?? "runtime",
    controllerEpoch: type === "controller_attached" ? 1 : 0,
    data: options.data,
  } as RunEvent;
}

describe("reduce", () => {
  test("projects an all-terminal replay without run_finished as incomplete", () => {
    let state = reduce(
      undefined,
      event(1, "run_started", {
        data: {
          workflow: "wf",
          workspace: "w1",
          cwd: "/tmp/run-1",
          splitDirection: "down",
          tabId: "w1:t1",
          controllerPaneId: "w1:p1",
          fixedPoint: null,
        },
      }),
    );
    state = reduce(
      state,
      event(2, "lane_registered", {
        laneId: "lane-1",
        data: {
          laneId: "lane-1",
          paneId: "w1:p2",
          logFile: "/tmp/lane-1.log",
          stderrFile: "/tmp/lane-1.stderr.log",
          sentinelToken: "FLOW_run-1_LANE_lane-1_EXIT",
          steps: 1,
          stepDelaySeconds: 0,
        },
      }),
    );
    state = reduce(
      state,
      event(3, "lane_dispatched", {
        laneId: "lane-1",
        data: { command: "actual command" },
      }),
    );
    state = reduce(
      state,
      event(4, "lane_exited", {
        laneId: "lane-1",
        data: { exitCode: 0, waitMatched: true },
      }),
    );

    expect(projectRunState(state)).toBe("incomplete");
  });

  test("replays the complete event vocabulary into orthogonal lane state", () => {
    const events: RunEvent[] = [
      event(1, "run_started", {
        data: {
          workflow: "cross-review",
          workspace: "w1",
          cwd: "/tmp/run-1",
          splitDirection: "down",
          tabId: "w1:t1",
          controllerPaneId: "w1:p1",
          fixedPoint: null,
        },
      }),
      ...["exited", "crashed", "lost", "rejected"].map((laneId, index) =>
        event(index + 2, "lane_registered", {
          laneId,
          data: {
            laneId,
            paneId: `w1:p${index + 2}`,
            logFile: `/tmp/${laneId}.log`,
            stderrFile: `/tmp/${laneId}.stderr.log`,
            sentinelToken: `FLOW_run-1_LANE_${laneId}_EXIT`,
            steps: 3,
            stepDelaySeconds: 0.1,
            role: "reviewer",
          },
        }),
      ),
      event(6, "lane_dispatch_intent", { laneId: "exited", data: {} }),
      event(7, "lane_dispatched", {
        laneId: "exited",
        data: { command: "actual command" },
      }),
      event(8, "lane_live", { laneId: "exited", data: {} }),
      event(9, "lane_checkpoint", {
        actor: "agent",
        laneId: "exited",
        data: { semanticState: "working", checkpointFile: "/tmp/checkpoint.json" },
      }),
      event(10, "lane_contract_evaluated", {
        actor: "validator",
        laneId: "exited",
        data: {
          contractState: "violated",
          resultFile: "/tmp/result.json",
          errors: ["missing VERDICT"],
        },
      }),
      event(11, "lane_verification_recorded", {
        actor: "runner",
        laneId: "exited",
        data: { verificationState: "failed", evidenceFile: "/tmp/evidence.json" },
      }),
      event(12, "checkpoint_announced", { data: {} }),
      event(13, "human_interrupt", {
        actor: "human",
        laneId: "exited",
        data: { laneId: "exited" },
      }),
      event(14, "lane_takeover", { actor: "human", laneId: "exited", data: {} }),
      event(15, "lane_release", { actor: "human", laneId: "exited", data: {} }),
      event(16, "lane_exited", {
        laneId: "exited",
        data: { exitCode: 130, signal: "SIGINT", waitMatched: true },
      }),
      event(17, "lane_crashed", { laneId: "crashed", data: {} }),
      event(18, "lane_lost", {
        laneId: "lost",
        data: { cause: "pane disappeared" },
      }),
      event(19, "lane_failed_to_start", {
        laneId: "rejected",
        data: { rejection: "dispatch rejected", command: "failed command" },
      }),
      event(20, "controller_attached", {
        data: { controllerId: "controller-2", epoch: 1, pid: 4242 },
      }),
      event(21, "run_finished", {
        data: {
          status: "degraded",
          breakdown: {
            exitedZero: 0,
            exitedNonZero: 1,
            crashed: 1,
            lost: 1,
            failedToStart: 1,
          },
        },
      }),
    ];

    let state: RunView | undefined;
    let stateBeforeCheckpoint: RunView | undefined;
    let stateAtTakeover: RunView | undefined;
    let stateAfterDispatchIntent: RunView | undefined;
    let stateAfterDispatch: RunView | undefined;
    let stateAfterLive: RunView | undefined;
    let stateAfterInterrupt: RunView | undefined;
    for (const item of events) {
      if (item.type === "lane_checkpoint") stateBeforeCheckpoint = state;
      state = reduce(state, item);
      if (item.type === "lane_dispatch_intent") stateAfterDispatchIntent = state;
      if (item.type === "lane_dispatched") stateAfterDispatch = state;
      if (item.type === "lane_live") stateAfterLive = state;
      if (item.type === "human_interrupt") stateAfterInterrupt = state;
      if (item.type === "lane_takeover") stateAtTakeover = state;
    }

    expect(stateBeforeCheckpoint!.lanes.exited!.semanticState).toBe("unknown");
    expect(stateAtTakeover!.lanes.exited!.controlMode).toBe("human_owned");
    expect(stateAfterDispatchIntent!.lanes.exited).toMatchObject({
      runtimeState: "pending",
      dispatchIntentAt: 60,
    });
    expect(stateAfterDispatch!.lanes.exited).toMatchObject({
      runtimeState: "pending",
      dispatchedAt: 70,
      dispatchedCommand: "actual command",
    });
    expect(stateAfterLive!.lanes.exited).toMatchObject({
      runtimeState: "running",
      liveAt: 80,
    });
    expect(stateAfterInterrupt!.lanes.exited).toMatchObject({
      runtimeState: "running",
      humanInterruptAt: 130,
    });
    expect(state!.lanes.exited).toMatchObject({
      runtimeState: "exited",
      exitCode: 130,
      signal: "SIGINT",
      waitMatched: true,
      semanticState: "working",
      contractState: "violated",
      verificationState: "failed",
      controlMode: "managed",
    });
    expect(state!.lanes.crashed!.runtimeState).toBe("crashed");
    expect(state!.lanes.lost).toMatchObject({
      runtimeState: "lost",
      lostCause: "pane disappeared",
    });
    expect(state!.lanes.rejected).toMatchObject({
      runtimeState: "failed_to_start",
      startRejection: "dispatch rejected",
    });
    expect(state).toMatchObject({
      lastAppliedSequence: 21,
      controllerEpoch: 1,
      controller: { controllerId: "controller-2", pid: 4242 },
      finishStatus: "degraded",
    });
  });

  test("fails closed on duplicate and gapped sequences", () => {
    const started = event(1, "run_started", {
      data: {
        workflow: "wf",
        workspace: "w1",
        cwd: "/tmp/run-1",
        splitDirection: "down",
        tabId: "w1:t1",
        controllerPaneId: "w1:p1",
        fixedPoint: null,
      },
    });
    const state = reduce(undefined, started);
    const registered = (sequence: number) =>
      event(sequence, "lane_registered", {
        laneId: "lane-1",
        data: {
          laneId: "lane-1",
          paneId: "w1:p2",
          logFile: "/tmp/lane-1.log",
          stderrFile: "/tmp/lane-1.stderr.log",
          sentinelToken: "FLOW_run-1_LANE_lane-1_EXIT",
          steps: 1,
          stepDelaySeconds: 0,
        },
      });

    expect(() => reduce(state, registered(1))).toThrow(/sequence/);
    expect(() => reduce(state, registered(3))).toThrow(/sequence/);
    expect(() =>
      reduce(state, { ...registered(2), eventId: "wrong-event-id" }),
    ).toThrow(/eventId/);
  });

  test("fails closed on duplicate or illegal lifecycle transitions", () => {
    const started = reduce(
      undefined,
      event(1, "run_started", {
        data: {
          workflow: "wf",
          workspace: "w1",
          cwd: "/tmp/run-1",
          splitDirection: "down",
          tabId: "w1:t1",
          controllerPaneId: "w1:p1",
          fixedPoint: null,
        },
      }),
    );
    const registered = reduce(
      started,
      event(2, "lane_registered", {
        laneId: "lane-1",
        data: {
          laneId: "lane-1",
          paneId: "w1:p2",
          logFile: "/tmp/lane-1.log",
          stderrFile: "/tmp/lane-1.stderr.log",
          sentinelToken: "FLOW_run-1_LANE_lane-1_EXIT",
          steps: 1,
          stepDelaySeconds: 0,
        },
      }),
    );

    const intended = reduce(
      registered,
      event(3, "lane_dispatch_intent", { laneId: "lane-1", data: {} }),
    );
    expect(() =>
      reduce(
        intended,
        event(4, "lane_dispatch_intent", { laneId: "lane-1", data: {} }),
      ),
    ).toThrow(/lane_dispatch_intent/);

    const dispatched = reduce(
      registered,
      event(3, "lane_dispatched", {
        laneId: "lane-1",
        data: { command: "actual command" },
      }),
    );
    expect(() =>
      reduce(
        dispatched,
        event(4, "lane_dispatched", {
          laneId: "lane-1",
          data: { command: "duplicate command" },
        }),
      ),
    ).toThrow(/lane_dispatched/);

    const live = reduce(
      registered,
      event(3, "lane_live", { laneId: "lane-1", data: {} }),
    );
    expect(() =>
      reduce(live, event(4, "lane_live", { laneId: "lane-1", data: {} })),
    ).toThrow(/lane_live/);

    const terminal = reduce(
      registered,
      event(3, "lane_exited", {
        laneId: "lane-1",
        data: { exitCode: 0, waitMatched: true },
      }),
    );
    expect(() =>
      reduce(
        terminal,
        event(4, "lane_exited", {
          laneId: "lane-1",
          data: { exitCode: 0, waitMatched: true },
        }),
      ),
    ).toThrow(/terminal/);
    expect(() =>
      reduce(
        terminal,
        event(4, "lane_crashed", { laneId: "lane-1", data: {} }),
      ),
    ).toThrow(/terminal/);
    expect(() =>
      reduce(
        terminal,
        event(4, "lane_lost", {
          laneId: "lane-1",
          data: { cause: "pane disappeared" },
        }),
      ),
    ).toThrow(/terminal/);
    expect(() =>
      reduce(
        terminal,
        event(4, "lane_failed_to_start", {
          laneId: "lane-1",
          data: { rejection: "rejected", command: null },
        }),
      ),
    ).toThrow(/terminal/);

    expect(() =>
      reduce(
        started,
        event(2, "run_finished", {
          data: {
            status: "clean",
            breakdown: {
              exitedZero: 0,
              exitedNonZero: 0,
              crashed: 0,
              lost: 0,
              failedToStart: 0,
            },
          },
        }),
      ),
    ).toThrow(/at least one lane/);

    const finished = reduce(
      terminal,
      event(4, "run_finished", {
        data: {
          status: "clean",
          breakdown: {
            exitedZero: 1,
            exitedNonZero: 0,
            crashed: 0,
            lost: 0,
            failedToStart: 0,
          },
        },
      }),
    );
    expect(() =>
      reduce(
        finished,
        event(5, "run_finished", {
          data: {
            status: "clean",
            breakdown: {
              exitedZero: 1,
              exitedNonZero: 0,
              crashed: 0,
              lost: 0,
              failedToStart: 0,
            },
          },
        }),
      ),
    ).toThrow(/run_finished/);
  });

  test("retains human coordination from the first interrupt", () => {
    const events: RunEvent[] = [
      event(1, "run_started", {
        data: {
          workflow: "wf",
          workspace: "w1",
          cwd: "/tmp/run-1",
          splitDirection: "down",
          tabId: "w1:t1",
          controllerPaneId: "w1:p1",
          fixedPoint: null,
        },
      }),
      event(2, "lane_registered", {
        laneId: "lane-1",
        data: {
          laneId: "lane-1",
          paneId: "w1:p2",
          logFile: "/tmp/lane-1.log",
          stderrFile: "/tmp/lane-1.stderr.log",
          sentinelToken: "FLOW_run-1_LANE_lane-1_EXIT",
          steps: 1,
          stepDelaySeconds: 0,
        },
      }),
      event(3, "checkpoint_announced", { data: {} }),
      event(4, "human_interrupt", {
        actor: "human",
        laneId: "lane-1",
        data: { laneId: "lane-1" },
      }),
      event(5, "human_interrupt", {
        actor: "human",
        laneId: "lane-1",
        data: { laneId: "lane-1" },
      }),
    ];
    let state: RunView | undefined;
    for (const item of events) state = reduce(state, item);

    expect(state!.lanes["lane-1"]!.humanCoordinationMs).toBe(10);
  });
});

describe("terminal lanes cannot be re-dispatched", () => {
  const base = (): RunView => {
    const started = reduce(
      undefined,
      event(1, "run_started", {
        data: {
          workflow: "wf",
          workspace: "w1",
          cwd: "/tmp/ev",
          splitDirection: "down",
          tabId: "t1",
          controllerPaneId: "p0",
          fixedPoint: null,
        },
      }),
    );
    return reduce(
      started,
      event(2, "lane_registered", {
        laneId: "lane-1",
        data: {
          laneId: "lane-1",
          paneId: "p1",
          logFile: "/tmp/ev/lane-1.log",
          stderrFile: "/tmp/ev/lane-1.stderr.log",
          sentinelToken: "FLOW_run-1_LANE_lane-1_EXIT",
          steps: 1,
          stepDelaySeconds: 0.1,
        },
      }),
    );
  };

  const TERMINALS: Array<[string, RunEvent]> = [
    [
      "exited",
      event(3, "lane_exited", {
        laneId: "lane-1",
        data: { exitCode: 0, waitMatched: true },
      }),
    ],
    ["crashed", event(3, "lane_crashed", { laneId: "lane-1", data: {} })],
    [
      "lost",
      event(3, "lane_lost", { laneId: "lane-1", data: { cause: "gone" } }),
    ],
    [
      "failed_to_start",
      event(3, "lane_failed_to_start", {
        laneId: "lane-1",
        data: { rejection: "refused", command: null },
      }),
    ],
  ];

  for (const [name, terminalEvent] of TERMINALS) {
    for (const dispatchType of ["lane_dispatch_intent", "lane_dispatched"] as const) {
      test(`${dispatchType} after ${name} fails closed`, () => {
        const terminal = reduce(base(), terminalEvent);
        expect(() =>
          reduce(
            terminal,
            event(4, dispatchType, {
              laneId: "lane-1",
              data:
                dispatchType === "lane_dispatched"
                  ? { command: "late command" }
                  : {},
            }),
          ),
        ).toThrow(/terminal/);
      });
    }
    test(`post-${name} checkpoint/contract/verification/takeover stay legal`, () => {
      let state = reduce(base(), terminalEvent);
      state = reduce(
        state,
        event(4, "lane_checkpoint", {
          actor: "agent",
          laneId: "lane-1",
          data: { semanticState: "partial", checkpointFile: "/tmp/cp" },
        }),
      );
      state = reduce(
        state,
        event(5, "lane_contract_evaluated", {
          actor: "validator",
          laneId: "lane-1",
          data: { contractState: "violated", resultFile: "/tmp/r", errors: ["x"] },
        }),
      );
      state = reduce(
        state,
        event(6, "lane_verification_recorded", {
          actor: "runner",
          laneId: "lane-1",
          data: { verificationState: "failed", evidenceFile: "/tmp/e" },
        }),
      );
      state = reduce(
        state,
        event(7, "lane_takeover", { actor: "human", laneId: "lane-1", data: {} }),
      );
      const lane = state.lanes["lane-1"]!;
      expect(lane.semanticState).toBe("partial");
      expect(lane.contractState).toBe("violated");
      expect(lane.verificationState).toBe("failed");
      expect(lane.controlMode).toBe("human_owned");
    });
  }
});
