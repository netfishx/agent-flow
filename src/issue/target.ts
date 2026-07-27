import type { IssueRef } from "../runtime/events.ts";

export function sameIssueTarget(
  left: IssueRef,
  right: IssueRef,
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number
  );
}
