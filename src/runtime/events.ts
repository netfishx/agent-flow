// The ledger's schema depends on the review vocabulary only — never on the
// brief assembler or the command builders that also speak it.
import type {
  BundleFileRecord,
  ReviewAgentKind,
  ReviewAxis,
  SessionIdentity,
} from "../review/types.ts";
import type {
  AdvisoryAgentStatus,
  AdvisoryStateSource,
  AttemptEndReason,
  DeliveredControl,
  InteractiveAgentKind,
  ReconciliationOutcome,
  SteerObservationOutcome,
} from "../interactive/types.ts";

export type RunEventType =
  | "run_started"
  | "input_bundle_captured"
  | "lane_registered"
  | "lane_dispatch_intent"
  | "lane_dispatched"
  | "lane_live"
  | "lane_checkpoint"
  | "lane_exited"
  | "lane_crashed"
  | "lane_lost"
  | "lane_failed_to_start"
  | "lane_isolation_verified"
  | "lane_session_recorded"
  | "lane_contract_evaluated"
  | "lane_verification_recorded"
  | "lane_worktree_disposition"
  | "checkpoint_announced"
  | "human_interrupt"
  | "lane_takeover"
  | "lane_release"
  | "interactive_attempt_started"
  | "interactive_attempt_bound"
  | "interactive_attempt_ended"
  | "interactive_attempt_reconciled"
  | "interactive_retry_authorized"
  | "interactive_runner_evidence"
  | "lane_steer_submitted"
  | "lane_steer_observed"
  | "lane_cancel_turn"
  | "lane_abort_session"
  | "lane_control_delivered"
  | "lane_advisory_state_observed"
  | "controller_attached"
  | "issue_binding_resolved"
  | "issue_delivery_intended"
  | "issue_delivery_confirmed"
  | "issue_delivery_failed"
  | "owner_decision_recorded"
  | "run_finished";

export type RunEventActor =
  | "runtime"
  | "agent"
  | "validator"
  | "runner"
  | "human";

export type RuntimeState =
  | "pending"
  | "running"
  | "exited"
  | "crashed"
  | "lost"
  | "failed_to_start";

export type SemanticState =
  | "unknown"
  | "working"
  | "complete"
  | "partial"
  | "blocked";

export type ContractState = "unknown" | "satisfied" | "violated";
export type VerificationState = "unverified" | "verified" | "failed";
/**
 * The runner's objective fact about a lane's first-class raw artifact:
 * `captured` means the bytes are on disk and yielded report text, `missing`
 * means no artifact exists, `underivable` means the bytes exist but no report
 * text could be derived from them. Only `captured` licenses cleanup.
 */
export type RawReportOutcome = "captured" | "missing" | "underivable";
export type ControlMode = "managed" | "human_owned";
/**
 * `invalid` marks a run whose reviewer isolation cannot be trusted: an agent
 * lane reached a terminal state through execution with a failed — or missing —
 * post-flight verification. An invalid run is never carried forward; a rerun
 * runs under a new runId.
 */
export type RunFinishStatus = "clean" | "degraded" | "invalid";

export interface IssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export type MilestoneKind = "start" | "blocked" | "complete" | "decision";
export type DeliveryState = "pending" | "delivered" | "failed";
export type LabelTransition =
  | "not-applicable"
  | "applied"
  | "skipped"
  | "failed";
export type OwnerDecision = "accepted" | "rejected" | "changes-requested";

export interface FixedPoint {
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly diffHash: string;
  readonly dirtyStatePolicy: "reject" | "record-hash";
  readonly capturedAt: number;
}

