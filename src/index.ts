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
  InterruptOutcome,
  LanePhaseTiming,
  LaneResult,
  LaneSpec,
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
  BundleFileRecord,
  BundleFileRole,
  BundleSourceFile,
  InputBundleManifest,
} from "./review/bundle.ts";
export { assembleBrief } from "./review/brief.ts";
export type { BriefInput, ReviewAxis } from "./review/brief.ts";
export {
  buildAgentCliArgv,
  buildAgentLaneCommand,
} from "./review/commands.ts";
export type { AgentLaneCommandInput, ReviewAgentKind } from "./review/commands.ts";
export { extractClaudeReport } from "./review/claude-stream.ts";
export type { ClaudeReportExtraction } from "./review/claude-stream.ts";
export {
  parseCodexSessionId,
  parseCodexTokensUsed,
} from "./review/session.ts";
export type { SessionIdentity } from "./review/session.ts";
export {
  diffHashOf,
  GitReviewIsolation,
  verificationPassed,
} from "./review/isolation.ts";
export type {
  CaptureFixedPointInput,
  ReviewIsolationPort,
  WorktreeVerification,
} from "./review/isolation.ts";

// Test infrastructure (fake adapter, clock, quoting inverse) is intentionally
// NOT re-exported here — it lives in `./testing.ts` so the production entry
// stays limited to the runtime surface.
