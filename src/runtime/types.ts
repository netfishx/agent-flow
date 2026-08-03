// Public runtime types. These are what callers touch — deliberately free of
// pane identifiers, tab identifiers, Herdr JSON, and shell fragments. Callers
// address work through opaque `runId` / `laneId` strings only.

import type { HerdrAdapter } from "../herdr/adapter.ts";
import type { IssueTracker } from "../issue/tracker.ts";
import type { Ledger } from "./ledger.ts";
import type { FixedPoint, IssueRef } from "./events.ts";
import type { RunState as ProjectedRunState } from "./reducer.ts";
import type { BundleSourceFile } from "../review/bundle.ts";
import type { AgentLaneCommandInput } from "../review/commands.ts";
import type { ReviewIsolationPort } from "../review/isolation.ts";
import type { ReviewAgentKind, ReviewAxis } from "../review/types.ts";

export type LaneState =
  | "starting"
  | "running"
  | "complete"
  | "interrupted"
  | "failed";

export type RunState = ProjectedRunState;

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
  /** Whether this await call exhausted its observation window. */
  readonly timedOut: boolean;
  /** The run+lane-specific completion token (logical; contains no pane id). */
  readonly sentinelToken: string;
  readonly outputTail: readonly string[];
}

export interface InterruptOutcome {
  readonly laneId: string;
  readonly signal: string;
  readonly delivered: boolean;
}

/** The pre-#7 simulated shape; `kind` may be omitted by existing callers. */
export interface SimulatedLaneSpec {
  readonly kind?: "simulated";
  readonly laneId: string;
  readonly role?: string;
  readonly steps: number;
  readonly stepDelaySeconds?: number;
}

/**
 * An agent lane. External input declares only axis, agentKind,
 * model, and effort — the runtime owns the brief, the session pre-assignment,
 * and the review worktree.
 */
export interface AgentLaneSpec {
  readonly kind: "agent";
  readonly laneId: string;
  readonly axis: ReviewAxis;
  readonly agentKind: ReviewAgentKind;
  readonly model: string;
  readonly effort: string;
}

export type LaneSpec = SimulatedLaneSpec | AgentLaneSpec;

export interface StartWorkflowConfig {
  readonly workflow: string;
  readonly workspace: string;
  /** Directory the lanes write their durable logs into. */
  readonly cwd: string;
  readonly lanes: readonly LaneSpec[];
  readonly splitDirection?: "right" | "down";
  /** Pause after splitting before dispatch, to avoid the split→run race. */
  readonly startupSettleMs?: number;
  /** Captured by the caller; the runtime stores it verbatim without validation. */
  readonly fixedPoint?: FixedPoint | null;
  /** Optional immutable GitHub issue binding, validated locally before startup. */
  readonly issue?: IssueRef | null;
  /**
   * Raw review materials, captured once by the caller. Required when any lane
   * is an agent lane; the runtime hashes, persists, and records them as the
   * immutable input bundle.
   */
  readonly inputBundle?: readonly BundleSourceFile[] | null;
}

export interface LaneCommandInput {
  readonly runId: string;
  readonly laneId: string;
  readonly logFile: string;
  readonly stderrFile: string;
  readonly checkpointFile: string;
  readonly resultFile: string;
  readonly steps: number;
  readonly stepDelaySeconds: number;
}

export interface RunHandle {
  readonly runId: string;
  readonly laneIds: readonly string[];
}

/** Everything the runtime needs from the outside — all injectable for tests. */
export interface RuntimeDeps {
  readonly adapter: HerdrAdapter;
  /** Optional GitHub issue sink; required only for issue-bound runs. */
  readonly issueTracker?: IssueTracker;
  /** Required event ledger; InMemoryLedger is the explicit ephemeral choice. */
  readonly ledger: Ledger;
  /** Monotonic-ish millisecond clock, stamped at phase boundaries. */
  readonly clock: () => number;
  /** Generates the opaque run id. */
  readonly idgen: () => string;
  /** Reads a lane's durable log (the source of truth for its exit code). */
  readonly readResultFile: (path: string) => Promise<string>;
  /** Builds the exact command persisted at the physical dispatch boundary. */
  readonly laneCommandBuilder?: (input: LaneCommandInput) => string;
  /** Builds the exact agent-lane command; defaults to the real CLI batteries. */
  readonly agentLaneCommandBuilder?: (input: AgentLaneCommandInput) => string;
  /** Review worktree lifecycle and verification; required for agent lanes. */
  readonly reviewIsolation?: ReviewIsolationPort;
  /** Pre-assigned session UUIDs for claude/grok lanes; injectable for tests. */
  readonly sessionIdgen?: () => string;
  /** Structured environment/setup failure reported by the runner, if any. */
  readonly runnerEnvironmentFailure?: (
    runId: string,
    laneId: string,
  ) => string | null | Promise<string | null>;
  /** Real delay for settle/poll waits; a no-op in deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to confirm a lane's process has exited after its sentinel (default 2000ms). */
  readonly processGoneTimeoutMs?: number;
  /** Poll interval for the process-gone confirmation (default 100ms). */
  readonly processGoneIntervalMs?: number;
  /**
   * Maximum duration of one automatic drive wait (default 2000ms).
   * Must be a positive, finite number.
   */
  readonly driveSliceMs?: number;
}