export interface RunnerEvidence {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly laneId: string;
  readonly command: string | null;
  /** Durable stdout artifact; the lane tees its stdout here. */
  readonly stdoutArtifact: string;
  /** Durable stderr artifact written independently from the stdout pipeline. */
  readonly stderrArtifact: string;
  readonly dispatchedAt: number | null;
  readonly liveAt: number | null;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly failure: string | null;
  readonly environmentFailure: string | null;
  /** No simulated-run execution deadline exists in #14. */
  readonly executionTimeout: string | null;
  /** The immutable raw report artifact; null for simulated lanes. */
  readonly rawReportArtifact?: string | null;
  /**
   * Best-effort token counts parsed only from the lane's own output, or an
   * explicit unavailability reason; null for lanes that never ran a CLI.
   */
  readonly tokens?:
    | {
        readonly source: string;
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly totalTokens: number | null;
      }
    | { readonly unavailable: string }
    | null;
  readonly termination:
    | "sentinel-exit"
    | "crashed"
    | "lost"
    | "failed_to_start";
}

export type EmptyEventData = Readonly<Record<string, never>>;

export interface RunStartedData {
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly splitDirection: "right" | "down";
  readonly tabId: string;
  readonly controllerPaneId: string;
  readonly fixedPoint: FixedPoint | null;
  readonly issue: IssueRef | null;
}

interface LaneRegisteredCommon {
  readonly laneId: string;
  readonly paneId: string;
  readonly logFile: string;
  readonly stderrFile: string;
  readonly sentinelToken: string;
  readonly role?: string;
}

/** The pre-#7 shape; `kind` is absent on replayed historical events. */
export interface SimulatedLaneRegisteredData extends LaneRegisteredCommon {
  readonly kind?: "simulated";
  readonly steps: number;
  readonly stepDelaySeconds: number;
}

export interface AgentLaneRegisteredData extends LaneRegisteredCommon {
  readonly kind: "agent";
  readonly axis: ReviewAxis;
  readonly agentKind: ReviewAgentKind;
  readonly model: string;
  readonly effort: string;
  /** Runtime-assembled brief; the caller never supplies it. */
  readonly promptFile: string;
  readonly bundleHash: string;
  readonly rawReportFile: string;
  readonly worktreePath: string;
  /** Pre-assigned session UUID for CLI families that accept one. */
  readonly preassignedSessionId: string | null;
}

/**
 * The interactive write lane.
 *
 * It deliberately does NOT extend `LaneRegisteredCommon`: a headless lane's
 * `logFile`, `stderrFile`, and `sentinelToken` do not exist for an interactive
 * session, and carrying them as empty strings would be a shape that lies.
 * Per-attempt paths are derived from `artifactRoot`, because a retry allocates
 * new ones and the lane outlives every attempt.
 */
export interface InteractiveLaneRegisteredData {
  readonly kind: "interactive";
  readonly laneId: string;
  readonly paneId: string;
  readonly role?: string;
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  readonly worktreePath: string;
  /** Root the runtime derives each attempt's declared paths under. */
  readonly artifactRoot: string;
  /** The repository the worktree was verified to belong to. */
  readonly repoRoot: string;
}

export type LaneRegisteredData =
  | SimulatedLaneRegisteredData
  | AgentLaneRegisteredData
  | InteractiveLaneRegisteredData;

/** The human act that authorized an attempt to exist. Never runtime-issued. */
export interface AttemptAuthorizationData {
  readonly actor: "human";
  readonly note: string;
}

export interface InteractiveAttemptStartedData {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly parentAttemptId: string | null;
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  readonly paneId: string;
  /**
   * The deterministic agent name this attempt will be started under. Recorded
   * BEFORE the start so a controller that dies before `bound` can still prove,
   * by strict name match, that a live agent in that pane is THIS attempt's.
   */
  readonly expectedAgentName: string;
  readonly worktreePath: string;
  readonly briefFile: string;
  /** Declared paths the Agent writes to. Nothing durable reads scrollback. */
  readonly checkpointFile: string;
  readonly resultPointer: string;
  readonly authorization: AttemptAuthorizationData;
}

/** What Herdr reported once the agent was detected and ready for input. */
export interface InteractiveAttemptBoundData {
  readonly attemptId: string;
  /** Observed name. Herdr clears it on exit, so it is not a durable handle. */
  readonly agentName: string;
  /** Measured with its evidence, or unavailable with its reason. Never guessed. */
  readonly session: SessionIdentity;
  /** The argv Herdr launched, recorded verbatim. */
  readonly argv: readonly string[];
  readonly readinessMs: number;
}

