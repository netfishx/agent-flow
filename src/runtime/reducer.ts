import type {
  ContractState,
  ControlMode,
  DeliveryState,
  FixedPoint,
  InputBundleCapturedData,
  IssueRef,
  LabelTransition,
  MilestoneKind,
  OwnerDecision,
  RawReportOutcome,
  RunEvent,
  RunEventActor,
  RunFinishStatus,
  RunOutcomeBreakdown,
  RuntimeState,
  SemanticState,
  VerificationState,
} from "./events.ts";
import type {
  ReviewAgentKind,
  ReviewAxis,
  SessionIdentity,
} from "../review/types.ts";
import type {
  AdvisoryObservation,
  DeliveredControl,
  InteractiveAttemptView,
} from "../interactive/types.ts";
import { verificationPassed } from "../review/verification.ts";
import { checkpointSemanticSignature } from "./checkpoint.ts";

export interface DeliveryView {
  readonly deliveryId: string;
  readonly kind: MilestoneKind;
  readonly laneId: string | null;
  readonly payloadHash: string;
  readonly state: DeliveryState;
  readonly intents: number;
  readonly intendedAt: number;
  readonly settledAt: number | null;
  readonly commentId: number | null;
  readonly commentUrl: string | null;
  /** "not-applicable" until a confirmation records the label outcome. */
  readonly labelTransition: LabelTransition;
  readonly lastFailure: {
    readonly reason: string;
    readonly retryable: boolean;
  } | null;
}

export interface DecisionView {
  readonly sequence: number;
  readonly at: number;
  readonly actor: RunEventActor;
  readonly decision: OwnerDecision;
  readonly note: string;
  readonly resultingIssueState: string | null;
}

export interface BlockedAnchor {
  readonly sequence: number;
  readonly checkpointFile: string;
  readonly blockers: readonly string[];
  readonly next: readonly string[];
  readonly gaps: readonly string[];
}

export interface LaneIsolationView {
  readonly headOk: boolean;
  readonly cleanOk: boolean;
  readonly diffHashOk: boolean;
  readonly detail: string | null;
  readonly at: number;
}

/** Whether a lane's review worktree was released, and why it was kept. */
export interface LaneWorktreeDispositionView {
  readonly disposition: "removed" | "retained";
  readonly retainedReason: string | null;
  readonly worktreePath: string;
  readonly at: number;
}

export interface LaneView {
  readonly laneId: string;
  readonly paneId: string;
  /**
   * Headless-lane artifacts and completion sentinel. Null on an INTERACTIVE
   * lane, which has no captured stdout and no sentinel — an empty string here
   * would be a path that does not exist dressed up as one that does.
   */
  readonly logFile: string | null;
  readonly stderrFile: string | null;
  readonly sentinelToken: string | null;
  readonly kind: "simulated" | "agent" | "interactive";
  /** Root the interactive lane derives each attempt's declared paths under. */
  readonly artifactRoot: string | null;
  /** The repository an interactive lane's worktree was verified against. */
  readonly repoRoot: string | null;
  readonly steps: number;
  readonly stepDelaySeconds: number;
  readonly role?: string;
  /** Agent-lane registration facts; null on simulated lanes. */
  readonly axis: ReviewAxis | null;
  readonly agentKind: ReviewAgentKind | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly promptFile: string | null;
  readonly bundleHash: string | null;
  readonly rawReportFile: string | null;
  readonly worktreePath: string | null;
  readonly preassignedSessionId: string | null;
  readonly isolationPre: LaneIsolationView | null;
  readonly isolationPost: LaneIsolationView | null;
  readonly sessionIdentity: SessionIdentity | null;
  /** Whether the raw artifact landed; null until the runner records it. */
  readonly rawReportOutcome: RawReportOutcome | null;
  readonly worktreeDisposition: LaneWorktreeDispositionView | null;
  readonly runtimeState: RuntimeState;
  readonly semanticState: SemanticState;
  /**
   * Who authored the lane's latest checkpoint: the Agent itself, or the
   * runtime deriving one from the lane's captured bytes. Never conflated.
   */
  readonly checkpointOrigin: "agent" | "runtime" | null;
  readonly contractState: ContractState;
  readonly verificationState: VerificationState;
  readonly controlMode: ControlMode;
  readonly registeredAt: number;
  readonly dispatchIntentAt: number | null;
  readonly dispatchedAt: number | null;
  readonly dispatchedCommand: string | null;
  readonly liveAt: number | null;
  readonly completedAt: number | null;
  readonly checkpointAt: number | null;
  readonly checkpointSemanticSignature: string | null;
  readonly contractEvaluatedAt: number | null;
  readonly verificationRecordedAt: number | null;
  readonly humanInterruptAt: number | null;
  readonly humanCoordinationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly waitMatched: boolean;
  readonly checkpointFile: string | null;
  readonly resultFile: string | null;
  readonly contractErrors: readonly string[];
  readonly evidenceFile: string | null;
  readonly lostCause: string | null;
  readonly startRejection: string | null;
  readonly blockedAnchor: BlockedAnchor | null;
}

