import { resolveIssueTarget } from "../cli/flow.ts";
import type { IssueRef } from "../runtime/events.ts";

export type IssueSyncGateRefusalReason =
  | "real-github-smoke-not-enabled"
  | "owner-authorization-missing"
  | "ci-environment-refused"
  | "issue-target-missing"
  | "issue-target-malformed"
  | "protected-specification-issue";

export type IssueSyncGateResult =
  | {
      readonly ok: true;
      readonly target: IssueRef;
      readonly authorizationStatement: string;
    }
  | {
      readonly ok: false;
      readonly reason: IssueSyncGateRefusalReason;
    };

function protectedSpecificationIssue(target: IssueRef): boolean {
  return (
    target.owner.toLowerCase() === "netfishx" &&
    target.repo.toLowerCase() === "agent-flow" &&
    target.number === 6
  );
}

export function issueSyncGate(
  environment: NodeJS.ProcessEnv,
): IssueSyncGateResult {
  if (environment.FLOW_SMOKE_REAL_GITHUB !== "1") {
    return { ok: false, reason: "real-github-smoke-not-enabled" };
  }
  const authorizationStatement =
    environment.FLOW_SMOKE_OWNER_AUTHORIZATION;
  if (
    authorizationStatement === undefined ||
    authorizationStatement.length === 0
  ) {
    return { ok: false, reason: "owner-authorization-missing" };
  }
  if (environment.CI !== undefined && environment.CI.length > 0) {
    return { ok: false, reason: "ci-environment-refused" };
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
  if (protectedSpecificationIssue(target)) {
    return { ok: false, reason: "protected-specification-issue" };
  }
  return { ok: true, target, authorizationStatement };
}
