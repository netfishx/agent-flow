import { describe, expect, test } from "bun:test";
import {
  formalOverrideRefusal,
  issueTargetMatchesOrigin,
  readInterruptEvidence,
  reviewSmokeGate,
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
