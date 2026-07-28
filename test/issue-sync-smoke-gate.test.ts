import { describe, expect, test } from "bun:test";
import { issueSyncGate } from "../src/smoke/issue-sync-gate.ts";

const acceptedEnvironment = {
  FLOW_SMOKE_REAL_GITHUB: "1",
  FLOW_SMOKE_OWNER_AUTHORIZATION: "Owner approved this smoke run.",
  FLOW_ISSUE_TARGET: "example/agent-flow-smoke#101",
} satisfies NodeJS.ProcessEnv;

describe("real-GitHub issue-sync smoke authorization gate", () => {
  test("refuses unless the real-GitHub enable switch is exactly 1", () => {
    for (const configured of [undefined, "", "0", "true"]) {
      expect(
        issueSyncGate({
          ...acceptedEnvironment,
          FLOW_SMOKE_REAL_GITHUB: configured,
        }),
      ).toEqual({
        ok: false,
        reason: "real-github-smoke-not-enabled",
      });
    }
  });

  test("refuses a missing or empty owner authorization statement", () => {
    for (const configured of [undefined, ""]) {
      expect(
        issueSyncGate({
          ...acceptedEnvironment,
          FLOW_SMOKE_OWNER_AUTHORIZATION: configured,
        }),
      ).toEqual({
        ok: false,
        reason: "owner-authorization-missing",
      });
    }
  });

  test("refuses every non-empty CI setting", () => {
    for (const configured of ["1", "true", "false", "0"]) {
      expect(
        issueSyncGate({
          ...acceptedEnvironment,
          CI: configured,
        }),
      ).toEqual({
        ok: false,
        reason: "ci-environment-refused",
      });
    }
  });

  test("refuses an absent issue target", () => {
    expect(
      issueSyncGate({
        ...acceptedEnvironment,
        FLOW_ISSUE_TARGET: undefined,
      }),
    ).toEqual({
      ok: false,
      reason: "issue-target-missing",
    });
  });

  test.each([
    "",
    "example/agent-flow-smoke",
    "example/agent-flow-smoke#0",
    "example/agent/flow#101",
  ])("refuses malformed issue target %p", (configured) => {
    expect(
      issueSyncGate({
        ...acceptedEnvironment,
        FLOW_ISSUE_TARGET: configured,
      }),
    ).toEqual({
      ok: false,
      reason: "issue-target-malformed",
    });
  });

  test("refuses protected specification issue #6 despite case variance", () => {
    expect(
      issueSyncGate({
        ...acceptedEnvironment,
        FLOW_ISSUE_TARGET: "NETFISHX/Agent-Flow#6",
      }),
    ).toEqual({
      ok: false,
      reason: "protected-specification-issue",
    });
  });

  test("accepts an authorized non-CI target and echoes the authorization", () => {
    expect(issueSyncGate(acceptedEnvironment)).toEqual({
      ok: true,
      target: {
        owner: "example",
        repo: "agent-flow-smoke",
        number: 101,
      },
      authorizationStatement: "Owner approved this smoke run.",
    });
  });
});
