// Deterministic refusal gate for the cross-review smokes. Both modes launch
// REAL reviewer CLIs (real model spend), so both demand an explicit owner
// authorization statement and refuse CI. The formal mode additionally
// requires the #7 issue binding target.

import { resolveIssueTarget } from "../cli/flow.ts";
import type { IssueRef } from "../runtime/events.ts";
import type { InterruptOutcome } from "../runtime/types.ts";

export type ReviewSmokeMode = "rehearsal" | "formal";

/**
 * A formal run's fixed point is defined by the spec, not by the operator: head
 * is the branch tip and base is the merge-base with the main branch. Any
 * environment override of the repository, head, or base would let a formal run
 * review something other than the branch under review while its evidence still
 * looked correct, so the override is refused rather than obeyed.
 */
const FORMAL_FORBIDDEN_OVERRIDES = [
  "FLOW_REVIEW_REPO_ROOT",
  "FLOW_REVIEW_HEAD",
  "FLOW_REVIEW_BASE",
  "FLOW_REVIEW_FAMILIES",
] as const;

export function formalOverrideRefusal(
  environment: NodeJS.ProcessEnv,
): string | null {
  for (const key of FORMAL_FORBIDDEN_OVERRIDES) {
    const value = environment[key];
    if (value !== undefined && value.length > 0) {
      return `${key} may not be set for a formal run`;
    }
  }
  return null;
}

/**
 * The bound issue must live in the repository under review. Comparing the
 * target against the origin remote stops a formal run from posting its
 * milestones onto an unrelated issue in an unrelated repository.
 */
export function issueTargetMatchesOrigin(
  target: IssueRef,
  originUrl: string,
): boolean {
  const match = originUrl
    .trim()
    .replace(/\.git$/, "")
    .match(/[/:]([^/:]+)\/([^/]+)$/);
  if (match?.[1] === undefined || match[2] === undefined) return false;
  return match[1] === target.owner && match[2] === target.repo;
}

/**
 * What a rehearsal must demonstrate before a formal run may start. Kept as a
 * pure function so the acceptance rule itself is unit-testable: an inline
 * boolean inside the smoke could only be checked by spending real model calls,
 * which is exactly how a weakened rule would go unnoticed.
 */
export interface RehearsalAcceptanceInput {
  readonly visibility: readonly { readonly family: string; readonly proven: boolean }[];
  readonly interruptSentinelNonZero: boolean;
  readonly interruptEvidenceOk: boolean;
  readonly laneCount: number;
  readonly exitedZero: number | null;
  readonly exitedNonZero: number | null;
  readonly aliveAtKill: number;
  readonly finishStatus: string | null;
}

export function rehearsalAcceptance(input: RehearsalAcceptanceInput): {
  readonly ok: boolean;
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  for (const entry of input.visibility) {
    if (!entry.proven) {
      failures.push(`${entry.family} showed no pre-completion progress`);
    }
  }
  if (input.visibility.length === 0) {
    failures.push("no CLI family was measured for visibility");
  }
  if (!input.interruptSentinelNonZero) {
    failures.push("the interrupted lane did not report a non-zero exit");
  }
  if (!input.interruptEvidenceOk) {
    failures.push("the interrupt evidence is missing or malformed");
  }
  if (input.exitedNonZero !== 1) {
    failures.push(
      `expected exactly one sacrificed lane, saw ${input.exitedNonZero}`,
    );
  }
  if (input.exitedZero !== input.laneCount - 1) {
    failures.push(
      `expected ${input.laneCount - 1} lanes to complete, saw ${input.exitedZero}`,
    );
  }
  if (input.aliveAtKill <= 0) {
    failures.push("the controller was killed with no lane still live");
  }
  if (input.finishStatus === null) {
    failures.push("the run never finished");
  } else if (input.finishStatus === "invalid") {
    failures.push("the run finished invalid");
  }
  return { ok: failures.length === 0, failures };
}

