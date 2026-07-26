// The single place where GitHub API paths and `gh` argv arrays are built.

import type { IssueRef } from "../runtime/events.ts";
import { IssueTrackerError } from "./tracker.ts";

const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/;

function validateRepositorySegment(
  name: "owner" | "repo",
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    !SAFE_REPOSITORY_SEGMENT.test(value)
  ) {
    throw new IssueTrackerError(`invalid issue ${name}`, false);
  }
}

function assertSegmentCount(path: string, expected: number): string {
  if (path.split("/").length !== expected) {
    throw new IssueTrackerError("invalid GitHub API path", false);
  }
  return path;
}

function pathFromSegments(
  expectedSegmentCount: number,
  segments: readonly string[],
): string {
  return assertSegmentCount(segments.join("/"), expectedSegmentCount);
}

export function issueApiPath(ref: IssueRef): string {
  if (typeof ref !== "object" || ref === null) {
    throw new IssueTrackerError("invalid issue reference", false);
  }
  validateRepositorySegment("owner", ref.owner);
  validateRepositorySegment("repo", ref.repo);
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) {
    throw new IssueTrackerError("invalid issue number", false);
  }

  return pathFromSegments(
    5,
    ["repos", ref.owner, ref.repo, "issues", String(ref.number)],
  );
}

function commentsApiPath(ref: IssueRef): string {
  return pathFromSegments(6, [...issueApiPath(ref).split("/"), "comments"]);
}

function labelsApiPath(ref: IssueRef): string {
  return pathFromSegments(6, [...issueApiPath(ref).split("/"), "labels"]);
}

function encodedLabelSegment(label: string): string {
  if (label.length === 0 || label === "." || label === "..") {
    throw new IssueTrackerError("invalid issue label", false);
  }
  return encodeURIComponent(label);
}

function labelApiPath(ref: IssueRef, label: string): string {
  return pathFromSegments(7, [
    ...labelsApiPath(ref).split("/"),
    encodedLabelSegment(label),
  ]);
}

export const ghArgvBuilders = {
  resolveIssue(ref: IssueRef): readonly string[] {
    return ["api", issueApiPath(ref), "--method", "GET"];
  },
  listComments(ref: IssueRef): readonly string[] {
    return [
      "api",
      commentsApiPath(ref),
      "--method",
      "GET",
      "--paginate",
      "--slurp",
    ];
  },
  createComment(ref: IssueRef): readonly string[] {
    return [
      "api",
      commentsApiPath(ref),
      "--method",
      "POST",
      "--input",
      "-",
    ];
  },
  readCurrentLabels(ref: IssueRef): readonly string[] {
    return ["api", issueApiPath(ref), "--method", "GET"];
  },
  addLabel(ref: IssueRef, label: string): readonly string[] {
    encodedLabelSegment(label);
    return [
      "api",
      labelsApiPath(ref),
      "--method",
      "POST",
      "--raw-field",
      `labels[]=${label}`,
    ];
  },
  removeLabel(ref: IssueRef, label: string): readonly string[] {
    return ["api", labelApiPath(ref, label), "--method", "DELETE"];
  },
} as const;

export function createCommentStdin(body: string): string {
  return JSON.stringify({ body });
}
