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
