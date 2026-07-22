// Public runtime types. These are what callers touch — deliberately free of
// pane identifiers, tab identifiers, Herdr JSON, and shell fragments. Callers
// address work through opaque `runId` / `laneId` strings only.

import type { HerdrAdapter } from "../herdr/adapter.ts";
import type { Ledger } from "./ledger.ts";

export type LaneState =
  | "starting"
  | "running"
  | "complete"
  | "interrupted"
  | "failed";

export type RunState = "dispatched" | "running" | "complete" | "partial";

/**
 * A single timing measurement. Either a real wall-clock value or an explicit
 * unavailability with a reason — never a silently missing field.
 */
export type TimingMetric =
  | { readonly kind: "measured"; readonly ms: number }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Run-level token accounting. Simulated lanes and headless CLIs report none. */
export type TokenMetric =
  | {
      readonly kind: "measured";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The four phase-separated timings #2 asked future comparisons to measure. */
export interface LanePhaseTiming {
  readonly processStartup: TimingMetric;
  readonly modelInference: TimingMetric;
  readonly executionWait: TimingMetric;
  readonly humanCoordination: TimingMetric;
}

export interface WorkflowMetrics {
  readonly startupLatency: TimingMetric;
  readonly tokenUsage: TokenMetric;
  readonly perLane: Readonly<Record<string, LanePhaseTiming>>;
}

export interface LaneStatus {
  readonly laneId: string;
  readonly state: LaneState;
  readonly exitCode: number | null;
  readonly timing: LanePhaseTiming;
}

export interface WorkflowStatus {
  readonly runId: string;
  readonly state: RunState;
  readonly lanes: readonly LaneStatus[];
  readonly metrics: WorkflowMetrics;
}

export interface LaneResult {
  readonly laneId: string;
  readonly state: LaneState;
  readonly exitCode: number | null;
  /**
   * Whether `wait-output` matched the lane's sentinel. This reports that the
   * sentinel line appeared — it is NOT the exit code, which is parsed
   * separately from the durable log.
   */
  readonly waitMatched: boolean;
  /** The run+lane-specific completion token (logical; contains no pane id). */
  readonly sentinelToken: string;
  readonly outputTail: readonly string[];
}

export interface InterruptOutcome {
  readonly laneId: string;
  readonly signal: string;
  readonly delivered: boolean;
}

export interface LaneSpec {
  readonly laneId: string;
  readonly role?: string;
  readonly steps: number;
  readonly stepDelaySeconds?: number;
}

export interface StartWorkflowConfig {
  readonly workflow: string;
  readonly workspace: string;
  /** Directory the lanes write their durable logs into. */
  readonly cwd: string;
  readonly lanes: readonly LaneSpec[];
  readonly splitDirection?: "right" | "down";
  /** Pause after splitting before dispatch, to avoid the split→run race. */
  readonly startupSettleMs?: number;
}

export interface RunHandle {
  readonly runId: string;
  readonly laneIds: readonly string[];
}

/** Everything the runtime needs from the outside — all injectable for tests. */
export interface RuntimeDeps {
  readonly adapter: HerdrAdapter;
  /** Required event ledger; InMemoryLedger is the explicit ephemeral choice. */
  readonly ledger: Ledger;
  /** Monotonic-ish millisecond clock, stamped at phase boundaries. */
  readonly clock: () => number;
  /** Generates the opaque run id. */
  readonly idgen: () => string;
  /** Reads a lane's durable log (the source of truth for its exit code). */
  readonly readResultFile: (path: string) => Promise<string>;
  /** Real delay for settle/poll waits; a no-op in deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to confirm a lane's process has exited after its sentinel (default 2000ms). */
  readonly processGoneTimeoutMs?: number;
  /** Poll interval for the process-gone confirmation (default 100ms). */
  readonly processGoneIntervalMs?: number;
}
