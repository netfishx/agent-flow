import { describe, expect, test } from "bun:test";
import {
  formalAcceptance,
  formalOverrideRefusal,
  issueTargetMatchesOrigin,
  readInterruptEvidence,
  rehearsalAcceptance,
  reviewSmokeGate,
  type FormalAcceptanceInput,
  type FormalAcceptanceLane,
  type RehearsalAcceptanceInput,
} from "../src/smoke/review-gate.ts";

const AUTHORIZED = {
  FLOW_SMOKE_REVIEW: "1",
  FLOW_SMOKE_OWNER_AUTHORIZATION: "owner authorized real reviewer spend",
};

describe("reviewSmokeGate", () => {
  test("refuses without the explicit enable flag", () => {
    expect(reviewSmokeGate({})).toEqual({
      ok: false,
      reason: "review-smoke-not-enabled",
    });
  });

  test("refuses without an owner authorization statement", () => {
    expect(reviewSmokeGate({ FLOW_SMOKE_REVIEW: "1" })).toEqual({
      ok: false,
      reason: "owner-authorization-missing",
    });
  });

  test("refuses CI environments", () => {
    expect(reviewSmokeGate({ ...AUTHORIZED, CI: "true" })).toEqual({
      ok: false,
      reason: "ci-environment-refused",
    });
  });

  test("refuses an unknown review mode", () => {
    expect(
      reviewSmokeGate({ ...AUTHORIZED, FLOW_REVIEW_MODE: "dress" }),
    ).toEqual({ ok: false, reason: "unknown-review-mode" });
  });

  test("rehearsal passes unbound", () => {
    expect(reviewSmokeGate(AUTHORIZED)).toEqual({
      ok: true,
      mode: "rehearsal",
      target: null,
      authorizationStatement: AUTHORIZED.FLOW_SMOKE_OWNER_AUTHORIZATION,
    });
  });

  test("formal requires a well-formed issue target", () => {
    expect(
      reviewSmokeGate({ ...AUTHORIZED, FLOW_REVIEW_MODE: "formal" }),
    ).toEqual({ ok: false, reason: "issue-target-missing" });
    expect(
      reviewSmokeGate({
        ...AUTHORIZED,
        FLOW_REVIEW_MODE: "formal",
        FLOW_ISSUE_TARGET: "not-a-target",
      }),
    ).toEqual({ ok: false, reason: "issue-target-malformed" });
    expect(
      reviewSmokeGate({
        ...AUTHORIZED,
        FLOW_REVIEW_MODE: "formal",
        FLOW_ISSUE_TARGET: "netfishx/agent-flow#7",
      }),
    ).toEqual({
      ok: true,
      mode: "formal",
      target: { owner: "netfishx", repo: "agent-flow", number: 7 },
      authorizationStatement: AUTHORIZED.FLOW_SMOKE_OWNER_AUTHORIZATION,
    });
  });
});

describe("formal run target pinning", () => {
  // A formal run reviews the branch tip against its merge-base, in the
  // repository under review. Letting an environment variable redirect any of
  // those would produce evidence that looked correct about the wrong tree.
  test.each([
    "FLOW_REVIEW_REPO_ROOT",
    "FLOW_REVIEW_HEAD",
    "FLOW_REVIEW_BASE",
    "FLOW_REVIEW_FAMILIES",
  ])("refuses a formal run that overrides %s", (key) => {
    expect(formalOverrideRefusal({ [key]: "anything" })).toBe(
      `${key} may not be set for a formal run`,
    );
  });

  test("accepts an environment that overrides none of them", () => {
    expect(formalOverrideRefusal({ FLOW_REVIEW_MODE: "formal" })).toBeNull();
    // An empty value is not an override.
    expect(formalOverrideRefusal({ FLOW_REVIEW_HEAD: "" })).toBeNull();
  });

  test("binds only to an issue in the repository under review", () => {
    const target = { owner: "netfishx", repo: "agent-flow", number: 7 };
    for (const origin of [
      "https://github.com/netfishx/agent-flow.git\n",
      "git@github.com:netfishx/agent-flow.git",
      "https://github.com/netfishx/agent-flow",
    ]) {
      expect(issueTargetMatchesOrigin(target, origin)).toBeTrue();
    }
    for (const origin of [
      "https://github.com/someone-else/agent-flow.git",
      "https://github.com/netfishx/other-repo.git",
      "not-a-remote",
    ]) {
      expect(issueTargetMatchesOrigin(target, origin)).toBeFalse();
    }
  });
});