export interface RunView {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly splitDirection: "right" | "down";
  readonly tabId: string;
  readonly controllerPaneId: string;
  readonly fixedPoint: FixedPoint | null;
  readonly issue: IssueRef | null;
  readonly issueNodeId: string | null;
  /** The captured immutable input bundle manifest; null when no agent lanes. */
  readonly inputBundle: InputBundleCapturedData | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly checkpointAnnouncedAt: number | null;
  readonly finishedAt: number | null;
  readonly finishStatus: RunFinishStatus | null;
  readonly breakdown: RunOutcomeBreakdown | null;
  readonly controllerEpoch: number;
  readonly controller: {
    readonly controllerId: string;
    readonly pid: number;
  } | null;
  readonly lanes: Readonly<Record<string, LaneView>>;
  readonly laneOrder: readonly string[];
  /**
   * Interactive write-lane attempts, keyed by attemptId and append-only. A
   * retry adds a record; it never rewrites one, so two attempts of one lane
   * are distinguishable from these alone, with no pane inspected.
   */
  readonly interactiveAttempts: Readonly<Record<string, InteractiveAttemptView>>;
  readonly interactiveAttemptOrder: readonly string[];
  /**
   * Every recorded human retry authorization, by the attempt it authorizes a
   * retry PAST, in order. One authorization buys exactly one new attempt: a
   * retry is available only while this list holds more entries for a parent
   * than there are attempts already naming it. Kept as raw events so a fresh
   * controller rebuilds pending authorization from the ledger, not memory.
   */
  readonly retryAuthorizations: readonly string[];
  readonly deliveries: Readonly<Record<string, DeliveryView>>;
  readonly deliveryOrder: readonly string[];
  readonly decisions: readonly DecisionView[];
  readonly startAnchorSequence: number | null;
  readonly finishedSequence: number | null;
  readonly lastAppliedSequence: number;
}

export type RunState =
  | "dispatched"
  | "running"
  | "incomplete"
  | "complete"
  | "partial";

function assertNever(value: never): never {
  throw new Error(`unhandled run event ${JSON.stringify(value)}`);
}

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);

export function projectRunState(run: RunView): RunState {
  if (run.finishStatus !== null) {
    return run.finishStatus === "clean" ? "complete" : "partial";
  }
  const lanes = run.laneOrder.map((laneId) => run.lanes[laneId]!);
  if (
    lanes.length > 0 &&
    lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))
  ) {
    return "incomplete";
  }
  if (
    lanes.some(
      (lane) =>
        lane.runtimeState === "running" ||
        (lane.runtimeState === "pending" && lane.dispatchedAt !== null),
    )
  ) {
    return "running";
  }
  return "dispatched";
}

function assertNonTerminal(lane: LaneView, eventType: RunEvent["type"]): void {
  if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
    throw new Error(
      `${eventType} cannot follow terminal lane state "${lane.runtimeState}"`,
    );
  }
}

function laneFor(state: RunView, event: RunEvent): LaneView {
  if (event.laneId === undefined) {
    throw new Error(`event "${event.type}" requires laneId`);
  }
  const lane = state.lanes[event.laneId];
  if (!lane) {
    throw new Error(`unknown laneId "${event.laneId}" in run "${state.runId}"`);
  }
  return lane;
}

function withLane(
  state: RunView,
  event: RunEvent,
  update: (lane: LaneView) => LaneView,
): RunView {
  const lane = laneFor(state, event);
  return {
    ...state,
    updatedAt: event.at,
    lastAppliedSequence: event.sequence,
    lanes: { ...state.lanes, [lane.laneId]: update(lane) },
  };
}

function attemptFor(state: RunView, attemptId: string): InteractiveAttemptView {
  const attempt = state.interactiveAttempts[attemptId];
  if (!attempt) throw new Error(`unknown attemptId "${attemptId}"`);
  return attempt;
}

/**
 * Apply a patch to one attempt. Every caller goes through here, so an attempt
 * is only ever extended in place — there is no path that replaces or deletes a
 * prior attempt's record.
 */
function withAttempt(
  state: RunView,
  event: RunEvent,
  attemptId: string,
  update: (attempt: InteractiveAttemptView) => InteractiveAttemptView,
): RunView {
  const attempt = attemptFor(state, attemptId);
  return {
    ...state,
    updatedAt: event.at,
    lastAppliedSequence: event.sequence,
    interactiveAttempts: {
      ...state.interactiveAttempts,
      [attemptId]: update(attempt),
    },
  };
}

function advisoryOf(
  data: {
    readonly status: AdvisoryObservation["status"];
    readonly source: AdvisoryObservation["source"];
    readonly paneId: string;
    readonly message: string | null;
  },
  at: number,
): AdvisoryObservation {
  return {
    status: data.status,
    source: data.source,
    paneId: data.paneId,
    at,
    ...(data.message === null ? {} : { message: data.message }),
  };
}

function withRun(state: RunView, event: RunEvent, patch: Partial<RunView>): RunView {
  return {
    ...state,
    ...patch,
    updatedAt: event.at,
    lastAppliedSequence: event.sequence,
  };
}

function assertIssueBound(state: RunView, eventType: RunEvent["type"]): void {
  if (state.issue === null) {
    throw new Error(`${eventType} cannot apply to an unbound run`);
  }
}

function deliveryFor(state: RunView, deliveryId: string): DeliveryView {
  const delivery = state.deliveries[deliveryId];
  if (!delivery) {
    throw new Error(`unknown deliveryId "${deliveryId}"`);
  }
  return delivery;
}

