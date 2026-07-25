import type { IssueRef } from "../runtime/events.ts";

export interface ResolvedIssue {
  readonly nodeId: string;
}

export interface CommentRef {
  readonly commentId: number;
  readonly commentUrl: string;
}

export type TriageLabelOutcome = "applied" | "skipped";

export interface IssueTracker {
  resolveIssue(ref: IssueRef): Promise<ResolvedIssue>;
  findCommentByMarker(
    ref: IssueRef,
    marker: string,
  ): Promise<CommentRef | null>;
  createComment(ref: IssueRef, body: string): Promise<CommentRef>;
  readCurrentLabels(ref: IssueRef): Promise<readonly string[]>;
  compareAndSetTriageLabel(
    ref: IssueRef,
    expected: string,
    next: string,
  ): Promise<TriageLabelOutcome>;
}

export interface AuthorizedIssueTargetConfig {
  /** The single issue an adapter is authorized to touch. */
  readonly authorizedTarget: IssueRef;
}

export class IssueTrackerError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
  }

  override readonly name = "IssueTrackerError";
}
