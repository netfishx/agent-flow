import { describe, expect, test } from "bun:test";
import type {
  RunEvent,
  RunEventDataByType,
  RunEventType,
} from "../src/runtime/events.ts";
import { reduce } from "../src/runtime/reducer.ts";
import type { IssueRef } from "../src/index.ts";

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
    eventId: `run-issue#${sequence}`,
    runId: "run-issue",
    ...(options.laneId === undefined ? {} : { laneId: options.laneId }),
    sequence,
    type,
    at: sequence * 100,
    actor: options.actor ?? "runtime",
    controllerEpoch: 0,
    data: options.data,
  } as RunEvent;
}

function started(issue: IssueRef | null): RunEvent {
  return event(1, "run_started", {
    data: {
      workflow: "cross-review",
      workspace: "agent-flow",
      cwd: "/tmp/run-issue",
      splitDirection: "down",
      tabId: "agent-flow:t1",
      controllerPaneId: "agent-flow:p1",
      fixedPoint: null,
      issue,
    },
  });
}

function boundRun() {
  return reduce(
    undefined,
    started({ owner: "netfishx", repo: "agent-flow", number: 24 }),
  );
}

function pendingDelivery() {
  return reduce(
    boundRun(),
    event(2, "issue_delivery_intended", {
      data: {
        deliveryId: "complete:lane-1",
        kind: "complete",
        laneId: "lane-1",
        payloadHash: "sha256:complete",
      },
    }),
  );
}

function failedDelivery() {
  return reduce(
    pendingDelivery(),
    event(3, "issue_delivery_failed", {
      data: {
        deliveryId: "complete:lane-1",
        reason: "permission denied",
        retryable: false,
      },
    }),
  );
}

