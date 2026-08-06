// The advisory/objective boundary and attempt disposition rules — the two
// facts #49 says must be impossible to conflate. These run over the projection
// alone: no Herdr, no ledger, no runtime.

import { describe, expect, test } from "bun:test";
import {
  objectiveFactsOf,
  projectAttemptDisposition,
} from "../src/interactive/attempts.ts";
import type { InteractiveAttemptView } from "../src/interactive/types.ts";

function attempt(
  patch: Partial<InteractiveAttemptView> = {},
): InteractiveAttemptView {
  return {
    attemptId: "a1",
    ordinal: 1,
    runId: "r1",
    laneId: "l1",
    parentAttemptId: null,
    agentKind: "claude",
    model: "sonnet",
    effort: "high",
    paneId: "w1:p2",
    agentName: null,
    agentSessionId: null,
    worktreePath: "/tmp/wt",
    briefFile: "/tmp/brief.md",
    checkpointFile: "/tmp/checkpoint.md",
    resultPointer: "/tmp/result.md",
    startedAt: 10,
    endedAt: null,
    endReason: null,
    exitCode: null,
    supersededBy: null,
    authorization: { actor: "human", note: "owner authorized", at: 5 },
    agentCheckpoint: null,
    runnerEvidence: [],
    reconciliation: null,
    startFailure: null,
    advisory: [],
    controlMode: "managed",
    steerSubmissions: 0,
    steerObservations: 0,
    lastCancelTurnAt: null,
    lastAbortAt: null,
    ...patch,
  };
}

const runnerEvidence = {
  evidenceId: "e1",
  attemptId: "a1",
  command: "bun test",
  logFile: "/tmp/runner.log",
  paneId: "w1:p9",
  exitCode: 0,
  startedAt: 20,
  endedAt: 30,
} as const;

const completeCheckpoint = {
  file: "/tmp/checkpoint.md",
  semanticState: "complete",
  origin: "agent",
  at: 25,
} as const;

describe("advisory state is not evidence", () => {
  test("an advisory done cannot mark an attempt complete", () => {
    const view = attempt({
      endedAt: 40,
      endReason: "session-exit",
      exitCode: 0,
      advisory: [
        { status: "done", source: "herdr-detection", paneId: "w1:p2", at: 35 },
        { status: "idle", source: "runtime-published", paneId: "w1:p2", at: 36 },
      ],
    });
    expect(projectAttemptDisposition(objectiveFactsOf(view))).toBe("unknown");
  });

  test("objectiveFactsOf drops the advisory channel entirely", () => {
    const facts = objectiveFactsOf(
      attempt({
        advisory: [
          { status: "blocked", source: "herdr-detection", paneId: "w1:p2", at: 1 },
        ],
      }),
    );
    expect("advisory" in facts).toBe(false);
  });

  test("the attempt view itself is not assignable to the objective facts", () => {
    const view = attempt();
    // @ts-expect-error advisory state may not enter outcome projection
    projectAttemptDisposition(view);
    expect(view.advisory).toEqual([]);
  });
});

describe("attempt disposition", () => {
  test("completion needs both an agent checkpoint and runner evidence", () => {
    const checkpointOnly = attempt({
      endedAt: 40,
      endReason: "session-exit",
      exitCode: 0,
      agentCheckpoint: completeCheckpoint,
    });
    expect(projectAttemptDisposition(objectiveFactsOf(checkpointOnly))).toBe(
      "unknown",
    );

    const runnerOnly = attempt({
      endedAt: 40,
      endReason: "session-exit",
      exitCode: 0,
      runnerEvidence: [runnerEvidence],
    });
    expect(projectAttemptDisposition(objectiveFactsOf(runnerOnly))).toBe(
      "unknown",
    );

    const both = attempt({
      endedAt: 40,
      endReason: "session-exit",
      exitCode: 0,
      agentCheckpoint: completeCheckpoint,
      runnerEvidence: [runnerEvidence],
    });
    expect(projectAttemptDisposition(objectiveFactsOf(both))).toBe("completed");
  });

  test("a zero session exit code alone never completes an attempt", () => {
    const view = attempt({ endedAt: 40, endReason: "session-exit", exitCode: 0 });
    expect(projectAttemptDisposition(objectiveFactsOf(view))).toBe("unknown");
  });

  test("a reoccupied or missing pane fails closed to unknown", () => {
    for (const outcome of ["reoccupied", "missing"] as const) {
      const view = attempt({
        agentCheckpoint: completeCheckpoint,
        runnerEvidence: [runnerEvidence],
        reconciliation: { outcome, at: 50, detail: null },
      });
      expect(projectAttemptDisposition(objectiveFactsOf(view))).toBe("unknown");
    }
  });

  test("abort and cancel-turn produce distinct dispositions", () => {
    const aborted = attempt({
      endedAt: 40,
      endReason: "aborted",
      lastAbortAt: 39,
    });
    expect(projectAttemptDisposition(objectiveFactsOf(aborted))).toBe("aborted");

    const interrupted = attempt({
      endedAt: 40,
      endReason: "interrupted",
      lastCancelTurnAt: 39,
    });
    expect(projectAttemptDisposition(objectiveFactsOf(interrupted))).toBe(
      "interrupted",
    );
  });

  test("a live attempt is running, and a superseded one is superseded", () => {
    expect(projectAttemptDisposition(objectiveFactsOf(attempt()))).toBe(
      "running",
    );
    const superseded = attempt({
      endedAt: 40,
      endReason: "session-exit",
      supersededBy: "a2",
    });
    expect(projectAttemptDisposition(objectiveFactsOf(superseded))).toBe(
      "superseded",
    );
  });

  test("a start failure is a start failure, never a retry", () => {
    const failed = attempt({
      startFailure: { cause: "herdr agent start timed out after 30000ms", at: 12 },
      endedAt: 12,
      endReason: "start-failed",
    });
    expect(projectAttemptDisposition(objectiveFactsOf(failed))).toBe("unknown");
  });
});
