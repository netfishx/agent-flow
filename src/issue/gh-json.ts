// The single place where `gh` stdout is parsed into issue-tracker port types.

import type { CommentRef, ResolvedIssue } from "./tracker.ts";
import { IssueTrackerError } from "./tracker.ts";

function parseJson(operation: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new IssueTrackerError(
      `issue tracker ${operation} response parse failure`,
      false,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResolvedIssue(raw: string): ResolvedIssue {
  const root = parseJson("resolve issue", raw);
  const nodeId = isRecord(root) ? root.node_id : undefined;
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    throw new IssueTrackerError(
      "issue tracker resolve issue response parse failure",
      false,
    );
  }
  return { nodeId };
}

interface ParsedComment {
  readonly ref: CommentRef;
  readonly body: string;
}

function parseComment(value: unknown): ParsedComment {
  const commentId = isRecord(value) ? value.id : undefined;
  const commentUrl = isRecord(value) ? value.html_url : undefined;
  const body = isRecord(value) ? value.body : undefined;
  if (
    !Number.isSafeInteger(commentId) ||
    (commentId as number) <= 0 ||
    typeof commentUrl !== "string" ||
    commentUrl.length === 0 ||
    typeof body !== "string"
  ) {
    throw new IssueTrackerError(
      "issue tracker find comment by marker response parse failure",
      false,
    );
  }
  return {
    ref: { commentId: commentId as number, commentUrl },
    body,
  };
}

function commentValues(root: unknown): readonly unknown[] {
  if (!Array.isArray(root)) {
    throw new IssueTrackerError(
      "issue tracker find comment by marker response parse failure",
      false,
    );
  }
  if (root.length === 0) return root;
  if (root.every(Array.isArray)) {
    return root.flat();
  }
  if (root.some(Array.isArray)) {
    throw new IssueTrackerError(
      "issue tracker find comment by marker response parse failure",
      false,
    );
  }
  return root;
}

export function assertMarkerArgument(marker: string): void {
  if (typeof marker !== "string" || marker.trim().length === 0) {
    throw new IssueTrackerError("issue tracker marker must not be blank", false);
  }
}

export function commentBodyHasMarkerLine(
  body: string,
  marker: string,
): boolean {
  assertMarkerArgument(marker);
  return body
    .split("\n")
    .some((line) => line.trimEnd() === marker);
}

export function parseCommentByMarker(
  raw: string,
  marker: string,
): CommentRef | null {
  assertMarkerArgument(marker);
  const values = commentValues(parseJson("find comment by marker", raw));
  const matches = values
    .map(parseComment)
    .filter((comment) => commentBodyHasMarkerLine(comment.body, marker));
  if (matches.length > 1) {
    throw new IssueTrackerError(
      "issue tracker duplicate marker condition",
      false,
    );
  }
  return matches[0]?.ref ?? null;
}

export function parseCreatedComment(raw: string): CommentRef {
  const root = parseJson("create comment", raw);
  const commentId = isRecord(root) ? root.id : undefined;
  const commentUrl = isRecord(root) ? root.html_url : undefined;
  if (
    !Number.isSafeInteger(commentId) ||
    (commentId as number) <= 0 ||
    typeof commentUrl !== "string" ||
    commentUrl.length === 0
  ) {
    throw new IssueTrackerError(
      "issue tracker create comment response parse failure",
      false,
    );
  }
  return { commentId: commentId as number, commentUrl };
}

export function parseCurrentLabels(raw: string): readonly string[] {
  const root = parseJson("read current labels", raw);
  const labels = isRecord(root) ? root.labels : undefined;
  if (!Array.isArray(labels)) {
    throw new IssueTrackerError(
      "issue tracker read current labels response parse failure",
      false,
    );
  }
  const names: string[] = [];
  for (const label of labels) {
    const name = isRecord(label) ? label.name : undefined;
    if (typeof name !== "string" || name.length === 0) {
      throw new IssueTrackerError(
        "issue tracker read current labels response parse failure",
        false,
      );
    }
    names.push(name);
  }
  return names;
}
