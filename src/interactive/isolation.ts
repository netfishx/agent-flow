// Write-lane isolation preflight.
//
// A read-only review lane can be verified with HEAD + clean + diff hash,
// because it must not write at all. A write lane is SUPPOSED to write, so the
// same post-flight check would fail by design. What still must hold is the
// lane's IDENTITY and its STARTING baseline: the agent is about to be given a
// directory and permission to change it, so that directory has to be a linked
// worktree of the declared repository — never the main checkout, never another
// repository, never an arbitrary path — and it has to start clean so every
// later change is attributable to the attempt.

import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

export type WriteLaneIsolationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface WriteLaneIsolationPort {
  verifyWriteWorktree(input: {
    readonly repoRoot: string;
    readonly worktreePath: string;
  }): Promise<WriteLaneIsolationOutcome>;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const bunGit = async (
  cwd: string,
  args: readonly string[],
): Promise<GitResult> => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

function refuse(reason: string): WriteLaneIsolationOutcome {
  return { ok: false, reason };
}

/**
 * Compare paths through the filesystem, not through string normalization.
 * On macOS a temp directory reached as `/var/...` IS `/private/var/...`, and a
 * textual comparison would reject a perfectly good linked worktree.
 */
async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

export class GitWriteLaneIsolation implements WriteLaneIsolationPort {
  constructor(
    private readonly git: (
      cwd: string,
      args: readonly string[],
    ) => Promise<GitResult> = bunGit,
  ) {}

  async verifyWriteWorktree(input: {
    readonly repoRoot: string;
    readonly worktreePath: string;
  }): Promise<WriteLaneIsolationOutcome> {
    const { repoRoot, worktreePath } = input;
    // Checked before any git call: a relative path would be resolved against
    // this process's cwd, which is not the caller's and not the lane's.
    if (!isAbsolute(worktreePath)) {
      return refuse(`worktree path "${worktreePath}" is not absolute`);
    }
    if (!isAbsolute(repoRoot)) {
      return refuse(`repository root "${repoRoot}" is not absolute`);
    }

    const top = await this.git(worktreePath, ["rev-parse", "--show-toplevel"]);
    if (top.exitCode !== 0) {
      return refuse(
        `"${worktreePath}" is not inside a git worktree: ${top.stderr.trim() || "git failed"}`,
      );
    }
    if (!(await samePath(top.stdout.trim(), worktreePath))) {
      return refuse(
        `"${worktreePath}" is not the root of its worktree (that is "${top.stdout.trim()}")`,
      );
    }

    // The common dir identifies the REPOSITORY; the git dir identifies which
    // checkout of it this is. A linked worktree's git dir sits under
    // <common>/worktrees/<name>; the main checkout's git dir IS the common dir.
    const common = await this.git(worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const gitDir = await this.git(worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]);
    if (common.exitCode !== 0 || gitDir.exitCode !== 0) {
      return refuse(`"${worktreePath}" has no resolvable git directory`);
    }
    if (await samePath(common.stdout.trim(), gitDir.stdout.trim())) {
      return refuse(
        `"${worktreePath}" is the repository's main checkout, not a linked worktree`,
      );
    }

    const declared = await this.git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (declared.exitCode !== 0) {
      return refuse(`"${repoRoot}" is not a git repository`);
    }
    if (!(await samePath(declared.stdout.trim(), common.stdout.trim()))) {
      return refuse(
        `"${worktreePath}" belongs to a different repository than "${repoRoot}"`,
      );
    }

    // Starting baseline. A write lane may dirty its worktree afterwards; what
    // it may not do is start on top of changes nobody can attribute.
    const status = await this.git(worktreePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (status.exitCode !== 0) {
      return refuse(`"${worktreePath}" status could not be read`);
    }
    if (status.stdout.trim().length > 0) {
      const first = status.stdout.trim().split("\n")[0] ?? "";
      return refuse(
        `"${worktreePath}" does not start clean (for example: ${first.trim()})`,
      );
    }
    return { ok: true };
  }
}