/**
 * The attempt's one and only end. A start that never became a session ends
 * here too, with `endReason: "start-failed"` and its cause — there is no
 * separate start-failure event, because it is the same fact.
 *
 * The reducer rejects a second one unconditionally: an end is permanent.
 */
export interface InteractiveAttemptEndedData {
  readonly attemptId: string;
  readonly endReason: AttemptEndReason;
  readonly cause: string | null;
  /**
   * The session's own exit code when one was observed, null otherwise. It is a
   * SESSION fact: an interactive agent does not exit when a turn finishes, so
   * this never says the work completed, and it is never fabricated.
   */
  readonly exitCode: number | null;
}

export interface InteractiveAttemptReconciledData {
  readonly attemptId: string;
  readonly outcome: ReconciliationOutcome;
  /** Re-read at reconciliation: a pane moved between workspaces gets a new id. */
  readonly paneId: string;
  readonly detail: string | null;
}

/**
 * The shape a retry authorization carried before it recorded its own evidence.
 * Kept so old ledgers replay unchanged; no new producer writes it.
 */
export interface LegacyRetryAuthorizedData {
  /** The attempt being retried past; the new attempt records it as parent. */
  readonly parentAttemptId: string;
  readonly note: string;
}

/**
 * A human authorizing exactly one further attempt past a named parent, recorded
 * so the authorization is readable from the ledger alone rather than by
 * inferring it from the attempt that followed.
 *
 * `method` names the mechanism, as it does for a takeover: an authorization is
 * a ledger fact and nothing else — no prompt, no keys, no signal, no restart,
 * no rebind reaches the parent's session. `observedStatus` is a single
 * best-effort read of that session at the moment of authorization; `null` means
 * the read did not answer, which is an absence of observation and never a
 * reason to refuse a human's decision. `paneId` and `target` describe the
 * PARENT attempt, and are null only when it never bound an agent.
 */
export interface InteractiveRetryAuthorizedData {
  readonly parentAttemptId: string;
  readonly paneId: string | null;
  readonly target: string | null;
  readonly method: "ledger-retry-authorization";
  readonly observedStatus: AdvisoryAgentStatus | null;
  readonly note: string;
}

