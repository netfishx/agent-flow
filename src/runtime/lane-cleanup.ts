// When a lane's disposable review worktree may be destroyed. Cleanup is the
// one irreversible act in a lane's finalization, so it is gated on the lane's
// own recorded facts: a worktree is released only once post-flight passed AND
// every artifact derived from it is safely on disk. Anything else retains the
// worktree for forensics and says why. Pure function over the projection.

import { verificationPassed } from "../review/verification.ts";
import type { LaneView } from "./reducer.ts";

export type CleanupEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

export function reviewWorktreeCleanupEligibility(
  lane: LaneView,
): CleanupEligibility {
  if (lane.kind !== "agent") {
    return { eligible: false, reason: "lane is not an agent lane" };
  }
  if (lane.worktreePath === null) {
    return { eligible: false, reason: "lane has no review worktree" };
  }
  if (lane.runtimeState === "failed_to_start") {
    // Says only what is true: nothing was released. Whether a directory exists
    // depends on how far pre-flight got, and this record must not imply one.
    return {
      eligible: false,
      reason: "lane never started; nothing was released",
    };
  }
  if (lane.isolationPost === null) {
    return {
      eligible: false,
      reason: "post-flight isolation verification was never recorded",
    };
  }
  if (!verificationPassed(lane.isolationPost)) {
    return {
      eligible: false,
      reason: `post-flight isolation verification failed: ${
        lane.isolationPost.detail ?? "verification failed"
      }`,
    };
  }
  if (lane.rawReportOutcome === null) {
    return {
      eligible: false,
      reason: "the raw report outcome was never recorded",
    };
  }
  if (lane.rawReportOutcome !== "captured") {
    return {
      eligible: false,
      reason: `the raw report was not captured (${lane.rawReportOutcome})`,
    };
  }
  if (lane.resultFile === null) {
    return {
      eligible: false,
      reason: "no derived result artifact was written",
    };
  }
  if (lane.checkpointFile === null) {
    return {
      eligible: false,
      reason: "no terminal checkpoint was written",
    };
  }
  if (lane.evidenceFile === null) {
    return { eligible: false, reason: "no runner evidence was written" };
  }
  return { eligible: true };
}
