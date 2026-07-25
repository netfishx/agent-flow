import type {
  ContractState,
  MilestoneKind,
  OwnerDecision,
  RunFinishStatus,
  RunOutcomeBreakdown,
  RuntimeState,
  SemanticState,
  VerificationState,
} from "../runtime/events.ts";
import type { RunView } from "../runtime/reducer.ts";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StartPayload {
  readonly hashVersion: 1;
  readonly runId: string;
  readonly workflow: string;
  readonly lanes: readonly {
    readonly laneId: string;
    readonly role: string | null;
  }[];
  readonly fixedPoint: {
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly diffHash: string;
    readonly dirtyStatePolicy: "reject" | "record-hash";
  } | null;
}

export interface BlockedPayload {
  readonly hashVersion: 1;
  readonly runId: string;
  readonly laneId: string;
  readonly role: string | null;
  readonly blockers: readonly string[];
  readonly next: readonly string[];
  readonly gaps: readonly string[];
  readonly checkpointPointer: string;
}

export interface CompleteLanePayload {
  readonly laneId: string;
  readonly role: string | null;
  readonly runtimeState: RuntimeState;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly semanticState: SemanticState;
  readonly contractState: ContractState;
  readonly contractErrors: readonly string[];
  readonly verificationState: VerificationState;
  readonly gaps: readonly string[];
  readonly resultPointer: string;
  readonly evidencePointer: string;
  readonly checkpointPointer: string | null;
}

export interface CompletePayload {
  readonly hashVersion: 1;
  readonly runId: string;
  readonly finishStatus: RunFinishStatus;
  readonly breakdown: RunOutcomeBreakdown;
  readonly lanes: readonly CompleteLanePayload[];
}

export interface DecisionPayload {
  readonly hashVersion: 1;
  readonly runId: string;
  readonly decision: OwnerDecision;
  readonly note: string;
  readonly resultingIssueState: string | null;
}

export type MilestonePayload =
  | StartPayload
  | BlockedPayload
  | CompletePayload
  | DecisionPayload;

export type DueMilestone =
  | {
      readonly kind: "start";
      readonly deliveryId: string;
      readonly laneId: null;
      readonly payload: StartPayload;
    }
  | {
      readonly kind: "blocked";
      readonly deliveryId: string;
      readonly laneId: string;
      readonly payload: BlockedPayload;
    }
  | {
      readonly kind: "complete";
      readonly deliveryId: string;
      readonly laneId: null;
      readonly payload: CompletePayload;
    }
  | {
      readonly kind: "decision";
      readonly deliveryId: string;
      readonly laneId: null;
      readonly payload: DecisionPayload;
    };

export function deliveryIdFor(
  runId: string,
  anchorSequence: number,
  kind: MilestoneKind,
  laneId: string | null = null,
): string {
  if (kind === "blocked") {
    if (laneId === null) {
      throw new Error("blocked delivery id requires a lane id");
    }
    return `${runId}:${anchorSequence}:blocked:${laneId}`;
  }
  if (laneId !== null) {
    throw new Error(`${kind} delivery id cannot carry a lane id`);
  }
  return `${runId}:${anchorSequence}:${kind}`;
}

export function marker(deliveryId: string): string {
  return `<!-- agent-flow:delivery:${deliveryId} -->`;
}

function pointerFor(
  run: RunView,
  laneId: string,
  field: string,
  recordedPath: string,
): string {
  if (!isAbsolute(run.cwd) || !isAbsolute(recordedPath)) {
    throw new Error(
      `${field} for lane "${laneId}" is outside the run directory`,
    );
  }
  const runDirectory = resolve(join(run.cwd, run.runId));
  const candidate = resolve(recordedPath);
  const pointer = relative(runDirectory, candidate);
  if (
    pointer === ".." ||
    pointer.startsWith(`..${sep}`) ||
    isAbsolute(pointer)
  ) {
    throw new Error(
      `${field} for lane "${laneId}" is outside the run directory`,
    );
  }
  return pointer;
}

function due(run: RunView, deliveryId: string): boolean {
  const delivery = run.deliveries[deliveryId];
  return (
    delivery === undefined ||
    delivery.state === "pending" ||
    (delivery.state === "failed" &&
      delivery.lastFailure?.retryable === true)
  );
}

function startMilestone(run: RunView): DueMilestone | null {
  if (run.startAnchorSequence === null) return null;
  const deliveryId = deliveryIdFor(
    run.runId,
    run.startAnchorSequence,
    "start",
  );
  if (!due(run, deliveryId)) return null;
  return {
    kind: "start",
    deliveryId,
    laneId: null,
    payload: {
      hashVersion: 1,
      runId: run.runId,
      workflow: run.workflow,
      lanes: run.laneOrder.map((laneId) => {
        const lane = run.lanes[laneId]!;
        return {
          laneId: lane.laneId,
          role: lane.role ?? null,
        };
      }),
      fixedPoint:
        run.fixedPoint === null
          ? null
          : {
              baseCommit: run.fixedPoint.baseCommit,
              headCommit: run.fixedPoint.headCommit,
              diffHash: run.fixedPoint.diffHash,
              dirtyStatePolicy: run.fixedPoint.dirtyStatePolicy,
            },
    },
  };
}

