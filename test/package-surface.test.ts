// The package entry's own promise, enforced: pane identifiers, tab identifiers,
// Herdr JSON, sentinels, wait-output, and shell quoting live behind the adapter
// seam and never reach a consumer. A command builder emits a sentinel token and
// shell-quoted argv, so publishing one would break that promise — and the only
// consumer that ever wanted it was a test, which imports it by internal path.

import { describe, expect, test } from "bun:test";
import * as entry from "../src/index.ts";
import { realRuntimeDeps } from "../src/cli/flow.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import { buildAgentLaneCommand } from "../src/review/commands.ts";

describe("package entry surface", () => {
  test.each([
    "buildAgentLaneCommand",
    "buildAgentCliArgv",
    "buildLaneCommand",
    "diffHashOf",
    // Agent-specific output parsers: one CLI family's stream shape and its
    // session-id banner are implementation mechanics, not package surface.
    "extractClaudeReport",
    "parseCodexSessionId",
    "parseCodexTokensUsed",
  ])("does not publish %s", (name) => {
    expect(Object.keys(entry)).not.toContain(name);
  });

  test("still publishes the review vocabulary and the isolation port", () => {
    // The runtime's own deterministic input builder is not an Agent parser.
    expect(Object.keys(entry)).toContain("assembleBrief");
    expect(Object.keys(entry)).toContain("verificationPassed");
    expect(Object.keys(entry)).toContain("GitReviewIsolation");
    expect(Object.keys(entry)).toContain("validateReportContract");
  });

  test("the withheld builder is reachable by internal path", () => {
    // Proves the export was withdrawn, not the capability.
    expect(typeof buildAgentLaneCommand).toBe("function");
  });
});

describe("real CLI runtime wiring", () => {
  // A resuming controller without the review-isolation port fails post-flight
  // closed and marks an otherwise good run invalid. Every runtime test injects
  // its own deps, so only this call-site assertion catches that regression.
  test("carries the review-isolation port and a session id generator", () => {
    const deps = realRuntimeDeps(new InMemoryLedger(), null);
    expect(deps.reviewIsolation).toBeDefined();
    expect(typeof deps.reviewIsolation!.verifyWorktree).toBe("function");
    expect(typeof deps.reviewIsolation!.createWorktree).toBe("function");
    expect(typeof deps.reviewIsolation!.removeWorktree).toBe("function");
    expect(typeof deps.sessionIdgen).toBe("function");
    // Pre-assigned session ids must be distinct per lane, never a constant.
    expect(deps.sessionIdgen!()).not.toBe(deps.sessionIdgen!());
  });

  test("binds an issue tracker only when a target is authorized", () => {
    expect(realRuntimeDeps(new InMemoryLedger(), null).issueTracker).toBeUndefined();
    expect(
      realRuntimeDeps(new InMemoryLedger(), {
        owner: "netfishx",
        repo: "agent-flow",
        number: 7,
      }).issueTracker,
    ).toBeDefined();
  });
});