describe("readInterruptEvidence", () => {
  const valid = JSON.stringify({
    laneId: "codex-spec",
    signal: "SIGINT",
    delivered: true,
  });

  test("accepts objective evidence for the interrupted lane", () => {
    expect(readInterruptEvidence(valid, "codex-spec")).toEqual({
      ok: true,
      evidence: { laneId: "codex-spec", signal: "SIGINT", delivered: true },
    });
  });

  // Losing the evidence must fail the rehearsal with a stated reason. Turning
  // it into a silent null would leave the verdict looking clean.
  test.each([
    [null, "missing or unreadable"],
    ["", "empty"],
    ["  ", "empty"],
    ["{not json", "not valid JSON"],
    ["null", "not an object"],
    ["[]", 'names lane undefined'],
    [JSON.stringify({ laneId: "other", signal: "SIGINT", delivered: true }), "expected"],
    [JSON.stringify({ laneId: "codex-spec", delivered: true }), "carries no signal"],
    [
      JSON.stringify({ laneId: "codex-spec", signal: "SIGINT", delivered: false }),
      "does not record delivery",
    ],
  ])("refuses %p", (raw, fragment) => {
    const read = readInterruptEvidence(raw as string | null, "codex-spec");
    expect(read.ok).toBeFalse();
    expect(read.ok === false ? read.reason : "").toContain(fragment as string);
  });
});