describe("issue delivery reducer", () => {
  test("rejects run_started when its required issue field is missing", () => {
    const valid = started(null) as Extract<
      RunEvent,
      { readonly type: "run_started" }
    >;
    const { issue: omitted, ...data } = valid.data;
    void omitted;

    expect(() =>
      reduce(undefined, { ...valid, data } as unknown as RunEvent),
    ).toThrow(/run_started.*missing required "issue"/);
  });

  test("projects the immutable issue binding with an unresolved node id", () => {
    expect(
      reduce(
        undefined,
        started({ owner: "netfishx", repo: "agent-flow", number: 24 }),
      ),
    ).toMatchObject({
      issue: { owner: "netfishx", repo: "agent-flow", number: 24 },
      issueNodeId: null,
      deliveries: {},
      deliveryOrder: [],
      decisions: [],
      startAnchorSequence: null,
      finishedSequence: null,
    });

    expect(reduce(undefined, started(null))).toMatchObject({
      issue: null,
      issueNodeId: null,
    });
  });

  test("resolves a bound issue once and rejects unbound or conflicting resolution", () => {
    const bound = reduce(
      undefined,
      started({ owner: "netfishx", repo: "agent-flow", number: 24 }),
    );
    const resolved = reduce(
      bound,
      event(2, "issue_binding_resolved", {
        data: { issueNodeId: "I_kwDOIssue24" },
      }),
    );

    expect(resolved.issueNodeId).toBe("I_kwDOIssue24");
    expect(
      reduce(
        resolved,
        event(3, "issue_binding_resolved", {
          data: { issueNodeId: "I_kwDOIssue24" },
        }),
      ).issueNodeId,
    ).toBe("I_kwDOIssue24");
    expect(() =>
      reduce(
        resolved,
        event(3, "issue_binding_resolved", {
          data: { issueNodeId: "I_kwDODifferent" },
        }),
      ),
    ).toThrow(/different issue node id/);
    expect(() =>
      reduce(
        reduce(undefined, started(null)),
        event(2, "issue_binding_resolved", {
          data: { issueNodeId: "I_kwDOIssue24" },
        }),
      ),
    ).toThrow(/unbound run/);
  });

  test("projects delivery intent, failure, re-intent, and confirmation", () => {
    let state = reduce(
      undefined,
      started({ owner: "netfishx", repo: "agent-flow", number: 24 }),
    );
    state = reduce(
      state,
      event(2, "issue_delivery_intended", {
        data: {
          deliveryId: "start:run-issue",
          kind: "start",
          laneId: null,
          payloadHash: "sha256:start",
        },
      }),
    );
    state = reduce(
      state,
      event(3, "issue_delivery_failed", {
        data: {
          deliveryId: "start:run-issue",
          reason: "remote unavailable",
          retryable: true,
        },
      }),
    );
    expect(state.deliveries["start:run-issue"]).toEqual({
      deliveryId: "start:run-issue",
      kind: "start",
      laneId: null,
      payloadHash: "sha256:start",
      state: "failed",
      intents: 1,
      intendedAt: 200,
      settledAt: 300,
      commentId: null,
      commentUrl: null,
      labelTransition: "not-applicable",
      lastFailure: { reason: "remote unavailable", retryable: true },
    });
    state = reduce(
      state,
      event(4, "issue_delivery_intended", {
        data: {
          deliveryId: "start:run-issue",
          kind: "start",
          laneId: null,
          payloadHash: "sha256:start",
        },
      }),
    );
    expect(state.deliveries["start:run-issue"]).toMatchObject({
      state: "pending",
      intents: 2,
      intendedAt: 400,
      settledAt: null,
      labelTransition: "not-applicable",
      lastFailure: { reason: "remote unavailable", retryable: true },
    });
    state = reduce(
      state,
      event(5, "issue_delivery_confirmed", {
        data: {
          deliveryId: "start:run-issue",
          commentId: 101,
          commentUrl: "https://github.com/netfishx/agent-flow/issues/24#issuecomment-101",
          labelTransition: "applied",
        },
      }),
    );
    state = reduce(
      state,
      event(6, "issue_delivery_intended", {
        data: {
          deliveryId: "blocked:lane-1",
          kind: "blocked",
          laneId: "lane-1",
          payloadHash: "sha256:blocked",
        },
      }),
    );

    expect(state.deliveryOrder).toEqual([
      "start:run-issue",
      "blocked:lane-1",
    ]);
    expect(state.deliveries["start:run-issue"]).toEqual({
      deliveryId: "start:run-issue",
      kind: "start",
      laneId: null,
      payloadHash: "sha256:start",
      state: "delivered",
      intents: 2,
      intendedAt: 400,
      settledAt: 500,
      commentId: 101,
      commentUrl:
        "https://github.com/netfishx/agent-flow/issues/24#issuecomment-101",
      labelTransition: "applied",
      lastFailure: { reason: "remote unavailable", retryable: true },
    });
    expect(state.deliveries["blocked:lane-1"]).toEqual({
      deliveryId: "blocked:lane-1",
      kind: "blocked",
      laneId: "lane-1",
      payloadHash: "sha256:blocked",
      state: "pending",
      intents: 1,
      intendedAt: 600,
      settledAt: null,
      commentId: null,
      commentUrl: null,
      labelTransition: "not-applicable",
      lastFailure: null,
    });
  });

  test("carries an explicit label outcome through every delivery state", () => {
    // The published contract types labelTransition as non-nullable, with
    // "not-applicable" standing for "no label outcome recorded yet". No state
    // in the lifecycle may leave it null.
    const key = "complete:lane-1";
    const intent = {
      deliveryId: key,
      kind: "complete",
      laneId: "lane-1",
      payloadHash: "sha256:complete",
    } as const;

    const pending = pendingDelivery();
    expect(pending.deliveries[key]!.labelTransition).toBe("not-applicable");

    const failed = reduce(
      pending,
      event(3, "issue_delivery_failed", {
        data: { deliveryId: key, reason: "rate limited", retryable: true },
      }),
    );
    expect(failed.deliveries[key]!.labelTransition).toBe("not-applicable");

    const reIntended = reduce(
      failed,
      event(4, "issue_delivery_intended", { data: intent }),
    );
    expect(reIntended.deliveries[key]!.labelTransition).toBe("not-applicable");

    const confirmed = reduce(
      reIntended,
      event(5, "issue_delivery_confirmed", {
        data: {
          deliveryId: key,
          commentId: 7,
          commentUrl:
            "https://github.com/netfishx/agent-flow/issues/24#issuecomment-7",
          labelTransition: "skipped",
        },
      }),
    );
    expect(confirmed.deliveries[key]!.labelTransition).toBe("skipped");
  });

  test("rejects every illegal delivery transition", () => {
    const pending = pendingDelivery();
    const failed = failedDelivery();
    const delivered = reduce(
      pending,
      event(3, "issue_delivery_confirmed", {
        data: {
          deliveryId: "complete:lane-1",
          commentId: 102,
          commentUrl:
            "https://github.com/netfishx/agent-flow/issues/24#issuecomment-102",
          labelTransition: "not-applicable",
        },
      }),
    );

    expect(() =>
      reduce(
        pending,
        event(3, "issue_delivery_intended", {
          data: {
            deliveryId: "complete:lane-1",
            kind: "complete",
            laneId: "lane-1",
            payloadHash: "sha256:complete",
          },
        }),
      ),
    ).toThrow(/received "pending"/);
    expect(() =>
      reduce(
        delivered,
        event(4, "issue_delivery_intended", {
          data: {
            deliveryId: "complete:lane-1",
            kind: "complete",
            laneId: "lane-1",
            payloadHash: "sha256:complete",
          },
        }),
      ),
    ).toThrow(/received "delivered"/);
    for (const [state, sequence] of [
      [pending, 3],
      [failed, 4],
      [delivered, 4],
    ] as const) {
      expect(() =>
        reduce(
          state,
          event(sequence, "issue_delivery_intended", {
            data: {
              deliveryId: "complete:lane-1",
              kind: "complete",
              laneId: "lane-1",
              payloadHash: "sha256:different",
            },
          }),
        ),
      ).toThrow(/payloadHash differs/);
    }

    for (const state of [delivered, failed]) {
      expect(() =>
        reduce(
          state,
          event(4, "issue_delivery_confirmed", {
            data: {
              deliveryId: "complete:lane-1",
              commentId: 103,
              commentUrl: "https://example.test/comment/103",
              labelTransition: "skipped",
            },
          }),
        ),
      ).toThrow(/requires pending/);
      expect(() =>
        reduce(
          state,
          event(4, "issue_delivery_failed", {
            data: {
              deliveryId: "complete:lane-1",
              reason: "late failure",
              retryable: false,
            },
          }),
        ),
      ).toThrow(/requires pending/);
    }

    expect(() =>
      reduce(
        boundRun(),
        event(2, "issue_delivery_confirmed", {
          data: {
            deliveryId: "missing",
            commentId: 104,
            commentUrl: "https://example.test/comment/104",
            labelTransition: "failed",
          },
        }),
      ),
    ).toThrow(/unknown deliveryId/);
    expect(() =>
      reduce(
        boundRun(),
        event(2, "issue_delivery_failed", {
          data: {
            deliveryId: "missing",
            reason: "missing intent",
            retryable: false,
          },
        }),
      ),
    ).toThrow(/unknown deliveryId/);

    const unbound = reduce(undefined, started(null));
    expect(() =>
      reduce(
        unbound,
        event(2, "issue_delivery_intended", {
          data: {
            deliveryId: "start:run-issue",
            kind: "start",
            laneId: null,
            payloadHash: "sha256:start",
          },
        }),
      ),
    ).toThrow(/unbound run/);
    expect(() =>
      reduce(
        unbound,
        event(2, "issue_delivery_confirmed", {
          data: {
            deliveryId: "missing",
            commentId: 105,
            commentUrl: "https://example.test/comment/105",
            labelTransition: "applied",
          },
        }),
      ),
    ).toThrow(/unbound run/);
    expect(() =>
      reduce(
        unbound,
        event(2, "issue_delivery_failed", {
          data: {
            deliveryId: "missing",
            reason: "unbound",
            retryable: false,
          },
        }),
      ),
    ).toThrow(/unbound run/);
  });

  test("rejects a re-intent when kind differs from the first intent", () => {
    expect(() =>
      reduce(
        failedDelivery(),
        event(4, "issue_delivery_intended", {
          data: {
            deliveryId: "complete:lane-1",
            kind: "blocked",
            laneId: "lane-1",
            payloadHash: "sha256:complete",
          },
        }),
      ),
    ).toThrow(/kind differs/);
  });

  test("rejects a re-intent when laneId differs from the first intent", () => {
    expect(() =>
      reduce(
        failedDelivery(),
        event(4, "issue_delivery_intended", {
          data: {
            deliveryId: "complete:lane-1",
            kind: "complete",
            laneId: "lane-2",
            payloadHash: "sha256:complete",
          },
        }),
      ),
    ).toThrow(/laneId differs/);
  });

  test("intentionally records owner decisions on unbound runs unlike delivery events", () => {
    const state = reduce(
      reduce(undefined, started(null)),
      event(2, "owner_decision_recorded", {
        actor: "human",
        data: {
          decision: "changes-requested",
          note: "The owner decision remains true without issue delivery.",
          resultingIssueState: null,
        },
      }),
    );

    expect(state.issue).toBeNull();
    expect(state.decisions).toEqual([
      {
        sequence: 2,
        at: 200,
        actor: "human",
        decision: "changes-requested",
        note: "The owner decision remains true without issue delivery.",
        resultingIssueState: null,
      },
    ]);
  });

  test("records decision and lifecycle anchors without rewriting the first blocked checkpoint", () => {
    const events: RunEvent[] = [
      started({ owner: "netfishx", repo: "agent-flow", number: 24 }),
      event(2, "lane_registered", {
        laneId: "lane-1",
        data: {
          laneId: "lane-1",
          paneId: "agent-flow:p2",
          logFile: "/tmp/lane-1.log",
          stderrFile: "/tmp/lane-1.stderr.log",
          sentinelToken: "FLOW_run-issue_LANE_lane-1_EXIT",
          steps: 1,
          stepDelaySeconds: 0,
        },
      }),
      event(3, "lane_registered", {
        laneId: "lane-2",
        data: {
          laneId: "lane-2",
          paneId: "agent-flow:p3",
          logFile: "/tmp/lane-2.log",
          stderrFile: "/tmp/lane-2.stderr.log",
          sentinelToken: "FLOW_run-issue_LANE_lane-2_EXIT",
          steps: 1,
          stepDelaySeconds: 0,
        },
      }),
      event(4, "owner_decision_recorded", {
        actor: "human",
        data: {
          decision: "accepted",
          note: "Proceed with the first delivery.",
          resultingIssueState: "ready-for-agent",
        },
      }),
      event(5, "lane_dispatch_intent", { laneId: "lane-1", data: {} }),
      event(6, "lane_checkpoint", {
        actor: "agent",
        laneId: "lane-1",
        data: {
          semanticState: "blocked",
          checkpointFile: "/tmp/first-blocked.json",
          blockers: ["owner decision required"],
          next: ["wait for owner"],
          gaps: ["verification not run"],
        },
      }),
      event(7, "lane_checkpoint", {
        actor: "agent",
        laneId: "lane-1",
        data: {
          semanticState: "working",
          checkpointFile: "/tmp/working.json",
        },
      }),
      event(8, "lane_checkpoint", {
        actor: "agent",
        laneId: "lane-1",
        data: {
          semanticState: "blocked",
          checkpointFile: "/tmp/later-blocked.json",
          blockers: ["different blocker"],
          next: ["different next"],
          gaps: ["different gap"],
        },
      }),
      event(9, "lane_dispatch_intent", { laneId: "lane-2", data: {} }),
      event(10, "owner_decision_recorded", {
        actor: "human",
        data: {
          decision: "changes-requested",
          note: "Record the durable evidence.",
          resultingIssueState: null,
        },
      }),
      event(11, "lane_exited", {
        laneId: "lane-1",
        data: { exitCode: 0 },
      }),
      event(12, "lane_exited", {
        laneId: "lane-2",
        data: { exitCode: 0 },
      }),
      event(13, "run_finished", {
        data: {
          status: "clean",
          breakdown: {
            exitedZero: 2,
            exitedNonZero: 0,
            crashed: 0,
            lost: 0,
            failedToStart: 0,
          },
        },
      }),
      event(14, "owner_decision_recorded", {
        actor: "human",
        data: {
          decision: "rejected",
          note: "Reject after reviewing the finished run.",
          resultingIssueState: "closed",
        },
      }),
    ];

    let state;
    for (const item of events) state = reduce(state, item);

    expect(state!.startAnchorSequence).toBe(5);
    expect(state!.finishedSequence).toBe(13);
    expect(state!.decisions).toEqual([
      {
        sequence: 4,
        at: 400,
        actor: "human",
        decision: "accepted",
        note: "Proceed with the first delivery.",
        resultingIssueState: "ready-for-agent",
      },
      {
        sequence: 10,
        at: 1_000,
        actor: "human",
        decision: "changes-requested",
        note: "Record the durable evidence.",
        resultingIssueState: null,
      },
      {
        sequence: 14,
        at: 1_400,
        actor: "human",
        decision: "rejected",
        note: "Reject after reviewing the finished run.",
        resultingIssueState: "closed",
      },
    ]);
    expect(state!.lanes["lane-1"]!.blockedAnchor).toEqual({
      sequence: 6,
      checkpointFile: "/tmp/first-blocked.json",
      blockers: ["owner decision required"],
      next: ["wait for owner"],
      gaps: ["verification not run"],
    });
    expect(state!.lanes["lane-1"]).toMatchObject({
      semanticState: "blocked",
      checkpointFile: "/tmp/later-blocked.json",
    });
  });
});