export interface InteractiveRunnerEvidenceData {
  readonly evidenceId: string;
  readonly attemptId: string;
  /** Exact argv-derived command line, run in its OWN pane, not the session. */
  readonly command: string;
  readonly logFile: string;
  readonly paneId: string;
  /** Parsed from the durable log's sentinel; null when none was captured. */
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** Recorded BEFORE submission, so a lost reply cannot erase the attempt to steer. */
export interface LaneSteerSubmittedData {
  readonly attemptId: string;
  readonly text: string;
  readonly paneId: string;
  readonly target: string;
}

/**
 * The transition observed after a submission — a separate fact from the
 * submission. Nothing here may be read as "the steer was applied" or "the work
 * is done": `--wait` tracks lifecycle state, not turns.
 */
export interface LaneSteerObservedData {
  readonly attemptId: string;
  readonly outcome: SteerObservationOutcome;
  readonly observedStatus: AdvisoryAgentStatus | null;
  readonly source: AdvisoryStateSource | null;
}

/**
 * INTENT to cancel the current turn. Recorded BEFORE the Herdr call, so a
 * controller that dies mid-call still leaves the request in the ledger. The
 * session survives a cancelled turn and stays steerable.
 */
export interface LaneCancelTurnData {
  readonly attemptId: string;
  /** Pairs this intent with exactly one delivery. */
  readonly controlId: string;
  readonly method: "send-keys";
  readonly keys: readonly string[];
}

/**
 * INTENT to end the session by signalling the pane's foreground process group.
 * Recorded before the signal, for the same reason.
 */
export interface LaneAbortSessionData {
  readonly attemptId: string;
  /** Pairs this intent with exactly one delivery. */
  readonly controlId: string;
  readonly method: "signal-process-group";
}

/**
 * What actually happened when a control intent was carried out — a separate
 * fact from the intent, and never a substitute for it. `observedStatus` is
 * null when the post-effect read did not answer; that is an absence of
 * observation, not a confirmation, and it never blocks the record.
 */
export interface LaneControlDeliveredData {
  readonly attemptId: string;
  /** Must name an intent that has no delivery yet, of the same control. */
  readonly controlId: string;
  readonly control: DeliveredControl;
  readonly method: "send-keys" | "signal-process-group";
  readonly delivered: boolean;
  readonly detail: string | null;
  readonly observedStatus: AdvisoryAgentStatus | null;
}

/**
 * Advisory Herdr state, recorded with its source. Consumed as a wait edge and
 * a UI signal; no lane- or attempt-outcome projection may read it.
 */
export interface LaneAdvisoryStateObservedData {
  readonly attemptId: string;
  readonly status: AdvisoryAgentStatus;
  readonly source: AdvisoryStateSource;
  readonly paneId: string;
  readonly message: string | null;
}

/**
 * A lane's control channel changing hands, recorded so a takeover or release
 * is readable from the ledger alone — which attempt it covered, on which pane,
 * through which target, and what the agent surface said at that moment.
 *
 * `method` is the whole point of the record: ownership moves by flipping the
 * ledger's control mode and by nothing else. No prompt, no keys, no signal, no
 * restart, no rebind — so the value names the mechanism rather than a channel.
 *
 * `observedStatus` is one best-effort read. Null means the read did not answer,
 * which is an absence of observation and never a status; it never blocks the
 * switch, because ownership is a human's decision, not Herdr's.
 *
 * Fields are null when the lane has no attempt to name yet. Ownership is a
 * property of the LANE, so it can change before the first attempt exists, and
 * naming a target that does not exist would be worse than saying there is none.
 */
export interface LaneOwnershipData {
  readonly attemptId: string | null;
  readonly paneId: string | null;
  readonly target: string | null;
  readonly method: "ledger-control-mode";
  readonly observedStatus: AdvisoryAgentStatus | null;
}


export interface InputBundleCapturedData {
  readonly files: readonly BundleFileRecord[];
  readonly bundleHash: string;
}

export interface LaneIsolationVerifiedData {
  readonly phase: "pre" | "post";
  readonly headOk: boolean;
  readonly cleanOk: boolean;
  readonly diffHashOk: boolean;
  readonly detail: string | null;
}

export interface LaneSessionRecordedData {
  readonly session: SessionIdentity;
}

export interface LaneDispatchedData {
  readonly command: string;
}

export interface LaneCheckpointData {
  readonly semanticState: SemanticState;
  readonly checkpointFile: string;
  readonly blockers?: readonly string[];
  readonly next?: readonly string[];
  readonly gaps?: readonly string[];
  /** Set on interactive lanes, whose checkpoints belong to one attempt. */
  readonly attemptId?: string;
}

export interface LaneExitedData {
  readonly exitCode: number;
  readonly signal?: string;
  readonly waitMatched?: boolean;
}

export interface LaneLostData {
  readonly cause: string;
}

export interface LaneFailedToStartData {
  readonly rejection: string;
  readonly command: string | null;
}

export interface LaneContractEvaluatedData {
  readonly contractState: ContractState;
  /** The derived result artifact, or null when none was ever written. */
  readonly resultFile: string | null;
  readonly errors: readonly string[];
}

export interface LaneVerificationRecordedData {
  readonly verificationState: VerificationState;
  readonly evidenceFile: string;
  /**
   * The raw artifact outcome for agent lanes; absent on replayed pre-#7
   * events and null for simulated lanes, which own no raw report.
   */
  readonly rawReportOutcome?: RawReportOutcome | null;
}

/**
 * Whether a lane's disposable review worktree was removed, and when it was
 * kept, why. Retention is the forensic outcome: it is recorded, never silent.
 */
export interface LaneWorktreeDispositionData {
  readonly disposition: "removed" | "retained";
  readonly retainedReason: string | null;
  readonly worktreePath: string;
}

export interface HumanInterruptData {
  readonly laneId: string;
}

export interface ControllerAttachedData {
  readonly controllerId: string;
  readonly epoch: number;
  readonly pid: number;
}

export interface RunOutcomeBreakdown {
  readonly exitedZero: number;
  readonly exitedNonZero: number;
  readonly crashed: number;
  readonly lost: number;
  readonly failedToStart: number;
}

export interface RunFinishedData {
  readonly status: RunFinishStatus;
  readonly breakdown: RunOutcomeBreakdown;
}

export interface IssueBindingResolvedData {
  readonly issueNodeId: string;
}

export interface IssueDeliveryIntendedData {
  readonly deliveryId: string;
  readonly kind: MilestoneKind;
  readonly laneId: string | null;
  readonly payloadHash: string;
}

export interface IssueDeliveryConfirmedData {
  readonly deliveryId: string;
  readonly commentId: number;
  readonly commentUrl: string;
  readonly labelTransition: LabelTransition;
}

export interface IssueDeliveryFailedData {
  readonly deliveryId: string;
  readonly reason: string;
  readonly retryable: boolean;
}

export interface OwnerDecisionRecordedData {
  readonly decision: OwnerDecision;
  readonly note: string;
  readonly resultingIssueState: string | null;
}

export interface RunEventDataByType {
  readonly run_started: RunStartedData;
  readonly input_bundle_captured: InputBundleCapturedData;
  readonly lane_registered: LaneRegisteredData;
  readonly lane_dispatch_intent: EmptyEventData;
  readonly lane_dispatched: LaneDispatchedData;
  readonly lane_live: EmptyEventData;
  readonly lane_checkpoint: LaneCheckpointData;
  readonly lane_exited: LaneExitedData;
  readonly lane_crashed: EmptyEventData;
  readonly lane_lost: LaneLostData;
  readonly lane_failed_to_start: LaneFailedToStartData;
  readonly lane_isolation_verified: LaneIsolationVerifiedData;
  readonly lane_session_recorded: LaneSessionRecordedData;
  readonly lane_contract_evaluated: LaneContractEvaluatedData;
  readonly lane_verification_recorded: LaneVerificationRecordedData;
  readonly lane_worktree_disposition: LaneWorktreeDispositionData;
  readonly checkpoint_announced: EmptyEventData;
  readonly human_interrupt: HumanInterruptData;
  // The empty arm is the shape every takeover and release carried before the
  // interactive lane existed, and the shape the headless runtime still writes.
  // It stays in the union so old ledgers replay unchanged: no migration, no
  // schema bump, and nothing rewrites what a past run recorded.
  readonly lane_takeover: EmptyEventData | LaneOwnershipData;
  readonly lane_release: EmptyEventData | LaneOwnershipData;
  readonly interactive_attempt_started: InteractiveAttemptStartedData;
  readonly interactive_attempt_bound: InteractiveAttemptBoundData;
  readonly interactive_attempt_ended: InteractiveAttemptEndedData;
  readonly interactive_attempt_reconciled: InteractiveAttemptReconciledData;
  // The legacy arm is the shape retries carried before Revision 15. It stays in
  // the union so old ledgers replay unchanged — no migration, no schema bump —
  // and the interactive producer is held to the complete shape by the seam it
  // must commit through, not by this union.
  readonly interactive_retry_authorized:
    | LegacyRetryAuthorizedData
    | InteractiveRetryAuthorizedData;
  readonly interactive_runner_evidence: InteractiveRunnerEvidenceData;
  readonly lane_steer_submitted: LaneSteerSubmittedData;
  readonly lane_steer_observed: LaneSteerObservedData;
  readonly lane_cancel_turn: LaneCancelTurnData;
  readonly lane_abort_session: LaneAbortSessionData;
  readonly lane_control_delivered: LaneControlDeliveredData;
  readonly lane_advisory_state_observed: LaneAdvisoryStateObservedData;
  readonly controller_attached: ControllerAttachedData;
  readonly issue_binding_resolved: IssueBindingResolvedData;
  readonly issue_delivery_intended: IssueDeliveryIntendedData;
  readonly issue_delivery_confirmed: IssueDeliveryConfirmedData;
  readonly issue_delivery_failed: IssueDeliveryFailedData;
  readonly owner_decision_recorded: OwnerDecisionRecordedData;
  readonly run_finished: RunFinishedData;
}

export interface RunEventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  readonly laneId?: string;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly at: number;
  readonly actor: RunEventActor;
  readonly controllerEpoch: number;
  readonly data: RunEventDataByType[RunEventType];
}

