// Public surface of the visible-run tracer.
//
// Callers construct a WorkflowRuntime with an adapter and drive runs through its
// small, handle-based interface:
//
//   startWorkflow(config)              -> RunHandle { runId, laneIds }
//   inspectWorkflow(runId)             -> WorkflowStatus (states + metrics)
//   focusLane(runId, laneId)           -> bring a lane into view
//   interruptLane(runId, laneId)       -> SIGINT one lane
//   inspectLaneResult(runId, laneId)   -> durable per-lane result
//
// Pane identifiers, tab identifiers, Herdr JSON, sentinels, wait-output, and
// shell quoting live behind the HerdrAdapter seam and never appear here.

export { PartialDispatchError, WorkflowRuntime } from "./runtime/runtime.ts";
export {
  ControllerLeaseHeldError,
  InMemoryLedger,
} from "./runtime/ledger.ts";
export { FsLedger, resolveLedgerRoot } from "./runtime/fs-ledger.ts";
export type { Ledger, LeaseHandle } from "./runtime/ledger.ts";
export { projectRunState, reduce } from "./runtime/reducer.ts";
export { parseCheckpoint } from "./runtime/checkpoint.ts";
export type { ParsedCheckpoint } from "./runtime/checkpoint.ts";
export {
  deliveryIdFor,
  dueMilestones,
  marker,
  projectSynchronization,
} from "./issue/milestones.ts";
export type {
  BlockedPayload,
  CompleteLanePayload,
  CompletePayload,
  DecisionPayload,
  DueMilestone,
  MilestonePayload,
  StartPayload,
  SynchronizationProjection,
  SynchronizationState,
} from "./issue/milestones.ts";
export { canonicalJson, canonicalPayloadHash } from "./issue/hash.ts";
export { renderMilestone } from "./issue/render.ts";
export type { RenderContext } from "./issue/render.ts";
// The effectively-once reconciler is intentionally NOT exported here. A raw
// pass must be serialized per run by whoever calls it, and `WorkflowRuntime` is
// the entry point that guarantees that. Exposing the bare pass would publish an
// interface whose contract this package cannot enforce.
export { IssueTrackerError } from "./issue/tracker.ts";
export type {
  AuthorizedIssueTargetConfig,
  CommentRef,
  IssueTracker,
  ResolvedIssue,
  TriageLabelOutcome,
} from "./issue/tracker.ts";
export { RealIssueTracker } from "./issue/real-tracker.ts";
export type { RealIssueTrackerOptions } from "./issue/real-tracker.ts";
export type {
  BlockedAnchor,
  DecisionView,
  DeliveryView,
  LaneView,
  RunView,
} from "./runtime/reducer.ts";
export type {
  ContractState,
  ControlMode,
  DeliveryState,
  FixedPoint,
  IssueBindingResolvedData,
  IssueDeliveryConfirmedData,
  IssueDeliveryFailedData,
  IssueDeliveryIntendedData,
  IssueRef,
  LabelTransition,
  MilestoneKind,
  NewRunEvent,
  OwnerDecision,
  OwnerDecisionRecordedData,
  RunEvent,
  RunEventActor,
  RunEventDataByType,
  RunEventEnvelope,
  RunEventType,
  RunFinishStatus,
  RunOutcomeBreakdown,
  RunnerEvidence,
  RuntimeState,
  SemanticState,
  VerificationState,
} from "./runtime/events.ts";
export type {
  AgentLaneSpec,
  InterruptOutcome,
  LanePhaseTiming,
  LaneResult,
  LaneSpec,
  SimulatedLaneSpec,
  LaneState,
  LaneStatus,
  RunHandle,
  RunState,
  RuntimeDeps,
  StartWorkflowConfig,
  TimingMetric,
  TokenMetric,
  WorkflowMetrics,
  WorkflowStatus,
} from "./runtime/types.ts";

export type { HerdrAdapter } from "./herdr/adapter.ts";
export { RealHerdrAdapter } from "./herdr/real-adapter.ts";
export type { RealHerdrAdapterOptions } from "./herdr/real-adapter.ts";

