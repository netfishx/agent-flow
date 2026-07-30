// Deterministic refusal gate for the cross-review smokes. Both modes launch
// REAL reviewer CLIs (real model spend), so both demand an explicit owner
// authorization statement and refuse CI. The formal mode additionally
// requires the #7 issue binding target.

import { resolveIssueTarget } from "../cli/flow.ts";
import type { IssueRef } from "../runtime/events.ts";

export type ReviewSmokeMode = "rehearsal" | "formal";

export type ReviewGateRefusalReason =
  | "review-smoke-not-enabled"
  | "owner-authorization-missing"
  | "ci-environment-refused"
  | "unknown-review-mode"
  | "issue-target-missing"
  | "issue-target-malformed";

export type ReviewGateResult =
  | {
      readonly ok: true;
      readonly mode: ReviewSmokeMode;
      /** Bound target for the formal mode; null for the unbound rehearsal. */
      readonly target: IssueRef | null;
      readonly authorizationStatement: string;
    }
  | { readonly ok: false; readonly reason: ReviewGateRefusalReason };

export function reviewSmokeGate(
  environment: NodeJS.ProcessEnv,
): ReviewGateResult {
  if (environment.FLOW_SMOKE_REVIEW !== "1") {
    return { ok: false, reason: "review-smoke-not-enabled" };
  }
  const authorizationStatement = environment.FLOW_SMOKE_OWNER_AUTHORIZATION;
  if (
    authorizationStatement === undefined ||
    authorizationStatement.length === 0
  ) {
    return { ok: false, reason: "owner-authorization-missing" };
  }
  if (environment.CI !== undefined && environment.CI.length > 0) {
    return { ok: false, reason: "ci-environment-refused" };
  }
  const mode = environment.FLOW_REVIEW_MODE ?? "rehearsal";
  if (mode !== "rehearsal" && mode !== "formal") {
    return { ok: false, reason: "unknown-review-mode" };
  }
  if (mode === "rehearsal") {
    return { ok: true, mode, target: null, authorizationStatement };
  }
  let target: IssueRef | null;
  try {
    target = resolveIssueTarget(environment);
  } catch {
    return { ok: false, reason: "issue-target-malformed" };
  }
  if (target === null) {
    return { ok: false, reason: "issue-target-missing" };
  }
  return { ok: true, mode, target, authorizationStatement };
}