type EventFor<
  T extends RunEventType,
  A extends RunEventActor,
  Lane extends string | undefined = undefined,
> = Omit<RunEventEnvelope, "type" | "actor" | "laneId" | "data"> & {
  readonly type: T;
  readonly actor: A;
  readonly data: RunEventDataByType[T];
} & (Lane extends string ? { readonly laneId: string } : { readonly laneId?: never });

export type RunEvent =
  | EventFor<"run_started", "runtime">
  | EventFor<"input_bundle_captured", "runtime">
  | EventFor<"lane_registered", "runtime", string>
  | EventFor<"lane_dispatch_intent", "runtime", string>
  | EventFor<"lane_dispatched", "runtime", string>
  | EventFor<"lane_live", "runtime", string>
  // An Agent that writes its own checkpoint is the `agent` actor; a checkpoint
  // the runtime derives from a lane's captured bytes is the `runtime` actor.
  // The ledger keeps the two apart so no derivation can pass as Agent text.
  | EventFor<"lane_checkpoint", "agent" | "runtime", string>
  | EventFor<"lane_exited", "runtime", string>
  | EventFor<"lane_crashed", "runtime", string>
  | EventFor<"lane_lost", "runtime", string>
  | EventFor<"lane_failed_to_start", "runtime", string>
  | EventFor<"lane_isolation_verified", "runner", string>
  | EventFor<"lane_session_recorded", "runner", string>
  | EventFor<"lane_contract_evaluated", "validator", string>
  | EventFor<"lane_verification_recorded", "runner", string>
  | EventFor<"lane_worktree_disposition", "runner", string>
  | EventFor<"checkpoint_announced", "runtime">
  | EventFor<"human_interrupt", "human", string>
  | EventFor<"lane_takeover", "human", string>
  | EventFor<"lane_release", "human", string>
  // Attempt lifecycle is the runtime's process bookkeeping...
  | EventFor<"interactive_attempt_started", "runtime", string>
  | EventFor<"interactive_attempt_bound", "runtime", string>
  | EventFor<"interactive_attempt_ended", "runtime", string>
  | EventFor<"interactive_attempt_reconciled", "runtime", string>
  // ...while every CONTROL INTENT is a human act, and typed as one. No model
  // and no runtime path may author a steer, a cancel, an abort, or a retry.
  | EventFor<"interactive_retry_authorized", "human", string>
  | EventFor<"lane_steer_submitted", "human", string>
  | EventFor<"lane_cancel_turn", "human", string>
  | EventFor<"lane_abort_session", "human", string>
  // What the runtime then observed: delivery, transitions, advisory state.
  // None of these is evidence of work, and none can substitute for an intent.
  | EventFor<"lane_control_delivered", "runtime", string>
  | EventFor<"lane_steer_observed", "runtime", string>
  | EventFor<"lane_advisory_state_observed", "runtime", string>
  // Runner evidence keeps the runner's authorship, as on the headless lane.
  | EventFor<"interactive_runner_evidence", "runner", string>
  | EventFor<"controller_attached", "runtime">
  | EventFor<"issue_binding_resolved", "runtime">
  | EventFor<"issue_delivery_intended", "runtime">
  | EventFor<"issue_delivery_confirmed", "runtime">
  | EventFor<"issue_delivery_failed", "runtime">
  | EventFor<"owner_decision_recorded", "human">
  | EventFor<"run_finished", "runtime">;

export type NewRunEvent = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<
        E,
        | "schemaVersion"
        | "eventId"
        | "runId"
        | "sequence"
        | "at"
        | "controllerEpoch"
      >
    : never
  : never;