function blockedMilestone(
  run: RunView,
  laneId: string,
): DueMilestone | null {
  const lane = run.lanes[laneId]!;
  const anchor = lane.blockedAnchor;
  if (anchor === null) return null;
  const deliveryId = deliveryIdFor(
    run.runId,
    anchor.sequence,
    "blocked",
    laneId,
  );
  if (!due(run, deliveryId)) return null;
  return {
    kind: "blocked",
    deliveryId,
    laneId,
    payload: {
      hashVersion: 1,
      runId: run.runId,
      laneId,
      role: lane.role ?? null,
      blockers: [...anchor.blockers],
      next: [...anchor.next],
      gaps: [...anchor.gaps],
      checkpointPointer: pointerFor(
        run,
        laneId,
        "checkpointPointer",
        anchor.checkpointFile,
      ),
    },
  };
}

function completeMilestone(run: RunView): DueMilestone | null {
  if (
    run.finishedSequence === null ||
    run.finishStatus === null ||
    run.breakdown === null ||
    !run.laneOrder.every((laneId) => {
      const lane = run.lanes[laneId]!;
      return (
        lane.contractEvaluatedAt !== null &&
        lane.verificationRecordedAt !== null
      );
    })
  ) {
    return null;
  }
  const deliveryId = deliveryIdFor(
    run.runId,
    run.finishedSequence,
    "complete",
  );
  if (!due(run, deliveryId)) return null;
  return {
    kind: "complete",
    deliveryId,
    laneId: null,
    payload: {
      hashVersion: 1,
      runId: run.runId,
      finishStatus: run.finishStatus,
      breakdown: {
        exitedZero: run.breakdown.exitedZero,
        exitedNonZero: run.breakdown.exitedNonZero,
        crashed: run.breakdown.crashed,
        lost: run.breakdown.lost,
        failedToStart: run.breakdown.failedToStart,
      },
      lanes: run.laneOrder.map((laneId) => {
        const lane = run.lanes[laneId]!;
        if (lane.resultFile === null) {
          throw new Error(`resultPointer for lane "${laneId}" is missing`);
        }
        if (lane.evidenceFile === null) {
          throw new Error(`evidencePointer for lane "${laneId}" is missing`);
        }
        return {
          laneId,
          role: lane.role ?? null,
          runtimeState: lane.runtimeState,
          exitCode: lane.exitCode,
          signal: lane.signal,
          semanticState: lane.semanticState,
          contractState: lane.contractState,
          contractErrors: [...lane.contractErrors],
          verificationState: lane.verificationState,
          gaps: [],
          resultPointer: pointerFor(
            run,
            laneId,
            "resultPointer",
            lane.resultFile,
          ),
          evidencePointer: pointerFor(
            run,
            laneId,
            "evidencePointer",
            lane.evidenceFile,
          ),
          checkpointPointer:
            lane.checkpointFile === null
              ? null
              : pointerFor(
                  run,
                  laneId,
                  "checkpointPointer",
                  lane.checkpointFile,
                ),
        };
      }),
    },
  };
}

function decisionMilestone(
  run: RunView,
  index: number,
): DueMilestone | null {
  const decision = run.decisions[index]!;
  const deliveryId = deliveryIdFor(run.runId, decision.sequence, "decision");
  if (!due(run, deliveryId)) return null;
  return {
    kind: "decision",
    deliveryId,
    laneId: null,
    payload: {
      hashVersion: 1,
      runId: run.runId,
      decision: decision.decision,
      note: decision.note,
      resultingIssueState: decision.resultingIssueState,
    },
  };
}

/**
 * Throws if a recorded pointer is missing or outside the run directory.
 * Reconciler callers in #26/#27 must contain that fail-closed error.
 */
export function dueMilestones(run: RunView): readonly DueMilestone[] {
  if (run.issue === null) return [];

  const milestones: DueMilestone[] = [];
  const start = startMilestone(run);
  if (start !== null) milestones.push(start);
  for (const laneId of run.laneOrder) {
    const blocked = blockedMilestone(run, laneId);
    if (blocked !== null) milestones.push(blocked);
  }
  const complete = completeMilestone(run);
  if (complete !== null) milestones.push(complete);
  for (let index = 0; index < run.decisions.length; index += 1) {
    const decision = decisionMilestone(run, index);
    if (decision !== null) milestones.push(decision);
  }
  return milestones;
}
