// Integration tests for the real review-isolation port against throwaway git
// repositories in temp directories — real `git worktree` semantics, induced
// drift and dirty states.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitReviewIsolation, verificationPassed } from "../src/index.ts";
import { FakeReviewIsolation } from "../src/testing.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout;
}

let root: string;
let repo: string;
let base: string;
let head: string;
const isolation = new GitReviewIsolation();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flow-isolation-"));
  repo = join(root, "repo");
  await git(root, "init", "-q", "repo");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  base = (await git(repo, "rev-parse", "HEAD")).trim();
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  await git(repo, "commit", "-q", "-am", "head");
  head = (await git(repo, "rev-parse", "HEAD")).trim();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GitReviewIsolation", () => {
  test("captures a fixed point with a stable diff hash", async () => {
    const first = await isolation.captureFixedPoint({
      repoRoot: repo,
      baseRef: base,
      headRef: "HEAD",
      dirtyStatePolicy: "reject",
    });
    const second = await isolation.captureFixedPoint({
      repoRoot: repo,
      baseRef: base,
      headRef: head,
      dirtyStatePolicy: "reject",
    });
    expect(first.baseCommit).toBe(base);
    expect(first.headCommit).toBe(head);
    expect(first.diffHash).toBe(second.diffHash);
    expect(first.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("reject policy refuses a dirty source checkout", async () => {
    await writeFile(join(repo, "dirty.txt"), "uncommitted\n");
    await expect(
      isolation.captureFixedPoint({
        repoRoot: repo,
        baseRef: base,
        headRef: head,
        dirtyStatePolicy: "reject",
      }),
    ).rejects.toThrow("source checkout is dirty");
    await rm(join(repo, "dirty.txt"));
  });

  test("refuses an empty diff", async () => {
    await expect(
      isolation.captureFixedPoint({
        repoRoot: repo,
        baseRef: head,
        headRef: head,
        dirtyStatePolicy: "reject",
      }),
    ).rejects.toThrow("diff is empty");
  });

  test("creates a detached worktree that passes verification, then removes it", async () => {
    const fixedPoint = await isolation.captureFixedPoint({
      repoRoot: repo,
      baseRef: base,
      headRef: head,
      dirtyStatePolicy: "reject",
    });
    const worktree = join(root, "wt-clean");
    await isolation.createWorktree({
      repoRoot: repo,
      headCommit: head,
      path: worktree,
    });
    const verification = await isolation.verifyWorktree({
      path: worktree,
      fixedPoint,
    });
    expect(verification).toEqual({
      headOk: true,
      cleanOk: true,
      diffHashOk: true,
      detail: null,
    });
    expect(verificationPassed(verification)).toBe(true);
    await isolation.removeWorktree({ repoRoot: repo, path: worktree });
    expect(await Bun.file(join(worktree, "a.txt")).exists()).toBe(false);
  });

  test("detects a reviewer write in the worktree", async () => {
    const fixedPoint = await isolation.captureFixedPoint({
      repoRoot: repo,
      baseRef: base,
      headRef: head,
      dirtyStatePolicy: "reject",
    });
    const worktree = join(root, "wt-write");
    await isolation.createWorktree({
      repoRoot: repo,
      headCommit: head,
      path: worktree,
    });
    await writeFile(join(worktree, "a.txt"), "tampered\n");
    const verification = await isolation.verifyWorktree({
      path: worktree,
      fixedPoint,
    });
    expect(verification.headOk).toBe(true);
    expect(verification.cleanOk).toBe(false);
    expect(verificationPassed(verification)).toBe(false);
    expect(verification.detail).toContain("dirty");
    await isolation.removeWorktree({ repoRoot: repo, path: worktree });
  });

  test("detects HEAD drift in the worktree", async () => {
    const fixedPoint = await isolation.captureFixedPoint({
      repoRoot: repo,
      baseRef: base,
      headRef: head,
      dirtyStatePolicy: "reject",
    });
    const worktree = join(root, "wt-drift");
    await isolation.createWorktree({
      repoRoot: repo,
      headCommit: head,
      path: worktree,
    });
    await git(worktree, "checkout", "-q", "--detach", base);
    const verification = await isolation.verifyWorktree({
      path: worktree,
      fixedPoint,
    });
    expect(verification.headOk).toBe(false);
    expect(verification.detail).toContain(`HEAD is ${base}`);
    await isolation.removeWorktree({ repoRoot: repo, path: worktree });
  });

  test("a worktree that cannot be verified fails closed", async () => {
    const fixedPoint = await isolation.captureFixedPoint({
      repoRoot: repo,
      baseRef: base,
      headRef: head,
      dirtyStatePolicy: "reject",
    });
    const verification = await isolation.verifyWorktree({
      path: join(root, "does-not-exist"),
      fixedPoint,
    });
    expect(verification).toMatchObject({
      headOk: false,
      cleanOk: false,
      diffHashOk: false,
    });
    expect(verification.detail).not.toBeNull();
  });
});

describe("the review-isolation port seam", () => {
  // Testing Decision 3 names fixed-point capture as part of the one port, so a
  // runtime test must be able to drive capture through the fake.
  test("the fake implements capture, so the seam is complete", async () => {
    const fake = new FakeReviewIsolation();
    const captured = await fake.captureFixedPoint({
      repoRoot: "/repo",
      baseRef: "base",
      headRef: "head",
      dirtyStatePolicy: "reject",
    });
    expect(captured).toMatchObject({
      repoRoot: "/repo",
      baseCommit: "base",
      headCommit: "head",
      dirtyStatePolicy: "reject",
    });
    expect(fake.captured).toHaveLength(1);
  });

  test("the fake refuses an empty diff, like the real port", async () => {
    const fake = new FakeReviewIsolation();
    await expect(
      fake.captureFixedPoint({
        repoRoot: "/repo",
        baseRef: "same",
        headRef: "same",
        dirtyStatePolicy: "reject",
      }),
    ).rejects.toThrow(/diff is empty/);
  });
});
