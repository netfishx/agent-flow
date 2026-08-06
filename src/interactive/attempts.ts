// Attempt outcome projection, and the seam that keeps advisory state out of it.

import type {
  AttemptDisposition,
  InteractiveAttemptView,
} from "./types.ts";

/**
 * The subset of an attempt an outcome may be computed from.
 *
 * `advisory?: never` is the enforcement, not a comment: an
 * `InteractiveAttemptView` carries `advisory: readonly AdvisoryObservation[]`
 * and is therefore NOT assignable here, so no caller can hand the whole attempt
 * to a projection and let a `done` label leak into a completion decision. The
 * only way through is `objectiveFactsOf`, which drops the channel.
 */
export type ObjectiveAttemptFacts = Omit<InteractiveAttemptView, "advisory"> & {
  readonly advisory?: never;
};

export function objectiveFactsOf(
  attempt: InteractiveAttemptView,
): ObjectiveAttemptFacts {
  const { advisory: _advisory, ...objective } = attempt;
  return objective;
}

/**
 * Completion evidence, as the owner's ruling defines it: the Agent's own
 * checkpoint AND at least one independent runner record that captured a real
 * exit code. Either alone is a claim; the session's exit code is neither.
 */
function hasCompletionEvidence(facts: ObjectiveAttemptFacts): boolean {
  const checkpoint = facts.agentCheckpoint;
  if (checkpoint === null) return false;
  if (checkpoint.origin !== "agent") return false;
  if (checkpoint.semanticState !== "complete") return false;
  return facts.runnerEvidence.some((record) => record.exitCode !== null);
}

/**
 * Precedence, highest first:
 *
 *  1. a pane that was reoccupied or gone — fail closed to `unknown`, whatever
 *     evidence exists, because nothing can vouch for what produced it;
 *  2. an explicit abort or cancel-turn end — the human ended it, and that fact
 *     outranks any inference;
 *  3. a human retried past it — `superseded`;
 *  4. completion evidence — `completed`;
 *  5. still live — `running`;
 *  6. anything else — `unknown`, never a guess.
 */
export function projectAttemptDisposition(
  facts: ObjectiveAttemptFacts,
): AttemptDisposition {
  const reconciliation = facts.reconciliation;
  if (reconciliation !== null && reconciliation.outcome !== "live") {
    return "unknown";
  }
  if (facts.endReason === "aborted") return "aborted";
  if (facts.endReason === "interrupted") return "interrupted";
  if (facts.supersededBy !== null) return "superseded";
  if (hasCompletionEvidence(facts)) return "completed";
  if (facts.endedAt === null) return "running";
  return "unknown";
}

/** Convenience for callers holding a full attempt; the drop is explicit. */
export function attemptDisposition(
  attempt: InteractiveAttemptView,
): AttemptDisposition {
  return projectAttemptDisposition(objectiveFactsOf(attempt));
}
