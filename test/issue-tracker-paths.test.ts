import { describe, expect, test } from "bun:test";
import {
  ghArgvBuilders,
  issueApiPath,
} from "../src/issue/gh-argv.ts";
import { IssueTrackerError } from "../src/issue/tracker.ts";

const issue = {
  owner: "netfishx",
  repo: "agent-flow.ts",
  number: 24,
} as const;

describe("GitHub issue API paths", () => {
  test("builds an issue path while allowing a dot inside a repository name", () => {
    expect(issueApiPath(issue)).toBe(
      "repos/netfishx/agent-flow.ts/issues/24",
    );
    expect(ghArgvBuilders.resolveIssue(issue)).toEqual([
      "api",
      "repos/netfishx/agent-flow.ts/issues/24",
      "--method",
      "GET",
    ]);
  });

  test("rejects the reported parent-segment escape", () => {
    expect(() =>
      issueApiPath({ owner: "netfishx", repo: "..", number: 24 }),
    ).toThrow(IssueTrackerError);
  });

  test.each([
    ["repo dot", { owner: "netfishx", repo: ".", number: 24 }],
    ["owner parent", { owner: "..", repo: "agent-flow", number: 24 }],
    ["owner dot", { owner: ".", repo: "agent-flow", number: 24 }],
    ["slash", { owner: "netfishx", repo: "a/b", number: 24 }],
    ["backslash", { owner: "netfishx", repo: "a\\b", number: 24 }],
    ["empty owner", { owner: "", repo: "agent-flow", number: 24 }],
    ["empty repo", { owner: "netfishx", repo: "", number: 24 }],
    ["outside class", { owner: "netfishx!", repo: "agent-flow", number: 24 }],
    ["zero", { owner: "netfishx", repo: "agent-flow", number: 0 }],
    ["negative", { owner: "netfishx", repo: "agent-flow", number: -1 }],
    ["fraction", { owner: "netfishx", repo: "agent-flow", number: 1.5 }],
    ["NaN", { owner: "netfishx", repo: "agent-flow", number: Number.NaN }],
  ])("rejects unsafe issue reference: %s", (_name, ref) => {
    try {
      issueApiPath(ref);
      throw new Error("expected issueApiPath to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(IssueTrackerError);
      expect((error as IssueTrackerError).retryable).toBe(false);
      expect((error as IssueTrackerError).reason).not.toContain(
        "repos/netfishx/../issues/24",
      );
    }
  });

  test("encodes a label as one path segment and rejects dot segments", () => {
    expect(ghArgvBuilders.removeLabel(issue, "ready / human")).toEqual([
      "api",
      "repos/netfishx/agent-flow.ts/issues/24/labels/ready%20%2F%20human",
      "--method",
      "DELETE",
    ]);

    for (const label of ["", ".", ".."]) {
      expect(() => ghArgvBuilders.removeLabel(issue, label)).toThrow(
        IssueTrackerError,
      );
    }
  });
});