/**
 * What a formal run must have produced to count as acceptance evidence. Kept as
 * a pure function beside `rehearsalAcceptance` for the same reason: an inline
 * boolean could only be checked by spending a real six-lane run, so a weakened
 * rule would go unnoticed until the evidence was already published.
 *
 * The run's own finish status is load-bearing here. `degraded` means the run
 * itself recorded that something did not hold — a non-zero exit, a violated
 * contract, a lost raw report, a missing result — and a formal run must never
 * report `ok` over a status the runtime already refused to call `clean`.
 */
export interface FormalAcceptanceLane {
  readonly laneId: string;
  readonly runtimeState: string;
  readonly exitCode: number | null;
  readonly verificationState: string;
  readonly contractState: string;
  readonly rawReportOutcome: string | null;
  readonly resultFile: string | null;
}

export interface FormalAcceptanceInput {
  readonly finishStatus: string | null;
  readonly expectedLaneCount: number;
  readonly lanes: readonly FormalAcceptanceLane[];
  /**
   * The captured bundle's roles. A formal run's materials are entirely
   * operator-supplied, and nothing can mechanically prove the captured issue
   * text is the bound issue's. What IS checkable is that the bundle is a review
   * basis at all: both axes need materials, so an issue, a spec, and standards
   * must each be present. Whether the text matches the bound issue stays an
   * operator responsibility, recorded rather than claimed.
   */
  readonly bundleRoles: readonly string[];
}

export function formalAcceptance(input: FormalAcceptanceInput): {
  readonly ok: boolean;
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  if (input.finishStatus === null) {
    failures.push("the run never finished");
  } else if (input.finishStatus !== "clean") {
    failures.push(
      `the run finished ${input.finishStatus}, and only a clean finish is acceptance evidence`,
    );
  }
  for (const role of ["issue", "spec", "standards"] as const) {
    if (!input.bundleRoles.includes(role)) {
      failures.push(`the captured bundle carries no ${role} material`);
    }
  }
  if (input.lanes.length !== input.expectedLaneCount) {
    failures.push(
      `expected ${input.expectedLaneCount} lanes, saw ${input.lanes.length}`,
    );
  }
  for (const lane of input.lanes) {
    if (lane.runtimeState !== "exited") {
      failures.push(`lane ${lane.laneId} is ${lane.runtimeState}, not exited`);
    }
    if (lane.exitCode !== 0) {
      failures.push(`lane ${lane.laneId} exited ${lane.exitCode}`);
    }
    if (lane.contractState !== "satisfied") {
      failures.push(
        `lane ${lane.laneId} contract is ${lane.contractState}`,
      );
    }
    if (lane.verificationState !== "verified") {
      failures.push(
        `lane ${lane.laneId} runner evidence is ${lane.verificationState}`,
      );
    }
    if (lane.rawReportOutcome !== "captured") {
      failures.push(
        `lane ${lane.laneId} raw report is ${lane.rawReportOutcome}`,
      );
    }
    if (lane.resultFile === null) {
      failures.push(`lane ${lane.laneId} produced no result artifact`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * The rehearsal's interrupt evidence is objective runner output, so a missing,
 * unreadable, or malformed file is a rehearsal failure with a stated reason —
 * never a silent null that leaves the verdict looking clean.
 */
export type InterruptEvidenceRead =
  | { readonly ok: true; readonly evidence: InterruptOutcome }
  | { readonly ok: false; readonly reason: string };

export function readInterruptEvidence(
  raw: string | null,
  expectedLaneId: string,
): InterruptEvidenceRead {
  if (raw === null) {
    return { ok: false, reason: "interrupt evidence file is missing or unreadable" };
  }
  if (raw.trim().length === 0) {
    return { ok: false, reason: "interrupt evidence file is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "interrupt evidence file is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "interrupt evidence is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.laneId !== expectedLaneId) {
    return {
      ok: false,
      reason: `interrupt evidence names lane ${JSON.stringify(record.laneId)}, expected "${expectedLaneId}"`,
    };
  }
  if (typeof record.signal !== "string" || record.signal.length === 0) {
    return { ok: false, reason: "interrupt evidence carries no signal" };
  }
  if (record.delivered !== true) {
    return { ok: false, reason: "interrupt evidence does not record delivery" };
  }
  return {
    ok: true,
    evidence: {
      laneId: record.laneId,
      signal: record.signal,
      delivered: true,
    },
  };
}

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
