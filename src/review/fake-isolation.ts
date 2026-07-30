// Deterministic in-memory review-isolation port for runtime tests. Records
// every call and returns configured verification outcomes without touching
// git.

import type { FixedPoint } from "../runtime/events.ts";
import type {
  ReviewIsolationPort,
  WorktreeVerification,
} from "./isolation.ts";

const PASS: WorktreeVerification = {
  headOk: true,
  cleanOk: true,
  diffHashOk: true,
  detail: null,
};

export interface FakeReviewIsolationOptions {
  /** Per-worktree-path verification overrides, consumed in call order. */
  readonly verifications?: Readonly<Record<string, readonly WorktreeVerification[]>>;
  /** Make createWorktree throw for these paths. */
  readonly failCreateFor?: readonly string[];
  /** Make verifyWorktree throw for these paths (port-failure path). */
  readonly throwVerifyFor?: readonly string[];
}

export class FakeReviewIsolation implements ReviewIsolationPort {
  readonly created: { repoRoot: string; headCommit: string; path: string }[] =
    [];
  readonly verified: { path: string; fixedPoint: FixedPoint }[] = [];
  readonly removed: { repoRoot: string; path: string }[] = [];
  private readonly queues = new Map<string, WorktreeVerification[]>();
  private readonly failCreateFor: ReadonlySet<string>;
  private readonly throwVerifyFor: ReadonlySet<string>;

  constructor(options: FakeReviewIsolationOptions = {}) {
    for (const [path, outcomes] of Object.entries(
      options.verifications ?? {},
    )) {
      this.queues.set(path, [...outcomes]);
    }
    this.failCreateFor = new Set(options.failCreateFor ?? []);
    this.throwVerifyFor = new Set(options.throwVerifyFor ?? []);
  }

  async createWorktree(input: {
    readonly repoRoot: string;
    readonly headCommit: string;
    readonly path: string;
  }): Promise<void> {
    if (this.failCreateFor.has(input.path)) {
      throw new Error(`fake: createWorktree failed for ${input.path}`);
    }
    this.created.push({ ...input });
  }

  async verifyWorktree(input: {
    readonly path: string;
    readonly fixedPoint: FixedPoint;
  }): Promise<WorktreeVerification> {
    if (this.throwVerifyFor.has(input.path)) {
      throw new Error(`fake: verifyWorktree failed for ${input.path}`);
    }
    this.verified.push({ path: input.path, fixedPoint: input.fixedPoint });
    const queue = this.queues.get(input.path);
    if (queue && queue.length > 0) return queue.shift()!;
    return PASS;
  }

  async removeWorktree(input: {
    readonly repoRoot: string;
    readonly path: string;
  }): Promise<void> {
    this.removed.push({ ...input });
  }
}
