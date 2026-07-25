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
export { InMemoryLedger } from "./runtime/ledger.ts";
export { FsLedger, resolveLedgerRoot } from "./runtime/fs-ledger.ts";
export type { Ledger, LeaseHandle } from "./runtime/ledger.ts";
export { projectRunState, reduce } from "./runtime/reducer.ts";
export { parseCheckpoint } from "./runtime/checkpoint.ts";
export type { ParsedCheckpoint } from "./runtime/checkpoint.ts";
export {
  deliveryIdFor,
  dueMilestones,
  marker,
} from "./issue/milestones.ts";
export type {
  BlockedPayload,
  CompleteLanePayload,
  CompletePayload,
  DecisionPayload,
  DueMilestone,
  MilestonePayload,
  StartPayload,
} from "./issue/milestones.ts";
export { canonicalJson, canonicalPayloadHash } from "./issue/hash.ts";
export { renderMilestone } from "./issue/render.ts";
export type { RenderContext } from "./issue/render.ts";
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

// Test infrastructure (fake adapter, clock, quoting inverse) is intentionally
// NOT re-exported here — it lives in `./testing.ts` so the production entry
// stays limited to the runtime surface.
