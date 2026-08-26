// The interactive write lane's vocabulary.
//
// One boundary runs through this file and is the reason it exists: Herdr's
// agent state is ADVISORY and never evidence, while checkpoints, artifacts,
// runner records, and process exits are OBJECTIVE. The two are separate types
// here, separate events in the ledger, and separated again at the projection
// seam (`ObjectiveAttemptFacts` in ./attempts.ts), so a `done` label cannot
// reach a completion decision by any path.

import type { SemanticState } from "../runtime/events.ts";
import type { SessionIdentity } from "../review/types.ts";

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

/**
 * How an attempt's session ended. Distinct from what the work achieved.
 *
 * An end is PERMANENT. Once one is recorded the attempt accepts no further
 * control, no second end, and no observation that restores either — a later
 * `live` reconciliation is still recorded, but it cannot resurrect the attempt.
 */
export type AttemptEndReason =
  | "session-exit"
  | "interrupted"
  | "aborted"
  | "start-failed"
  | "lost";

/** The two controls that act on a session rather than submit text to it. */
export type DeliveredControl = "cancel-turn" | "abort-session";

/**
 * What happened when a control INTENT was carried out. Recorded separately
 * from the intent, and after it, so a control whose effect landed but whose
 * observation failed still leaves both facts: requested, and delivered.
 * `observedStatus` is null when the post-effect read did not answer — that is
 * an absence of observation, never a confirmation.
 */
export interface ControlDelivery {
  readonly delivered: boolean;
  readonly detail: string | null;
  readonly observedStatus: AdvisoryAgentStatus | null;
  readonly at: number;
}

/**
 * One control request and, once it exists, its delivery. Kept as a pair so
 * "requested" and "carried out" can never collapse into one nullable field.
 */
export interface ControlRecord {
  readonly controlId: string;
  readonly control: DeliveredControl;
  readonly method: "send-keys" | "signal-process-group";
  readonly requestedAt: number;
  /** Null until a delivery for THIS controlId is recorded. */
  readonly delivery: ControlDelivery | null;
}

/**
 * What is known about ONE control. Derived from its intent/delivery pair,
 * never stored: `unconfirmed` is the honest answer when a controller recorded
 * the request and then died, or when the delivery record itself was lost — the
 * effect may or may not have reached the session, and nothing may replay it on
 * that basis.
 */
export type ControlDeliveryState = "unconfirmed" | "delivered" | "failed";

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

/**
 * How a resuming controller found the attempt's pane.
 *
 * `unknown-probe` is the fourth honest answer: the probe itself failed, so the
 * controller knows nothing about the pane. It is NOT folded into `missing` —
 * a broken control plane is not evidence that an Agent is gone.
 */
export type ReconciliationOutcome =
  | "live"
  | "reoccupied"
  | "missing"
  | "unknown-probe";

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
  /**
   * The deterministic name this attempt's agent is started under, recorded at
   * registration. It is what lets a fresh controller prove that a live agent
   * in the pane is THIS attempt's and not a stranger's.
   */
  readonly expectedAgentName: string;
  /** Observed agent name. NOT a durable handle: Herdr clears it on exit. */
  readonly agentName: string | null;
  /**
   * Session identity, in the vocabulary the headless lane already uses: either
   * `measured` with the evidence that ties it to this attempt, or `unavailable`
   * with the reason. A missing session always says why.
   */
  readonly session: SessionIdentity;
  readonly worktreePath: string;
  /** Declared path for this attempt's brief; the brief itself arrives by steer. */
  readonly briefFile: string;
  /** Declared path the Agent writes its checkpoint to; never scrollback. */
  readonly checkpointFile: string;
  /** Declared path the Agent writes its result to; never scrollback. */
  readonly resultPointer: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly endReason: AttemptEndReason | null;
  /** Why it ended, when the reason needs one (a start failure's cause). */
  readonly endCause: string | null;
  /** The session's own exit code when observed. A session fact, not a verdict. */
  readonly exitCode: number | null;
  /**
   * DERIVED, not stored as its own event: the child attempt that named this one
   * as its parent. One fact, one writer — the child's `parentAttemptId`.
   */
  readonly supersededBy: string | null;
  readonly authorization: AttemptAuthorization;
  readonly agentCheckpoint: AttemptCheckpoint | null;
  readonly runnerEvidence: readonly InteractiveRunnerEvidence[];
  /** The LATEST observation of the pane. History stays in the event log. */
  readonly reconciliation: ReconciliationRecord | null;
  /** ADVISORY channel. Excluded from outcome projection by construction. */
  readonly advisory: readonly AdvisoryObservation[];
  readonly controlMode: "managed" | "human_owned";
  readonly steerSubmissions: number;
  readonly steerObservations: number;
  /** When a cancel-turn was REQUESTED. Delivery is a separate fact. */
  readonly lastCancelTurnAt: number | null;
  /** When an abort was REQUESTED. Delivery is a separate fact. */
  readonly lastAbortAt: number | null;
  /**
   * Every control ever requested on this attempt, in event order. A history
   * rather than a slot: a request whose delivery was lost stays `unconfirmed`
   * forever, and the next control must not be able to erase it. `controlId` is
   * unique within the attempt for the same reason.
   */
  readonly controls: readonly ControlRecord[];
}