/**
 * Whether every per-lane terminal fact a finish status depends on has been
 * committed: each lane's process outcome, terminal checkpoint, session outcome,
 * post-flight isolation, contract evaluation, and runner evidence. A finish
 * status computed before those exist would be computed over facts that do not
 * exist yet.
 *
 * The ordering this expresses is enforced on the LIVE SUBMISSION PATH only —
 * the runtime's finish committer refuses to commit `run_finished` until this
 * returns ready. Replay does NOT enforce it: a reducer that rejected a
 * `run_finished` arriving ahead of its facts would make every pre-#7 ledger
 * unloadable, including the retained first formal run. `expectedFinishStatus`
 * therefore uses this only to choose which status rule applies, and falls back
 * to legacy outcome-only validation for a ledger whose facts are absent at
 * finish time. That is a deliberate compatibility strategy, not an oversight;
 * tightening it would need an event `schemaVersion` bump, a version-dispatching
 * reducer, and a migration story for the retained ledgers.
 */
export type FinishEligibility =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export function runFinishEligibility(state: RunView): FinishEligibility {
  if (state.laneOrder.length === 0) {
    return { ready: false, reason: "the run has no lanes" };
  }
  for (const laneId of state.laneOrder) {
    const lane = state.lanes[laneId]!;
    if (!TERMINAL_RUNTIME.has(lane.runtimeState)) {
      return {
        ready: false,
        reason: `lane "${laneId}" is not runtime-terminal`,
      };
    }
    if (lane.contractEvaluatedAt === null) {
      return {
        ready: false,
        reason: `lane "${laneId}" has no contract evaluation`,
      };
    }
    if (lane.verificationRecordedAt === null) {
      return {
        ready: false,
        reason: `lane "${laneId}" has no runner evidence`,
      };
    }
    if (lane.kind !== "agent") continue;
    if (lane.sessionIdentity === null) {
      return {
        ready: false,
        reason: `agent lane "${laneId}" has no session identity`,
      };
    }
    // A lane that never started has no worktree to verify and nothing to
    // derive a terminal record from; every lane that ran must carry both.
    if (lane.runtimeState === "failed_to_start") continue;
    if (lane.isolationPost === null) {
      return {
        ready: false,
        reason: `agent lane "${laneId}" has no post-flight isolation record`,
      };
    }
    if (lane.checkpointAt === null) {
      return {
        ready: false,
        reason: `agent lane "${laneId}" has no terminal checkpoint`,
      };
    }
  }
  return { ready: true };
}

/**
 * The one finish-status rule, shared by the reducer's run_finished guard and
 * the runtime's finish committer. Fail-closed on isolation: an agent lane that
 * reached a terminal state through execution must carry a PASSING post-flight
 * verification, or the whole run is `invalid`. (`failed_to_start` lanes never
 * ran, so they degrade the run without invalidating it.)
 *
 * `clean` additionally requires every lane's own record to be clean: a lost or
 * underivable raw report, a violated contract, or a missing result artifact all
 * degrade the run. A run whose evidence is incomplete must never be recorded as
 * the status that means "nothing to see".
 *
 * Two status rules therefore exist, selected by whether the terminal facts are
 * present — NOT by a replay-time ordering check. See `runFinishEligibility`:
 * this function never rejects an out-of-order `run_finished`, because rejecting
 * one would make pre-#7 ledgers unloadable.
 */
export function expectedFinishStatus(state: RunView): RunFinishStatus {
  const lanes = state.laneOrder.map((laneId) => state.lanes[laneId]!);
  const isolationBroken = lanes.some(
    (lane) =>
      lane.kind === "agent" &&
      TERMINAL_RUNTIME.has(lane.runtimeState) &&
      lane.runtimeState !== "failed_to_start" &&
      (lane.isolationPost === null || !verificationPassed(lane.isolationPost)),
  );
  if (isolationBroken) return "invalid";
  const breakdown = projectRunOutcomeBreakdown(state);
  if (breakdown.exitedZero !== lanes.length) return "degraded";
  // Legacy status validation. Ledgers written before the terminal-facts
  // ordering existed finished the run ahead of their per-lane facts, so the
  // evidence below is legitimately absent for them; they keep the outcome-only
  // rule and stay replayable. This branch is a compatibility path, not a check:
  // reaching it is not treated as an error. Every run this runtime writes
  // commits its facts first, because the live finish committer is gated on
  // `runFinishEligibility`, so a live run always reaches the strict test below.
  if (!runFinishEligibility(state).ready) return "clean";
  // Exactly three conditions cost a run its `clean`: a violated contract, a
  // raw report that was not captured, and a missing result artifact. Runner
  // evidence completeness is deliberately NOT one of them — it reports how well
  // the run was observed, not whether reviewer output survived.
  const evidenceBroken = lanes.some(
    (lane) =>
      lane.contractState !== "satisfied" ||
      lane.resultFile === null ||
      (lane.kind === "agent" && lane.rawReportOutcome !== "captured"),
  );
  return evidenceBroken ? "degraded" : "clean";
}

export function projectRunOutcomeBreakdown(
  state: RunView,
): RunOutcomeBreakdown {
  const lanes = state.laneOrder.map((laneId) => state.lanes[laneId]!);
  return {
    exitedZero: lanes.filter(
      (lane) => lane.runtimeState === "exited" && lane.exitCode === 0,
    ).length,
    exitedNonZero: lanes.filter(
      (lane) => lane.runtimeState === "exited" && lane.exitCode !== 0,
    ).length,
    crashed: lanes.filter((lane) => lane.runtimeState === "crashed").length,
    lost: lanes.filter((lane) => lane.runtimeState === "lost").length,
    failedToStart: lanes.filter(
      (lane) => lane.runtimeState === "failed_to_start",
    ).length,
  };
}

