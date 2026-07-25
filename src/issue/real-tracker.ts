// Real issue-tracker adapter. It authorizes one immutable GitHub issue target,
// builds every request through gh-argv, parses stdout through gh-json, and owns
// process/HTTP failure classification without exposing gh details to callers.

import type { IssueRef } from "../runtime/events.ts";
import {
  createCommentStdin,
  ghArgvBuilders,
  issueApiPath,
} from "./gh-argv.ts";
import {
  assertMarkerArgument,
  parseCommentByMarker,
  parseCreatedComment,
  parseCurrentLabels,
  parseResolvedIssue,
} from "./gh-json.ts";
import type {
  AuthorizedIssueTargetConfig,
  CommentRef,
  IssueTracker,
  ResolvedIssue,
  TriageLabelOutcome,
} from "./tracker.ts";
import { IssueTrackerError } from "./tracker.ts";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type GhOperation =
  | "resolve issue"
  | "find comment by marker"
  | "create comment"
  | "read current labels"
  | "add triage label"
  | "remove triage label";

type CommandRunner = (
  argv: readonly string[],
  stdin: string | null,
) => Promise<CommandResult>;

export interface RealIssueTrackerOptions extends AuthorizedIssueTargetConfig {
  /** Path to the gh binary. Defaults to "gh" on PATH. */
  readonly binary?: string;
  /** Injectable command runner, so tests never spawn a process. */
  readonly run?: CommandRunner;
}

export function classifyGhFailure(
  operation: GhOperation,
  stderr: string,
): IssueTrackerError {
  const statusMatch = stderr.match(/HTTP\s+([0-9]{3})/i);
  const status =
    statusMatch?.[1] === undefined
      ? null
      : Number.parseInt(statusMatch[1], 10);
  const secondaryRateLimit =
    /secondary[- ]rate[- ]limit|retry[- ]after/i.test(stderr);
  const retryable =
    status === null ||
    status === 429 ||
    status >= 500 ||
    (status === 403 && secondaryRateLimit);
  const statusDetail = status === null ? "" : ` (HTTP ${status})`;
  return new IssueTrackerError(
    `issue tracker ${operation} failed${statusDetail}`,
    retryable,
  );
}

function sameTarget(left: IssueRef, right: IssueRef): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number
  );
}

function isProtectedSpecificationIssue(ref: IssueRef): boolean {
  return (
    ref.owner.toLowerCase() === "netfishx" &&
    ref.repo.toLowerCase() === "agent-flow" &&
    ref.number === 6
  );
}

function assertAllowedTriageTransition(
  expected: string,
  next: string,
): void {
  if (expected !== "ready-for-agent" || next !== "needs-info") {
    throw new IssueTrackerError(
      "issue tracker triage label transition not authorized",
      false,
    );
  }
}

async function spawnGh(
  binary: string,
  argv: readonly string[],
  stdin: string | null,
): Promise<CommandResult> {
  const proc = Bun.spawn([binary, ...argv], {
    stdin: stdin === null ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export class RealIssueTracker implements IssueTracker {
  private readonly authorizedTarget: IssueRef;
  private readonly runCommand: CommandRunner;

  constructor(options: RealIssueTrackerOptions) {
    if (options?.authorizedTarget === undefined) {
      throw new IssueTrackerError(
        "issue tracker authorized target is required",
        false,
      );
    }
    issueApiPath(options.authorizedTarget);
    if (isProtectedSpecificationIssue(options.authorizedTarget)) {
      throw new IssueTrackerError(
        "issue tracker protected specification target refused",
        false,
      );
    }
    this.authorizedTarget = Object.freeze({ ...options.authorizedTarget });
    const binary = options.binary ?? "gh";
    this.runCommand =
      options.run ??
      ((argv, stdin) => spawnGh(binary, argv, stdin));
  }

  private authorize(ref: IssueRef): IssueRef {
    issueApiPath(ref);
    if (isProtectedSpecificationIssue(ref)) {
      throw new IssueTrackerError(
        "issue tracker protected specification target refused",
        false,
      );
    }
    if (!sameTarget(ref, this.authorizedTarget)) {
      throw new IssueTrackerError("issue tracker target not authorized", false);
    }
    return this.authorizedTarget;
  }

  private async run(
    operation: GhOperation,
    argv: readonly string[],
    stdin: string | null,
  ): Promise<string> {
    let result: CommandResult;
    try {
      result = await this.runCommand(argv, stdin);
    } catch (error) {
      if (error instanceof IssueTrackerError) throw error;
      throw classifyGhFailure(operation, "");
    }
    if (result.exitCode !== 0) {
      throw classifyGhFailure(operation, result.stderr);
    }
    return result.stdout;
  }

  async resolveIssue(ref: IssueRef): Promise<ResolvedIssue> {
    const target = this.authorize(ref);
    const stdout = await this.run(
      "resolve issue",
      ghArgvBuilders.resolveIssue(target),
      null,
    );
    return parseResolvedIssue(stdout);
  }

  async findCommentByMarker(
    ref: IssueRef,
    marker: string,
  ): Promise<CommentRef | null> {
    const target = this.authorize(ref);
    assertMarkerArgument(marker);
    const stdout = await this.run(
      "find comment by marker",
      ghArgvBuilders.listComments(target),
      null,
    );
    return parseCommentByMarker(stdout, marker);
  }

  async createComment(ref: IssueRef, body: string): Promise<CommentRef> {
    const target = this.authorize(ref);
    const stdout = await this.run(
      "create comment",
      ghArgvBuilders.createComment(target),
      createCommentStdin(body),
    );
    return parseCreatedComment(stdout);
  }

  async readCurrentLabels(ref: IssueRef): Promise<readonly string[]> {
    const target = this.authorize(ref);
    const stdout = await this.run(
      "read current labels",
      ghArgvBuilders.readCurrentLabels(target),
      null,
    );
    return parseCurrentLabels(stdout);
  }

  async compareAndSetTriageLabel(
    ref: IssueRef,
    expected: string,
    next: string,
  ): Promise<TriageLabelOutcome> {
    assertAllowedTriageTransition(expected, next);
    const target = this.authorize(ref);
    const labels = await this.readCurrentLabels(target);
    if (!labels.includes(expected)) return "skipped";

    await this.run(
      "add triage label",
      ghArgvBuilders.addLabel(target, next),
      null,
    );
    await this.run(
      "remove triage label",
      ghArgvBuilders.removeLabel(target, expected),
      null,
    );
    return "applied";
  }
}
