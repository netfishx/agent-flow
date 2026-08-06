// The interactive write lane's vocabulary.
//
// One boundary runs through this file and is the reason it exists: Herdr's
// agent state is ADVISORY and never evidence, while checkpoints, artifacts,
// runner records, and process exits are OBJECTIVE. The two are separate types
// here, separate events in the ledger, and separated again at the projection
// seam (`ObjectiveAttemptFacts` in ./attempts.ts), so a `done` label cannot
// reach a completion decision by any path.

import type { SemanticState } from "../runtime/events.ts";

/** The three CLI families a write lane may host, per the owner's ruling. */
export type InteractiveAgentKind = "claude" | "codex" | "grok";

/**
 * Herdr's own agent classification. ADVISORY ONLY.
 *
 * Three properties make this non-negotiable:
 *   - `done` is the same underlying idle state as `idle`, distinguished only by
 *     whether the tab has been SEEN in the focused Herdr UI. CLI reads do not
 *     mark it seen, so `done` is a human-attention fact, not a work fact.
 *   - `unknown` means Herdr could not classify confidently. It proves nothing.
 *   - Herdr's `pane_exited` event carries no exit code, so no Herdr surface can
 *     supply completion evidence even in principle.
 */
export type AdvisoryAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

/** Where an advisory observation came from; always recorded with the state. */
export type AdvisoryStateSource = "herdr-detection" | "runtime-published";

export interface AdvisoryObservation {
  readonly status: AdvisoryAgentStatus;
  readonly source: AdvisoryStateSource;
  readonly paneId: string;
  readonly at: number;
  readonly message?: string;
}

/**
 * What a steer submission is allowed to claim. `herdr agent prompt --wait`
 * tracks lifecycle state, not turns: an already-working agent's active turn
 * may satisfy the wait, and a prompt from a non-working state that produces no
 * observed change within 5000ms returns `agent_prompt_stalled`. So the return
 * is an OBSERVATION of a transition, never proof the instruction was applied.
 */
export type SteerObservationOutcome =
  | "state-observed"
  | "stalled"
  | "timeout"
  | "not-observed";

export interface SteerObservation {
  readonly outcome: SteerObservationOutcome;
  /** The advisory state seen after submission, when one was seen at all. */
  readonly observed: AdvisoryObservation | null;
}

/** How an attempt's session ended. Distinct from what the work achieved. */
export type AttemptEndReason =
  | "session-exit"
  | "interrupted"
  | "aborted"
  | "start-failed"
  | "lost";

/**
 * The attempt's outcome. `completed` is reachable only from objective evidence
 * — an agent-authored checkpoint plus at least one independent runner record.
 * A session exit code, however clean, never reaches it.
 */
export type AttemptDisposition =
  | "running"
  | "completed"
  | "interrupted"
  | "aborted"
  | "superseded"
  | "unknown";

/** How a resuming controller found the attempt's pane. */
export type ReconciliationOutcome = "live" | "reoccupied" | "missing";

export interface ReconciliationRecord {
  readonly outcome: ReconciliationOutcome;
  readonly at: number;
  readonly detail: string | null;
}

/** The human act that authorized this attempt to exist. */
export interface AttemptAuthorization {
  readonly actor: "human";
  readonly note: string;
  readonly at: number;
}

/**
 * An agent-authored checkpoint. `origin` is retained so a runtime-derived
 * `unknown` record can never be rendered as the Agent's own claim.
 */
export interface AttemptCheckpoint {
  readonly file: string;
  readonly semanticState: SemanticState;
  readonly origin: "agent" | "runtime";
  readonly at: number;
}

/**
 * One independent verification run. It happens in its own pane as an ordinary
 * command under the headless contract already proven by the read-only lane —
 * never inside the agent session, and never through the agent surface.
 */
export interface InteractiveRunnerEvidence {
  readonly evidenceId: string;
  readonly attemptId: string;
  readonly command: string;
  readonly logFile: string;
  readonly paneId: string;
  /** The real exit code parsed from the durable log's sentinel; null if none. */
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface AttemptStartFailure {
  readonly cause: string;
  readonly at: number;
}

/**
 * The durable, append-only record of one interactive attempt. Two attempts of
 * one lane are distinguishable from these fields alone, with no pane inspected.
 */
export interface InteractiveAttemptView {
  readonly attemptId: string;
  /** Ordinal within the lane; the first attempt is 1. */
  readonly ordinal: number;
  readonly runId: string;
  readonly laneId: string;
  readonly parentAttemptId: string | null;
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  /** The pane at start; re-recorded when reconciliation finds it moved. */
  readonly paneId: string;
  /** Observed agent name. NOT a durable handle: Herdr clears it on exit. */
  readonly agentName: string | null;
  readonly agentSessionId: string | null;
  readonly worktreePath: string;
  readonly briefFile: string;
  /** Declared path the Agent writes its checkpoint to; never scrollback. */
  readonly checkpointFile: string;
  /** Declared path the Agent writes its result to; never scrollback. */
  readonly resultPointer: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly endReason: AttemptEndReason | null;
  /** The session's own exit code when observed. A session fact, not a verdict. */
  readonly exitCode: number | null;
  readonly supersededBy: string | null;
  readonly authorization: AttemptAuthorization;
  readonly agentCheckpoint: AttemptCheckpoint | null;
  readonly runnerEvidence: readonly InteractiveRunnerEvidence[];
  readonly reconciliation: ReconciliationRecord | null;
  readonly startFailure: AttemptStartFailure | null;
  /** ADVISORY channel. Excluded from outcome projection by construction. */
  readonly advisory: readonly AdvisoryObservation[];
  readonly controlMode: "managed" | "human_owned";
  readonly steerSubmissions: number;
  readonly steerObservations: number;
  readonly lastCancelTurnAt: number | null;
  readonly lastAbortAt: number | null;
}

/** A lane's attempts in start order, newest last. */
export interface InteractiveLaneView {
  readonly laneId: string;
  readonly runId: string;
  readonly attempts: readonly InteractiveAttemptView[];
}
