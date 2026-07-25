// Deterministic issue-tracker test adapter. It records every port call, exposes
// programmable results and one failure, and mirrors marker and label-transition
// semantics without spawning a process or touching GitHub.

import type { IssueRef } from "../runtime/events.ts";
import type {
  CommentRef,
  IssueTracker,
  ResolvedIssue,
  TriageLabelOutcome,
} from "./tracker.ts";
import { IssueTrackerError } from "./tracker.ts";
import {
  assertMarkerArgument,
  commentBodyHasMarkerLine,
} from "./gh-json.ts";

export type FakeIssueTrackerOperation =
  | "resolveIssue"
  | "findCommentByMarker"
  | "createComment"
  | "readCurrentLabels"
  | "compareAndSetTriageLabel";

export interface FakeIssueTrackerCall {
  readonly operation: FakeIssueTrackerOperation;
  readonly arguments: readonly unknown[];
}

export interface FakeIssueTrackerFailure {
  readonly operation: FakeIssueTrackerOperation;
  readonly retryable: boolean;
}

export interface FakeMarkerHit {
  readonly body: string;
  readonly comment: CommentRef;
}

export interface FakeIssueTrackerOptions {
  readonly resolvedIssue?: ResolvedIssue;
  readonly createdComment?: CommentRef;
  readonly markerHit?: FakeMarkerHit;
  readonly labels?: readonly string[];
  /** Program exactly one port capability to fail. */
  readonly failure?: FakeIssueTrackerFailure;
}

function assertAllowedTriageTransition(
  expected: string,
  next: string,
): void {
  if (expected !== "ready-for-agent" || next !== "needs-info") {
    throw new IssueTrackerError(
      "fake issue tracker triage label transition not authorized",
      false,
    );
  }
}

export class FakeIssueTracker implements IssueTracker {
  readonly calls: FakeIssueTrackerCall[] = [];
  private readonly resolvedIssue: ResolvedIssue;
  private readonly createdComment: CommentRef;
  private readonly markerHit: FakeMarkerHit | null;
  private readonly failure: FakeIssueTrackerFailure | null;
  private currentLabels: string[];

  constructor(options: FakeIssueTrackerOptions = {}) {
    this.resolvedIssue = options.resolvedIssue ?? {
      nodeId: "fake-issue-node",
    };
    this.createdComment = options.createdComment ?? {
      commentId: 1,
      commentUrl: "https://example.invalid/issues/1#issuecomment-1",
    };
    this.markerHit = options.markerHit ?? null;
    this.failure = options.failure ?? null;
    this.currentLabels = [...(options.labels ?? [])];
  }

  private record(
    operation: FakeIssueTrackerOperation,
    arguments_: readonly unknown[],
  ): void {
    this.calls.push({ operation, arguments: arguments_ });
    if (this.failure?.operation === operation) {
      throw new IssueTrackerError(
        `fake issue tracker ${operation} failure`,
        this.failure.retryable,
      );
    }
  }

  async resolveIssue(ref: IssueRef): Promise<ResolvedIssue> {
    this.record("resolveIssue", [ref]);
    return this.resolvedIssue;
  }

  async findCommentByMarker(
    ref: IssueRef,
    marker: string,
  ): Promise<CommentRef | null> {
    this.record("findCommentByMarker", [ref, marker]);
    assertMarkerArgument(marker);
    return this.markerHit !== null &&
      commentBodyHasMarkerLine(this.markerHit.body, marker)
      ? this.markerHit.comment
      : null;
  }

  async createComment(ref: IssueRef, body: string): Promise<CommentRef> {
    this.record("createComment", [ref, body]);
    return this.createdComment;
  }

  async readCurrentLabels(ref: IssueRef): Promise<readonly string[]> {
    this.record("readCurrentLabels", [ref]);
    return [...this.currentLabels];
  }

  async compareAndSetTriageLabel(
    ref: IssueRef,
    expected: string,
    next: string,
  ): Promise<TriageLabelOutcome> {
    this.record("compareAndSetTriageLabel", [ref, expected, next]);
    assertAllowedTriageTransition(expected, next);
    if (!this.currentLabels.includes(expected)) return "skipped";

    if (!this.currentLabels.includes(next)) {
      this.currentLabels.push(next);
    }
    this.currentLabels = this.currentLabels.filter(
      (label) => label !== expected,
    );
    return "applied";
  }
}