describe("rehearsalAcceptance", () => {
  const passing: RehearsalAcceptanceInput = {
    visibility: [
      { family: "claude", proven: true },
      { family: "codex", proven: true },
      { family: "grok", proven: true },
    ],
    interruptSentinelNonZero: true,
    interruptEvidenceOk: true,
    laneCount: 6,
    exitedZero: 5,
    exitedNonZero: 1,
    aliveAtKill: 5,
    finishStatus: "degraded",
  };

  test("accepts a rehearsal that demonstrated everything it must", () => {
    expect(rehearsalAcceptance(passing)).toEqual({ ok: true, failures: [] });
  });

  // Each demonstration is load-bearing on its own: a rehearsal that skipped
  // any one of them must not license a formal run.
  test.each([
    [
      "a silent CLI family",
      {
        visibility: [
          { family: "claude", proven: true },
          { family: "grok", proven: false },
        ],
      },
      "grok showed no pre-completion progress",
    ],
    [
      "no family measured at all",
      { visibility: [] },
      "no CLI family was measured",
    ],
    [
      "an interrupt that reported exit 0",
      { interruptSentinelNonZero: false },
      "did not report a non-zero exit",
    ],
    [
      "lost interrupt evidence",
      { interruptEvidenceOk: false },
      "interrupt evidence is missing or malformed",
    ],
    [
      "two sacrificed lanes",
      { exitedZero: 4, exitedNonZero: 2 },
      "expected exactly one sacrificed lane, saw 2",
    ],
    [
      "a sibling lane that did not complete",
      { exitedZero: 4, exitedNonZero: 1 },
      "expected 5 lanes to complete, saw 4",
    ],
    [
      "a controller killed with nothing live",
      { aliveAtKill: 0 },
      "no lane still live",
    ],
    ["a run that never finished", { finishStatus: null }, "never finished"],
    ["an invalid run", { finishStatus: "invalid" }, "finished invalid"],
  ])("refuses %s", (_name, overrides, fragment) => {
    const verdict = rehearsalAcceptance({
      ...passing,
      ...(overrides as Partial<RehearsalAcceptanceInput>),
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.failures.join(" | ")).toContain(fragment as string);
  });
});

describe("formalAcceptance", () => {
  const lane = (overrides: Partial<FormalAcceptanceLane> = {}): FormalAcceptanceLane => ({
    laneId: "codex-spec",
    runtimeState: "exited",
    exitCode: 0,
    verificationState: "verified",
    contractState: "satisfied",
    rawReportOutcome: "captured",
    resultFile: "results/codex-spec-result.txt",
    ...overrides,
  });
  const passing: FormalAcceptanceInput = {
    finishStatus: "clean",
    expectedLaneCount: 2,
    lanes: [lane({ laneId: "claude-spec" }), lane()],
    bundleRoles: ["issue", "spec", "standards", "standards"],
    deliveries: [
      { kind: "start", state: "delivered" },
      { kind: "complete", state: "delivered" },
    ],
  };

  test("accepts a clean run whose every lane produced a verified report", () => {
    expect(formalAcceptance(passing)).toEqual({ ok: true, failures: [] });
  });

  // The rule that changed: `degraded` is the runtime's own statement that
  // something did not hold. A formal run must not report ok over it, however
  // well-formed the six reports happen to be.
  test("refuses a degraded run even when every contract is satisfied", () => {
    const verdict = formalAcceptance({ ...passing, finishStatus: "degraded" });
    expect(verdict.ok).toBeFalse();
    expect(verdict.failures.join(" | ")).toContain(
      "the run finished degraded, and only a clean finish is acceptance evidence",
    );
  });

  test("refuses a non-zero exit whose report still satisfied the contract", () => {
    // Exactly the shape the old criterion let through: runtimeState is still
    // `exited`, the contract is satisfied, and only the exit code dissents.
    const verdict = formalAcceptance({
      ...passing,
      finishStatus: "degraded",
      lanes: [lane({ laneId: "claude-spec" }), lane({ exitCode: 1 })],
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.failures.join(" | ")).toContain("lane codex-spec exited 1");
  });

  test.each([
    ["an unfinished run", { finishStatus: null }, "never finished"],
    ["an invalid run", { finishStatus: "invalid" }, "the run finished invalid"],
    [
      "a missing lane",
      { expectedLaneCount: 6 },
      "expected 6 lanes, saw 2",
    ],
    // Both axes need materials; a bundle missing a role is not a review basis.
    [
      "a bundle with no issue material",
      { bundleRoles: ["spec", "standards"] },
      "carries no issue material",
    ],
    [
      "a bundle with no spec material",
      { bundleRoles: ["issue", "standards"] },
      "carries no spec material",
    ],
    [
      "a bundle with no standards material",
      { bundleRoles: ["issue", "spec"] },
      "carries no standards material",
    ],
    // Acceptance evidence includes real milestones on the bound issue, so a
    // delivery that never landed must not pass.
    [
      "a complete milestone that never delivered",
      { deliveries: [{ kind: "start", state: "delivered" }] },
      "the complete milestone was never delivered",
    ],
    [
      "a start milestone left pending",
      {
        deliveries: [
          { kind: "start", state: "pending" },
          { kind: "complete", state: "delivered" },
        ],
      },
      "the start milestone delivery is pending, not delivered",
    ],
    [
      "a failed complete delivery",
      {
        deliveries: [
          { kind: "start", state: "delivered" },
          { kind: "complete", state: "failed" },
        ],
      },
      "the complete milestone delivery is failed, not delivered",
    ],
  ])("refuses %s", (_name, overrides, fragment) => {
    const verdict = formalAcceptance({
      ...passing,
      ...(overrides as Partial<FormalAcceptanceInput>),
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.failures.join(" | ")).toContain(fragment as string);
  });

  test.each([
    [{ runtimeState: "crashed" }, "is crashed, not exited"],
    [{ contractState: "violated" }, "contract is violated"],
    [{ verificationState: "failed" }, "runner evidence is failed"],
    [{ rawReportOutcome: "missing" }, "raw report is missing"],
    [{ rawReportOutcome: "underivable" }, "raw report is underivable"],
    [{ rawReportOutcome: null }, "raw report is null"],
    [{ resultFile: null }, "produced no result artifact"],
  ])("refuses a lane with %p", (overrides, fragment) => {
    const verdict = formalAcceptance({
      ...passing,
      lanes: [lane({ laneId: "claude-spec" }), lane(overrides)],
    });
    expect(verdict.ok).toBeFalse();
    expect(verdict.failures.join(" | ")).toContain(fragment as string);
  });
});