function sameBreakdown(
  left: RunOutcomeBreakdown,
  right: RunOutcomeBreakdown,
): boolean {
  const keys = [
    "exitedZero",
    "exitedNonZero",
    "crashed",
    "lost",
    "failedToStart",
  ] as const;
  const actualKeys = Object.keys(left);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => actualKeys.includes(key)) &&
    left.exitedZero === right.exitedZero &&
    left.exitedNonZero === right.exitedNonZero &&
    left.crashed === right.crashed &&
    left.lost === right.lost &&
    left.failedToStart === right.failedToStart
  );
}

export function reduce(state: RunView | undefined, event: RunEvent): RunView {
  const expectedSequence = (state?.lastAppliedSequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(
      `run "${event.runId}" sequence ${event.sequence} does not follow ${expectedSequence - 1}`,
    );
  }
  if (event.eventId !== `${event.runId}#${event.sequence}`) {
    throw new Error(`invalid eventId "${event.eventId}" for run sequence`);
  }
  if (state && event.runId !== state.runId) {
    throw new Error(`event runId "${event.runId}" does not match "${state.runId}"`);
  }

  if (event.type === "run_started") {
    if (state) throw new Error(`run "${event.runId}" is already started`);
    if (!("issue" in event.data)) {
      throw new Error('run_started event is missing required "issue" field');
    }
    const issue = event.data.issue;
    return {
      schemaVersion: 1,
      runId: event.runId,
      workflow: event.data.workflow,
      workspace: event.data.workspace,
      cwd: event.data.cwd,
      splitDirection: event.data.splitDirection,
      tabId: event.data.tabId,
      controllerPaneId: event.data.controllerPaneId,
      fixedPoint: event.data.fixedPoint,
      issue: issue === null ? null : { ...issue },
      issueNodeId: null,
      inputBundle: null,
      startedAt: event.at,
      updatedAt: event.at,
      checkpointAnnouncedAt: null,
      finishedAt: null,
      finishStatus: null,
      breakdown: null,
      controllerEpoch: event.controllerEpoch,
      controller: null,
      lanes: {},
      laneOrder: [],
      interactiveAttempts: {},
      interactiveAttemptOrder: [],
      retryAuthorizations: [],
      deliveries: {},
      deliveryOrder: [],
      decisions: [],
      startAnchorSequence: null,
      finishedSequence: null,
      lastAppliedSequence: event.sequence,
    };
  }

  if (!state) {
    throw new Error(`first event for run "${event.runId}" must be run_started`);
  }

  switch (event.type) {
    case "input_bundle_captured": {
      if (state.inputBundle !== null) {
        throw new Error("duplicate input_bundle_captured");
      }
      return withRun(state, event, {
        inputBundle: {
          files: [...event.data.files],
          bundleHash: event.data.bundleHash,
        },
      });
    }
    case "lane_registered": {
      if (event.data.laneId !== event.laneId) {
        throw new Error("lane_registered laneId does not match its envelope");
      }
      if (state.lanes[event.laneId]) {
        throw new Error(`lane "${event.laneId}" is already registered`);
      }
      const data = event.data;
      const registration =
        data.kind === "agent"
          ? {
              kind: "agent" as const,
              steps: 0,
              stepDelaySeconds: 0,
              axis: data.axis,
              agentKind: data.agentKind,
              model: data.model,
              effort: data.effort,
              promptFile: data.promptFile,
              bundleHash: data.bundleHash,
              rawReportFile: data.rawReportFile,
              worktreePath: data.worktreePath,
              preassignedSessionId: data.preassignedSessionId,
              artifactRoot: null,
              repoRoot: null,
              logFile: data.logFile,
              stderrFile: data.stderrFile,
              sentinelToken: data.sentinelToken,
            }
          : data.kind === "interactive"
            ? {
                // An interactive lane has no captured stdout and no sentinel,
                // so it registers none. Brief, session, and result paths belong
                // to an ATTEMPT: a retry allocates new ones under artifactRoot,
                // and the lane outlives every attempt.
                kind: "interactive" as const,
                steps: 0,
                stepDelaySeconds: 0,
                axis: null,
                agentKind: data.agentKind,
                model: data.model,
                effort: data.effort,
                promptFile: null,
                bundleHash: null,
                rawReportFile: null,
                worktreePath: data.worktreePath,
                preassignedSessionId: null,
                artifactRoot: data.artifactRoot,
                repoRoot: data.repoRoot,
                logFile: null,
                stderrFile: null,
                sentinelToken: null,
              }
            : {
                // Replayed pre-#7 events carry no `kind`; they are simulated.
                kind: "simulated" as const,
                steps: data.steps,
                stepDelaySeconds: data.stepDelaySeconds,
                axis: null,
                agentKind: null,
                model: null,
                effort: null,
                promptFile: null,
                bundleHash: null,
                rawReportFile: null,
                worktreePath: null,
                preassignedSessionId: null,
                artifactRoot: null,
                repoRoot: null,
                logFile: data.logFile,
                stderrFile: data.stderrFile,
                sentinelToken: data.sentinelToken,
              };
      const lane: LaneView = {
        laneId: event.data.laneId,
        paneId: event.data.paneId,
        ...(event.data.role === undefined ? {} : { role: event.data.role }),
        ...registration,
        isolationPre: null,
        isolationPost: null,
        sessionIdentity: null,
        rawReportOutcome: null,
        worktreeDisposition: null,
        runtimeState: "pending",
        semanticState: "unknown",
        checkpointOrigin: null,
        contractState: "unknown",
        verificationState: "unverified",
        controlMode: "managed",
        registeredAt: event.at,
        dispatchIntentAt: null,
        dispatchedAt: null,
        dispatchedCommand: null,
        liveAt: null,
        completedAt: null,
        checkpointAt: null,
        checkpointSemanticSignature: null,
        contractEvaluatedAt: null,
        verificationRecordedAt: null,
        humanInterruptAt: null,
        humanCoordinationMs: null,
        exitCode: null,
        signal: null,
        waitMatched: false,
        checkpointFile: null,
        resultFile: null,
        contractErrors: [],
        evidenceFile: null,
        lostCause: null,
        startRejection: null,
        blockedAnchor: null,
      };
      return withRun(state, event, {
        lanes: { ...state.lanes, [event.laneId]: lane },
        laneOrder: [...state.laneOrder, event.laneId],
      });
    }
    case "lane_dispatch_intent": {
      const next = withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        if (lane.dispatchIntentAt !== null) {
          throw new Error("duplicate lane_dispatch_intent");
        }
        return {
          ...lane,
          runtimeState: "pending",
          dispatchIntentAt: event.at,
        };
      });
      return {
        ...next,
        startAnchorSequence: state.startAnchorSequence ?? event.sequence,
      };
    }
    case "lane_dispatched":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        if (lane.dispatchedAt !== null) {
          throw new Error("duplicate lane_dispatched");
        }
        return {
          ...lane,
          runtimeState: "pending",
          dispatchedAt: event.at,
          dispatchedCommand: event.data.command,
        };
      });
    case "lane_live":
      return withLane(state, event, (lane) => {
        if (lane.runtimeState !== "pending") {
          throw new Error(
            `lane_live requires pending lane state, received "${lane.runtimeState}"`,
          );
        }
        return {
          ...lane,
          runtimeState: "running",
          liveAt: event.at,
        };
      });
    case "lane_checkpoint": {
      const attemptId = event.data.attemptId;
      const withCheckpoint = withLane(state, event, (lane) => {
        const blockedAnchor =
          lane.blockedAnchor === null && event.data.semanticState === "blocked"
            ? {
                sequence: event.sequence,
                checkpointFile: event.data.checkpointFile,
                blockers: [...(event.data.blockers ?? [])],
                next: [...(event.data.next ?? [])],
                gaps: [...(event.data.gaps ?? [])],
              }
            : lane.blockedAnchor;
        return {
          ...lane,
          semanticState: event.data.semanticState,
          checkpointFile: event.data.checkpointFile,
          checkpointAt: event.at,
          checkpointOrigin: event.actor === "runtime" ? "runtime" : "agent",
          checkpointSemanticSignature: checkpointSemanticSignature({
            status: event.data.semanticState,
            blockers: event.data.blockers,
            next: event.data.next,
            gaps: event.data.gaps,
          }),
          blockedAnchor,
        };
      });
      if (attemptId === undefined) return withCheckpoint;
      // An interactive attempt's checkpoint is AGENT-authored at a declared
      // path. `origin` travels with it, so a runtime-derived `unknown` record
      // can never be rendered as the Agent's own claim. Write-once: a second
      // collection would overwrite the record the first one preserved.
      return withAttempt(withCheckpoint, event, attemptId, (attempt) => {
        if (attempt.agentCheckpoint !== null) {
          throw new Error(
            `attempt "${attemptId}" already has a checkpoint; it is write-once`,
          );
        }
        return {
          ...attempt,
          agentCheckpoint: {
            file: event.data.checkpointFile,
            semanticState: event.data.semanticState,
            origin: event.actor === "runtime" ? "runtime" : "agent",
            at: event.at,
          },
        };
      });
    }
    case "lane_exited":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "exited",
          completedAt: event.at,
          exitCode: event.data.exitCode,
          signal: event.data.signal ?? null,
          waitMatched: event.data.waitMatched ?? lane.waitMatched,
        };
      });
    case "lane_crashed":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "crashed",
          completedAt: event.at,
          exitCode: null,
        };
      });
    case "lane_lost":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "lost",
          completedAt: event.at,
          lostCause: event.data.cause,
        };
      });
    case "lane_failed_to_start":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "failed_to_start",
          completedAt: event.at,
          startRejection: event.data.rejection,
          dispatchedCommand: event.data.command,
        };
      });
    case "lane_isolation_verified": {
      const data = event.data;
      return withLane(state, event, (lane) => {
        if (lane.kind !== "agent") {
          throw new Error(
            "lane_isolation_verified applies to agent lanes only",
          );
        }
        const view: LaneIsolationView = {
          headOk: data.headOk,
          cleanOk: data.cleanOk,
          diffHashOk: data.diffHashOk,
          detail: data.detail,
          at: event.at,
        };
        if (data.phase === "pre") {
          if (lane.isolationPre !== null) {
            throw new Error("duplicate pre-flight lane_isolation_verified");
          }
          return { ...lane, isolationPre: view };
        }
        if (lane.isolationPost !== null) {
          throw new Error("duplicate post-flight lane_isolation_verified");
        }
        return { ...lane, isolationPost: view };
      });
    }
    case "lane_session_recorded":
      return withLane(state, event, (lane) => {
        if (lane.kind !== "agent") {
          throw new Error("lane_session_recorded applies to agent lanes only");
        }
        if (lane.sessionIdentity !== null) {
          throw new Error("duplicate lane_session_recorded");
        }
        return { ...lane, sessionIdentity: event.data.session };
      });
    case "lane_contract_evaluated":
      return withLane(state, event, (lane) => ({
        ...lane,
        contractState: event.data.contractState,
        resultFile: event.data.resultFile,
        contractErrors: [...event.data.errors],
        contractEvaluatedAt: event.at,
      }));
    case "lane_verification_recorded":
      return withLane(state, event, (lane) => ({
        ...lane,
        verificationState: event.data.verificationState,
        evidenceFile: event.data.evidenceFile,
        // Absent on replayed pre-#7 events; those runs had no raw artifact.
        rawReportOutcome: event.data.rawReportOutcome ?? null,
        verificationRecordedAt: event.at,
      }));
    case "lane_worktree_disposition":
      return withLane(state, event, (lane) => {
        if (lane.kind !== "agent") {
          throw new Error(
            "lane_worktree_disposition applies to agent lanes only",
          );
        }
        if (lane.worktreeDisposition !== null) {
          throw new Error("duplicate lane_worktree_disposition");
        }
        return {
          ...lane,
          worktreeDisposition: {
            disposition: event.data.disposition,
            retainedReason: event.data.retainedReason,
            worktreePath: event.data.worktreePath,
            at: event.at,
          },
        };
      });
    case "checkpoint_announced":
      return withRun(state, event, { checkpointAnnouncedAt: event.at });
    case "human_interrupt": {
      if (event.data.laneId !== event.laneId) {
        throw new Error("human_interrupt laneId does not match its envelope");
      }
      const firstCoordination =
        state.checkpointAnnouncedAt === null
          ? null
          : event.at - state.checkpointAnnouncedAt;
      return withLane(state, event, (lane) => ({
        ...lane,
        humanInterruptAt: lane.humanInterruptAt ?? event.at,
        humanCoordinationMs:
          lane.humanInterruptAt !== null
            ? lane.humanCoordinationMs
            : firstCoordination,
      }));
    }
    case "lane_takeover":
    case "lane_release": {
      const controlMode: ControlMode =
        event.type === "lane_takeover" ? "human_owned" : "managed";
      const next = withLane(state, event, (lane) => ({ ...lane, controlMode }));
      // The lane is the source of truth for ownership; each of its attempts
      // mirrors it so an attempt record reads correctly on its own.
      return {
        ...next,
        interactiveAttempts: Object.fromEntries(
          Object.entries(next.interactiveAttempts).map(([id, attempt]) => [
            id,
            attempt.laneId === event.laneId
              ? { ...attempt, controlMode }
              : attempt,
          ]),
        ),
      };
    }
    case "interactive_attempt_started": {
      const data = event.data;
      const lane = laneFor(state, event);
      if (lane.kind !== "interactive") {
        throw new Error(
          "interactive_attempt_started applies to interactive lanes only",
        );
      }
      if (state.interactiveAttempts[data.attemptId]) {
        throw new Error(`attempt "${data.attemptId}" is already started`);
      }
      if (
        data.parentAttemptId !== null &&
        !state.interactiveAttempts[data.parentAttemptId]
      ) {
        throw new Error(
          `attempt "${data.attemptId}" names unknown parent "${data.parentAttemptId}"`,
        );
      }
      const attempt: InteractiveAttemptView = {
        attemptId: data.attemptId,
        ordinal: data.ordinal,
        runId: state.runId,
        laneId: lane.laneId,
        parentAttemptId: data.parentAttemptId,
        agentKind: data.agentKind,
        model: data.model,
        effort: data.effort,
        paneId: data.paneId,
        agentName: null,
        session: {
          kind: "unavailable",
          reason: "the attempt has not bound an agent yet",
        },
        worktreePath: data.worktreePath,
        briefFile: data.briefFile,
        checkpointFile: data.checkpointFile,
        resultPointer: data.resultPointer,
        startedAt: event.at,
        endedAt: null,
        endReason: null,
        endCause: null,
        exitCode: null,
        supersededBy: null,
        authorization: { ...data.authorization, at: event.at },
        agentCheckpoint: null,
        runnerEvidence: [],
        reconciliation: null,
        advisory: [],
        controlMode: lane.controlMode,
        steerSubmissions: 0,
        steerObservations: 0,
        lastCancelTurnAt: null,
        lastAbortAt: null,
        lastControl: null,
      };
      // `supersededBy` is DERIVED here from the child naming its parent. There
      // is no separate supersede event, so the two directions cannot disagree.
      const parent =
        data.parentAttemptId === null
          ? null
          : state.interactiveAttempts[data.parentAttemptId]!;
      return withRun(state, event, {
        interactiveAttempts: {
          ...state.interactiveAttempts,
          ...(parent === null
            ? {}
            : { [parent.attemptId]: { ...parent, supersededBy: data.attemptId } }),
          [data.attemptId]: attempt,
        },
        interactiveAttemptOrder: [
          ...state.interactiveAttemptOrder,
          data.attemptId,
        ],
      });
    }
    case "interactive_attempt_bound":
      return withAttempt(state, event, event.data.attemptId, (attempt) => {
        if (attempt.agentName !== null) {
          throw new Error("duplicate interactive_attempt_bound");
        }
        if (attempt.endReason !== null) {
          throw new Error(
            `attempt "${attempt.attemptId}" ended as "${attempt.endReason}" and cannot bind an agent`,
          );
        }
        return {
          ...attempt,
          agentName: event.data.agentName,
          session: event.data.session,
        };
      });
    case "interactive_attempt_ended":
      return withAttempt(state, event, event.data.attemptId, (attempt) => {
        // An end is PERMANENT. No second end, whatever the first one was —
        // a start failure is an end like any other, and overwriting it would
        // delete the only record of why the attempt never ran.
        if (attempt.endReason !== null) {
          throw new Error(
            `attempt "${attempt.attemptId}" already ended as "${attempt.endReason}"`,
          );
        }
        return {
          ...attempt,
          endedAt: event.at,
          endReason: event.data.endReason,
          endCause: event.data.cause,
          exitCode: event.data.exitCode,
        };
      });
    case "interactive_attempt_reconciled":
      // Reconciliation is a repeatable OBSERVATION: the projection keeps the
      // latest and the event log keeps the history. It never revives an ended
      // attempt — `endReason` is not touched here, and the control-plane guard
      // reads it, so a later `live` sighting restores nothing.
      return withAttempt(state, event, event.data.attemptId, (attempt) => ({
        ...attempt,
        // The pane id is re-read rather than assumed: a pane moved between
        // workspaces receives a new workspace-qualified id.
        paneId: event.data.paneId,
        reconciliation: {
          outcome: event.data.outcome,
          at: event.at,
          detail: event.data.detail,
        },
      }));
    case "interactive_retry_authorized": {
      // The authorization stands alone in the ledger so it survives a
      // controller that dies before the new attempt starts.
      const parent = event.data.parentAttemptId;
      if (!state.interactiveAttempts[parent]) {
        throw new Error(
          `interactive_retry_authorized names unknown attempt "${parent}"`,
        );
      }
      return withRun(state, event, {
        retryAuthorizations: [...state.retryAuthorizations, parent],
      });
    }
    case "interactive_runner_evidence":
      return withAttempt(state, event, event.data.attemptId, (attempt) => {
        if (
          attempt.runnerEvidence.some(
            (record) => record.evidenceId === event.data.evidenceId,
          )
        ) {
          throw new Error(
            `duplicate runner evidence "${event.data.evidenceId}"`,
          );
        }
        return {
          ...attempt,
          runnerEvidence: [
            ...attempt.runnerEvidence,
            {
              evidenceId: event.data.evidenceId,
              attemptId: event.data.attemptId,
              command: event.data.command,
              logFile: event.data.logFile,
              paneId: event.data.paneId,
              exitCode: event.data.exitCode,
              startedAt: event.data.startedAt,
              endedAt: event.data.endedAt,
            },
          ],
        };
      });
    case "lane_steer_submitted":
      return withAttempt(state, event, event.data.attemptId, (attempt) => ({
        ...attempt,
        steerSubmissions: attempt.steerSubmissions + 1,
      }));
    case "lane_steer_observed":
      return withAttempt(state, event, event.data.attemptId, (attempt) => ({
        ...attempt,
        steerObservations: attempt.steerObservations + 1,
        // The observed state joins the ADVISORY channel. It is recorded, and
        // it is unreadable by any outcome projection.
        advisory:
          event.data.observedStatus === null || event.data.source === null
            ? attempt.advisory
            : [
                ...attempt.advisory,
                advisoryOf(
                  {
                    status: event.data.observedStatus,
                    source: event.data.source,
                    paneId: attempt.paneId,
                    message: null,
                  },
                  event.at,
                ),
              ],
      }));
    // Control INTENT, recorded before the Herdr call so a controller that dies
    // mid-call still leaves the request behind. Delivery is a separate fact,
    // paired to this intent by `controlId`.
    case "lane_cancel_turn":
    case "lane_abort_session": {
      const control: DeliveredControl =
        event.type === "lane_cancel_turn" ? "cancel-turn" : "abort-session";
      const method =
        event.type === "lane_cancel_turn"
          ? ("send-keys" as const)
          : ("signal-process-group" as const);
      const controlId = event.data.controlId;
      return withAttempt(state, event, event.data.attemptId, (attempt) => {
        if (attempt.lastControl?.controlId === controlId) {
          throw new Error(`duplicate control intent "${controlId}"`);
        }
        return {
          ...attempt,
          ...(control === "cancel-turn"
            ? { lastCancelTurnAt: event.at }
            : { lastAbortAt: event.at }),
          lastControl: {
            controlId,
            control,
            method,
            requestedAt: event.at,
            delivery: null,
          },
        };
      });
    }
    case "lane_control_delivered":
      return withAttempt(state, event, event.data.attemptId, (attempt) => {
        // A delivery is meaningless without the request it carried out, and a
        // second one would overwrite the first record of what happened.
        const pending = attempt.lastControl;
        if (pending === null || pending.controlId !== event.data.controlId) {
          throw new Error(
            `lane_control_delivered "${event.data.controlId}" has no pending control intent`,
          );
        }
        if (pending.delivery !== null) {
          throw new Error(
            `delivery for control "${event.data.controlId}" was already recorded`,
          );
        }
        if (pending.control !== event.data.control) {
          throw new Error(
            `delivery control "${event.data.control}" does not match intent "${pending.control}"`,
          );
        }
        return {
        ...attempt,
        lastControl: {
          ...pending,
          delivery: {
            delivered: event.data.delivered,
            detail: event.data.detail,
            observedStatus: event.data.observedStatus,
            at: event.at,
          },
        },
        // A status seen after the effect is still ADVISORY, and joins that
        // channel rather than becoming a delivery confirmation of its own.
        advisory:
          event.data.observedStatus === null
            ? attempt.advisory
            : [
                ...attempt.advisory,
                advisoryOf(
                  {
                    status: event.data.observedStatus,
                    source: "herdr-detection",
                    paneId: attempt.paneId,
                    message: null,
                  },
                  event.at,
                ),
              ],
      };
      });
    case "lane_advisory_state_observed":
      return withAttempt(state, event, event.data.attemptId, (attempt) => ({
        ...attempt,
        advisory: [...attempt.advisory, advisoryOf(event.data, event.at)],
      }));
    case "controller_attached":
      return withRun(state, event, {
        controllerEpoch: event.data.epoch,
        controller: {
          controllerId: event.data.controllerId,
          pid: event.data.pid,
        },
      });
    case "issue_binding_resolved":
      assertIssueBound(state, event.type);
      if (
        state.issueNodeId !== null &&
        state.issueNodeId !== event.data.issueNodeId
      ) {
        throw new Error(
          "issue_binding_resolved cannot replace a different issue node id",
        );
      }
      return withRun(state, event, { issueNodeId: event.data.issueNodeId });
    case "issue_delivery_intended": {
      assertIssueBound(state, event.type);
      const delivery = state.deliveries[event.data.deliveryId];
      if (!delivery) {
        const intended: DeliveryView = {
          ...event.data,
          state: "pending",
          intents: 1,
          intendedAt: event.at,
          settledAt: null,
          commentId: null,
          commentUrl: null,
          labelTransition: "not-applicable",
          lastFailure: null,
        };
        return withRun(state, event, {
          deliveries: {
            ...state.deliveries,
            [event.data.deliveryId]: intended,
          },
          deliveryOrder: [...state.deliveryOrder, event.data.deliveryId],
        });
      }
      if (delivery.payloadHash !== event.data.payloadHash) {
        throw new Error(
          `issue_delivery_intended payloadHash differs for delivery "${delivery.deliveryId}"`,
        );
      }
      if (delivery.kind !== event.data.kind) {
        throw new Error(
          `issue_delivery_intended kind differs for delivery "${delivery.deliveryId}"`,
        );
      }
      if (delivery.laneId !== event.data.laneId) {
        throw new Error(
          `issue_delivery_intended laneId differs for delivery "${delivery.deliveryId}"`,
        );
      }
      if (delivery.state !== "failed") {
        throw new Error(
          `issue_delivery_intended requires absent or failed delivery, received "${delivery.state}"`,
        );
      }
      return withRun(state, event, {
        deliveries: {
          ...state.deliveries,
          [delivery.deliveryId]: {
            ...delivery,
            state: "pending",
            intents: delivery.intents + 1,
            intendedAt: event.at,
            settledAt: null,
            labelTransition: "not-applicable",
          },
        },
      });
    }
    case "issue_delivery_confirmed": {
      assertIssueBound(state, event.type);
      const delivery = deliveryFor(state, event.data.deliveryId);
      if (delivery.state !== "pending") {
        throw new Error(
          `issue_delivery_confirmed requires pending delivery, received "${delivery.state}"`,
        );
      }
      return withRun(state, event, {
        deliveries: {
          ...state.deliveries,
          [delivery.deliveryId]: {
            ...delivery,
            state: "delivered",
            settledAt: event.at,
            commentId: event.data.commentId,
            commentUrl: event.data.commentUrl,
            labelTransition: event.data.labelTransition,
          },
        },
      });
    }
    case "issue_delivery_failed": {
      assertIssueBound(state, event.type);
      const delivery = deliveryFor(state, event.data.deliveryId);
      if (delivery.state !== "pending") {
        throw new Error(
          `issue_delivery_failed requires pending delivery, received "${delivery.state}"`,
        );
      }
      return withRun(state, event, {
        deliveries: {
          ...state.deliveries,
          [delivery.deliveryId]: {
            ...delivery,
            state: "failed",
            settledAt: event.at,
            labelTransition: "not-applicable",
            lastFailure: {
              reason: event.data.reason,
              retryable: event.data.retryable,
            },
          },
        },
      });
    }
    case "owner_decision_recorded": {
      if (event.actor !== "human") {
        throw new Error("owner_decision_recorded requires human actor");
      }
      return withRun(state, event, {
        decisions: [
          ...state.decisions,
          {
            sequence: event.sequence,
            at: event.at,
            actor: event.actor,
            ...event.data,
          },
        ],
      });
    }
    case "run_finished": {
      if (state.finishStatus !== null) {
        throw new Error("duplicate run_finished");
      }
      if (state.laneOrder.length === 0) {
        throw new Error("run_finished requires at least one lane");
      }
      const lanes = state.laneOrder.map((laneId) => state.lanes[laneId]!);
      if (!lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))) {
        throw new Error("run_finished requires every lane to be runtime-terminal");
      }
      const breakdown = projectRunOutcomeBreakdown(state);
      if (!sameBreakdown(event.data.breakdown, breakdown)) {
        throw new Error("run_finished breakdown does not match current lane states");
      }
      const expectedStatus = expectedFinishStatus(state);
      if (event.data.status !== expectedStatus) {
        throw new Error(
          `run_finished status must be "${expectedStatus}" for current lane states`,
        );
      }
      return withRun(state, event, {
        finishedAt: event.at,
        finishStatus: event.data.status,
        breakdown: { ...event.data.breakdown },
        finishedSequence: event.sequence,
      });
    }
    default:
      return assertNever(event);
  }
}
