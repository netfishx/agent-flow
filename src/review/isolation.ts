// The review-isolation port: fixed-point capture, detached review worktree
// lifecycle, and pre/post-flight verification. The runtime depends on the
// narrow port alone; this file also provides the real git implementation,
// integration-tested against throwaway repositories.

import { createHash } from "node:crypto";
import type { FixedPoint } from "../runtime/events.ts";
import type {
  CaptureFixedPointInput,
  WorktreeVerification,
} from "./types.ts";
import { failedVerification } from "./verification.ts";

export interface ReviewIsolationPort {
  /** Resolve and freeze the fixed point under review. */
  captureFixedPoint(input: CaptureFixedPointInput): Promise<FixedPoint>;

  /** Create a detached, disposable worktree at the captured head. */
  createWorktree(input: {
    readonly repoRoot: string;
    readonly headCommit: string;
    readonly path: string;
  }): Promise<void>;

  /** Verify HEAD, clean state, and the base..head diff hash in a worktree. */
  verifyWorktree(input: {
    readonly path: string;
    readonly fixedPoint: FixedPoint;
  }): Promise<WorktreeVerification>;

  /** Remove a review worktree after post-flight passed and artifacts landed. */
  removeWorktree(input: {
    readonly repoRoot: string;
    readonly path: string;
  }): Promise<void>;
}

interface GitRunner {
  (cwd: string, args: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

const bunGit: GitRunner = async (cwd, args) => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export function diffHashOf(diff: string): string {
  return `sha256:${createHash("sha256").update(diff, "utf8").digest("hex")}`;
}

export class GitReviewIsolation implements ReviewIsolationPort {
  constructor(
    private readonly git: GitRunner = bunGit,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private async gitOk(
    cwd: string,
    args: readonly string[],
  ): Promise<string> {
    const { exitCode, stdout, stderr } = await this.git(cwd, args);
    if (exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    return stdout;
  }

  /**
   * Resolve and freeze the fixed point. With `dirtyStatePolicy: "reject"` a
   * dirty source checkout refuses capture — the formal-run policy.
   */
  async captureFixedPoint(input: CaptureFixedPointInput): Promise<FixedPoint> {
    const baseCommit = (
      await this.gitOk(input.repoRoot, ["rev-parse", `${input.baseRef}^{commit}`])
    ).trim();
    const headCommit = (
      await this.gitOk(input.repoRoot, ["rev-parse", `${input.headRef}^{commit}`])
    ).trim();
    if (input.dirtyStatePolicy === "reject") {
      const status = await this.gitOk(input.repoRoot, ["status", "--porcelain"]);
      if (status.trim().length > 0) {
        throw new Error(
          "fixed-point capture rejected: the source checkout is dirty",
        );
      }
    }
    const diff = await this.gitOk(input.repoRoot, [
      "diff",
      `${baseCommit}..${headCommit}`,
    ]);
    if (diff.length === 0) {
      throw new Error("fixed-point capture rejected: the diff is empty");
    }
    return {
      repoRoot: input.repoRoot,
      baseCommit,
      headCommit,
      diffHash: diffHashOf(diff),
      dirtyStatePolicy: input.dirtyStatePolicy,
      capturedAt: this.clock(),
    };
  }

  async createWorktree(input: {
    readonly repoRoot: string;
    readonly headCommit: string;
    readonly path: string;
  }): Promise<void> {
    await this.gitOk(input.repoRoot, [
      "worktree",
      "add",
      "--detach",
      input.path,
      input.headCommit,
    ]);
  }

  async verifyWorktree(input: {
    readonly path: string;
    readonly fixedPoint: FixedPoint;
  }): Promise<WorktreeVerification> {
    try {
      const head = (
        await this.gitOk(input.path, ["rev-parse", "HEAD"])
      ).trim();
      const status = await this.gitOk(input.path, ["status", "--porcelain"]);
      const diff = await this.gitOk(input.path, [
        "diff",
        `${input.fixedPoint.baseCommit}..${input.fixedPoint.headCommit}`,
      ]);
      const headOk = head === input.fixedPoint.headCommit;
      const cleanOk = status.trim().length === 0;
      const diffHashOk = diffHashOf(diff) === input.fixedPoint.diffHash;
      const failures: string[] = [];
      if (!headOk) failures.push(`HEAD is ${head}`);
      if (!cleanOk) failures.push("worktree is dirty");
      if (!diffHashOk) failures.push("diff hash drifted");
      return {
        headOk,
        cleanOk,
        diffHashOk,
        detail: failures.length === 0 ? null : failures.join("; "),
      };
    } catch (error) {
      // Verification that cannot run proves nothing — fail closed.
      return failedVerification(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async removeWorktree(input: {
    readonly repoRoot: string;
    readonly path: string;
  }): Promise<void> {
    await this.gitOk(input.repoRoot, [
      "worktree",
      "remove",
      "--force",
      input.path,
    ]);
  }
}
