import type { BundleFileRecord } from "../review/bundle.ts";
import type { ReviewAxis } from "../review/brief.ts";
import type { ReviewAgentKind } from "../review/commands.ts";
import type { SessionIdentity } from "../review/session.ts";

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
  | "checkpoint_announced"
  | "human_interrupt"
  | "lane_takeover"
  | "lane_release"
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

export type LaneRegisteredData =
  | SimulatedLaneRegisteredData
  | AgentLaneRegisteredData;

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
  readonly resultFile: string;
  readonly errors: readonly string[];
}

export interface LaneVerificationRecordedData {
  readonly verificationState: VerificationState;
  readonly evidenceFile: string;
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
  readonly checkpoint_announced: EmptyEventData;
  readonly human_interrupt: HumanInterruptData;
  readonly lane_takeover: EmptyEventData;
  readonly lane_release: EmptyEventData;
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
  | EventFor<"lane_checkpoint", "agent", string>
  | EventFor<"lane_exited", "runtime", string>
  | EventFor<"lane_crashed", "runtime", string>
  | EventFor<"lane_lost", "runtime", string>
  | EventFor<"lane_failed_to_start", "runtime", string>
  | EventFor<"lane_isolation_verified", "runner", string>
  | EventFor<"lane_session_recorded", "runner", string>
  | EventFor<"lane_contract_evaluated", "validator", string>
  | EventFor<"lane_verification_recorded", "runner", string>
  | EventFor<"checkpoint_announced", "runtime">
  | EventFor<"human_interrupt", "human", string>
  | EventFor<"lane_takeover", "human", string>
  | EventFor<"lane_release", "human", string>
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
