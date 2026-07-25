import { describe, expect, test } from "bun:test";
import {
  FakeIssueTracker,
  type FakeIssueTrackerOperation,
} from "../src/testing.ts";
import { IssueTrackerError } from "../src/issue/tracker.ts";
import * as production from "../src/index.ts";

const issue = {
  owner: "netfishx",
  repo: "agent-flow",
  number: 26,
} as const;
const marker = "<!-- agent-flow:delivery:run-26:1:start -->";
const markerComment = {
  commentId: 71,
  commentUrl:
    "https://github.com/netfishx/agent-flow/issues/26#issuecomment-71",
} as const;

function programmedBody(body: string) {
  return {
    body,
    comment: markerComment,
  };
}

describe("FakeIssueTracker", () => {
  test("is available only from the testing entry point", () => {
    expect("FakeIssueTracker" in production).toBe(false);
  });

  test("records every port call with arguments in order", async () => {
    const fake = new FakeIssueTracker({
      resolvedIssue: { nodeId: "I_fake" },
      createdComment: markerComment,
      labels: ["ready-for-agent"],
    });

    await fake.resolveIssue(issue);
    await fake.findCommentByMarker(issue, marker);
    await fake.createComment(issue, "delivery body");
    await fake.readCurrentLabels(issue);
    await fake.compareAndSetTriageLabel(
      issue,
      "ready-for-agent",
      "ready-for-human",
    );

    expect(fake.calls).toEqual([
      { operation: "resolveIssue", arguments: [issue] },
      { operation: "findCommentByMarker", arguments: [issue, marker] },
      { operation: "createComment", arguments: [issue, "delivery body"] },
      { operation: "readCurrentLabels", arguments: [issue] },
      {
        operation: "compareAndSetTriageLabel",
        arguments: [issue, "ready-for-agent", "ready-for-human"],
      },
    ]);
  });

  test("reports only the programmed exact marker hit", async () => {
    const fake = new FakeIssueTracker({
      markerHit: programmedBody(marker),
    });

    await expect(
      fake.findCommentByMarker(issue, marker),
    ).resolves.toEqual(markerComment);
    await expect(
      fake.findCommentByMarker(
        issue,
        "<!-- agent-flow:delivery:other:1:start -->",
      ),
    ).resolves.toBeNull();
    await expect(
      fake.findCommentByMarker(issue, "."),
    ).resolves.toBeNull();
  });

  test.each([
    [
      "underscore",
      "<!-- agent-flow:delivery:run_1:2:start -->",
    ],
    [
      "dot",
      "<!-- agent-flow:delivery:run-1:2:blocked:lane.a -->",
    ],
  ])(
    "finds an opaque marker containing a %s when it occupies its own line",
    async (_name, opaqueMarker) => {
      const fake = new FakeIssueTracker({
        markerHit: programmedBody(
          `prefix\n${opaqueMarker}\nsuffix`,
        ),
      });

      await expect(
        fake.findCommentByMarker(issue, opaqueMarker),
      ).resolves.toEqual(markerComment);
    },
  );

  test("does not match a marker that appears only inside prose", async () => {
    const fake = new FakeIssueTracker({
      markerHit: programmedBody(`prefix ${marker} suffix`),
    });

    await expect(
      fake.findCommentByMarker(issue, marker),
    ).resolves.toBeNull();
  });

  test("matches a marker line with trailing whitespace and carriage return", async () => {
    const opaqueMarker =
      "<!-- agent-flow:delivery:run_1:2:start -->";
    const fake = new FakeIssueTracker({
      markerHit: programmedBody(
        `prefix\n${opaqueMarker} \t\r\nsuffix`,
      ),
    });

    await expect(
      fake.findCommentByMarker(issue, opaqueMarker),
    ).resolves.toEqual(markerComment);
  });

  test.each(["", " \t\r\n"])(
    "rejects an empty or whitespace-only marker non-retryably",
    async (invalidMarker) => {
      const fake = new FakeIssueTracker({
        markerHit: programmedBody(invalidMarker),
      });

      await expect(
        fake.findCommentByMarker(issue, invalidMarker),
      ).rejects.toMatchObject({
        name: "IssueTrackerError",
        retryable: false,
      });
    },
  );

  test.each([
    ["resolveIssue", (fake: FakeIssueTracker) => fake.resolveIssue(issue)],
    [
      "findCommentByMarker",
      (fake: FakeIssueTracker) =>
        fake.findCommentByMarker(issue, marker),
    ],
    [
      "createComment",
      (fake: FakeIssueTracker) => fake.createComment(issue, "body"),
    ],
    [
      "readCurrentLabels",
      (fake: FakeIssueTracker) => fake.readCurrentLabels(issue),
    ],
    [
      "compareAndSetTriageLabel",
      (fake: FakeIssueTracker) =>
        fake.compareAndSetTriageLabel(
          issue,
          "ready-for-agent",
          "ready-for-human",
        ),
    ],
  ] as const)(
    "can fail %s with the chosen retryability",
    async (operation, invoke) => {
      const fake = new FakeIssueTracker({
        failure: {
          operation: operation as FakeIssueTrackerOperation,
          retryable: operation === "resolveIssue",
        },
      });

      try {
        await invoke(fake);
        throw new Error("expected fake operation to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(IssueTrackerError);
        expect((error as IssueTrackerError).retryable).toBe(
          operation === "resolveIssue",
        );
      }
      expect(fake.calls).toHaveLength(1);
    },
  );

  test("uses chosen labels and applies compare-and-set semantics", async () => {
    const fake = new FakeIssueTracker({
      labels: ["ready-for-agent", "bug"],
    });

    await expect(
      fake.compareAndSetTriageLabel(
        issue,
        "ready-for-agent",
        "ready-for-human",
      ),
    ).resolves.toBe("applied");
    await expect(fake.readCurrentLabels(issue)).resolves.toEqual([
      "bug",
      "ready-for-human",
    ]);
  });

  test("skips without changing a later human label", async () => {
    const fake = new FakeIssueTracker({
      labels: ["ready-for-human"],
    });

    await expect(
      fake.compareAndSetTriageLabel(
        issue,
        "ready-for-agent",
        "needs-info",
      ),
    ).resolves.toBe("skipped");
    await expect(fake.readCurrentLabels(issue)).resolves.toEqual([
      "ready-for-human",
    ]);
  });
});
