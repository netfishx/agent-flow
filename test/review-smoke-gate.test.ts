import { describe, expect, test } from "bun:test";
import { reviewSmokeGate } from "../src/smoke/review-gate.ts";

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