// The interactive write lane. Its argv builders and JSON parsers are NOT
// exported, for the same reason the agent-lane batteries are not: they emit
// CLI-family mechanics and shell quoting, which the design keeps inside the
// implementation (docs/design/observable-multi-agent-runtime.md section 6).
export {
  AttemptNotBoundError,
  AttemptNotControllableError,
  InteractiveLaneController,
  LaneTakenOverError,
  RetryNotAuthorizedError,
  WriteLaneIsolationError,
  controlDeliveryState,
  latestControl,
  pendingRetries,
  unresolvedControls,
} from "./interactive/control-plane.ts";
export { GitWriteLaneIsolation } from "./interactive/isolation.ts";
export type {
  WriteLaneIsolationOutcome,
  WriteLaneIsolationPort,
} from "./interactive/isolation.ts";
export type {
  InteractiveDeps,
  OpenLaneConfig,
  RunnerRequest,
  StartAttemptInput,
  StartAttemptOutcome,
} from "./interactive/control-plane.ts";
// `objectiveFactsOf` and `projectAttemptDisposition` are the advisory wall's
// two halves and are NOT exported: a caller wants a disposition, and reaching
// for the halves is how the wall gets routed around. Their tests import the
// module path directly, as the command builders' tests already do.
export { attemptDisposition } from "./interactive/attempts.ts";
export type {
  AdvisoryAgentStatus,
  AdvisoryObservation,
  AdvisoryStateSource,
  AttemptAuthorization,
  AttemptCheckpoint,
  AttemptDisposition,
  AttemptEndReason,
  ControlDelivery,
  ControlDeliveryState,
  ControlRecord,
  DeliveredControl,
  InteractiveAgentKind,
  InteractiveAttemptView,
  InteractiveRunnerEvidence,
  ReconciliationOutcome,
  ReconciliationRecord,
  SteerObservation,
  SteerObservationOutcome,
} from "./interactive/types.ts";
export type {
  AgentPromptResult,
  HerdrAgentControl,
} from "./herdr/agent-control.ts";
export { RealHerdrAgentControl } from "./herdr/real-agent-control.ts";
export type { RealHerdrAgentControlOptions } from "./herdr/real-agent-control.ts";

export {
  REPORT_CONTRACT_BLOCK,
  validateReportContract,
} from "./review/contract.ts";
export type {
  FindingSeverity,
  ReportContractOutcome,
  ReportFinding,
  ReviewConfidence,
  ReviewVerdict,
} from "./review/contract.ts";
export { assembleInputBundle } from "./review/bundle.ts";
export type {
  AssembledInputBundle,
  BundleArtifact,
  BundleSourceFile,
} from "./review/bundle.ts";
export { assembleBrief } from "./review/brief.ts";
export type { BriefInput } from "./review/brief.ts";
export { GitReviewIsolation } from "./review/isolation.ts";
export type { ReviewIsolationPort } from "./review/isolation.ts";
export { verificationPassed } from "./review/verification.ts";
export type {
  BundleFileRecord,
  BundleFileRole,
  CaptureFixedPointInput,
  InputBundleManifest,
  ReviewAgentKind,
  ReviewAxis,
  SessionIdentity,
  WorktreeVerification,
} from "./review/types.ts";

// Deliberately NOT exported, each for the reason this entry already states:
//   - the agent-lane command builders emit sentinels and shell quoting;
//   - `extractClaudeReport`, `parseCodexSessionId`, and `parseCodexTokensUsed`
//     parse one CLI family's own output, and the design keeps Agent-specific
//     mechanics and session identifiers inside the implementation
//     (docs/design/observable-multi-agent-runtime.md section 6).
// `assembleBrief` stays: it is the runtime's own deterministic input builder,
// not a parser of any Agent's output. Their tests use internal paths.

// Test infrastructure (fake adapter, clock, quoting inverse) is intentionally
// NOT re-exported here — it lives in `./testing.ts` so the production entry
// stays limited to the runtime surface.
