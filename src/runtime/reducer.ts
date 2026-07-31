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
  readonly logFile: string;
  readonly stderrFile: string;
  readonly sentinelToken: string;
  readonly kind: "simulated" | "agent";
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
 * committed. A run may only finish once the ledger already carries each lane's
 * process outcome, terminal checkpoint, session outcome, post-flight isolation,
 * contract evaluation, and runner evidence — otherwise the finish status would
 * be computed over facts that do not exist yet. Shared by the reducer's
 * run_finished guard and the runtime's finish committer, so a replayed ledger
 * enforces exactly the order the live controller had to follow.
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
        reason: `agent lane "${laneId}" has no session outcome`,
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
 * underivable raw report, a violated contract, incomplete runner evidence, or
 * a missing result artifact all degrade the run. A run whose evidence is
 * incomplete must never be recorded as the status that means "nothing to see".
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
  // Ledgers written before the terminal-facts ordering existed finished the run
  // ahead of their per-lane facts, so the evidence below is legitimately absent
  // for them and they keep the outcome-only rule — they stay replayable. Every
  // run this runtime writes commits its facts first, because
  // `runFinishEligibility` gates the finish committer, so a live run always
  // reaches the strict test below.
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
      const registration =
        event.data.kind === "agent"
          ? {
              kind: "agent" as const,
              steps: 0,
              stepDelaySeconds: 0,
              axis: event.data.axis,
              agentKind: event.data.agentKind,
              model: event.data.model,
              effort: event.data.effort,
              promptFile: event.data.promptFile,
              bundleHash: event.data.bundleHash,
              rawReportFile: event.data.rawReportFile,
              worktreePath: event.data.worktreePath,
              preassignedSessionId: event.data.preassignedSessionId,
            }
          : {
              // Replayed pre-#7 events carry no `kind`; they are simulated.
              kind: "simulated" as const,
              steps: event.data.steps,
              stepDelaySeconds: event.data.stepDelaySeconds,
              axis: null,
              agentKind: null,
              model: null,
              effort: null,
              promptFile: null,
              bundleHash: null,
              rawReportFile: null,
              worktreePath: null,
              preassignedSessionId: null,
            };
      const lane: LaneView = {
        laneId: event.data.laneId,
        paneId: event.data.paneId,
        logFile: event.data.logFile,
        stderrFile: event.data.stderrFile,
        sentinelToken: event.data.sentinelToken,
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
    case "lane_checkpoint":
      return withLane(state, event, (lane) => {
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
      return withLane(state, event, (lane) => ({
        ...lane,
        controlMode: "human_owned",
      }));
    case "lane_release":
      return withLane(state, event, (lane) => ({
        ...lane,
        controlMode: "managed",
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
