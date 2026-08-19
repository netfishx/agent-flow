// Round-three regressions: one minimal test per second-review P2. Each failed
// against 97482a4 and is the reason its fix exists.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FakeHerdrAgentControl } from "../src/herdr/fake-agent-control.ts";
import { InMemoryLedger, type Ledger } from "../src/runtime/ledger.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import {
  AttemptNotBoundError,
  AttemptNotControllableError,
  InteractiveLaneController,
  controlDeliveryState,
} from "../src/interactive/control-plane.ts";
import {
  GitWriteLaneIsolation,
  type WriteLaneIsolationPort,
} from "../src/interactive/isolation.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flow-r3-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const LANE = {
  workflow: "impl",
  workspace: "ws",
  cwd: "/tmp/repo",
  laneId: "impl-1",
  agentKind: "claude",
  model: "sonnet",
  effort: "high",
  worktreePath: "/tmp/repo-wt",
  repoRoot: "/tmp/repo",
} as const;
const START = { brief: "do it", authorization: { note: "authorized" } } as const;

/** Accepts every worktree; isolation itself is tested against real git below. */
const permissive: WriteLaneIsolationPort = {
  verifyWriteWorktree: async (input) => ({
    ok: true,
    canonicalRepoRoot: input.repoRoot,
    canonicalWorktreePath: input.worktreePath,
  }),
};

function harness(
  options: {
    readonly control?: (adapter: FakeHerdrAdapter) => FakeHerdrAgentControl;
    readonly ledger?: Ledger;
    readonly adapter?: FakeHerdrAdapter;
    readonly isolation?: WriteLaneIsolationPort;
  } = {},
) {
  const clock = createClock(1_000);
  const adapter = options.adapter ?? new FakeHerdrAdapter({ clock });
  const agentControl =
    options.control?.(adapter) ?? new FakeHerdrAgentControl({ panes: adapter });
  const ledger = options.ledger ?? new InMemoryLedger();
  let seq = 0;
  let tick = 0;
  const controller = new InteractiveLaneController({
    adapter,
    agentControl,
    ledger,
    artifactRoot: root,
    isolation: options.isolation ?? permissive,
    clock: () => clock.now() + ++tick,
    idgen: () => `id-${++seq}`,
    sessionIdgen: () => "sess-1",
  });
  return { adapter, control: agentControl, ledger, controller };
}

describe("P2-A a starting attempt is never probed or reconciled", () => {
  test("controls on an unbound attempt refuse without touching Herdr", async () => {
    const ledger = new InMemoryLedger();
    const h = harness({ ledger });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    // Seeded straight into the ledger: an attempt that registered and never
    // bound is exactly what a controller crash between the two events leaves.
    const run = (await ledger.load(runId))!;
    await ledger.commit({
      schemaVersion: 1,
      eventId: `${runId}#${run.lastAppliedSequence + 1}`,
      runId,
      sequence: run.lastAppliedSequence + 1,
      at: 5_000,
      controllerEpoch: 0,
      type: "interactive_attempt_started",
      actor: "runtime",
      laneId,
      data: {
        attemptId: "crashed-1", ordinal: 1, parentAttemptId: null,
        agentKind: "claude", model: "sonnet", effort: "high", paneId: "wf:p9",
        expectedAgentName: "f-impl-1-crashed", worktreePath: "/tmp/repo-wt",
        briefFile: join(root, "b.md"),
        checkpointFile: join(root, "c.md"), resultPointer: join(root, "r.md"),
        authorization: { actor: "human", note: "authorized" },
      },
    });
    const [pending] = await h.controller.attempts(runId, laneId);
    expect(pending!.agentName).toBeNull();
    expect(pending!.endReason).toBeNull();

    const probesBefore = h.adapter.processInfoCalls;
    for (const call of [
      () => h.controller.abortSession(runId, laneId),
      () => h.controller.steer(runId, laneId, "x"),
      () => h.controller.cancelTurn(runId, laneId),
    ]) {
      await expect(call()).rejects.toThrow(AttemptNotBoundError);
    }
    // No probe, no reconciliation, no signal, no keys, no prompt.
    const [after] = await h.controller.attempts(runId, laneId);
    expect(after!.reconciliation).toBeNull();
    expect(h.adapter.interruptedPaneIds).toHaveLength(0);
    expect(h.adapter.processInfoCalls).toBe(probesBefore);
    expect(h.control.sendKeysCalls).toHaveLength(0);
    expect(h.control.promptCalls).toHaveLength(0);
  });

  test("a normal start still binds and delivers its brief", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    const outcome = await h.controller.startAttempt(runId, laneId, START);
    expect(outcome.started).toBe(true);
    const [a] = await h.controller.attempts(runId, laneId);
    expect(a!.agentName).not.toBeNull();
    expect(a!.reconciliation).toBeNull();
    expect(a!.steerSubmissions).toBe(1);
    expect(h.control.promptCalls[0]!.text).toBe("do it");
  });

  test("a failed start ends in an unrewritable start-failed", async () => {
    const h = harness({
      control: (adapter) =>
        new FakeHerdrAgentControl({
          panes: adapter,
          defaultProgram: { startFailure: "start timed out" },
        }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    const [a] = await h.controller.attempts(runId, laneId);
    expect(a!.endReason).toBe("start-failed");
    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      AttemptNotControllableError,
    );
    expect(h.adapter.interruptedPaneIds).toHaveLength(0);
  });

  test("startAttempt holds one lease for the whole mutation", async () => {
    const base = new InMemoryLedger();
    const events: string[] = [];
    const ledger: Ledger = {
      commit: (e) => {
        events.push(`commit:${e.type}`);
        return base.commit(e);
      },
      load: (r) => base.load(r),
      list: () => base.list(),
      acquireLease: async (r, c) => {
        events.push("acquire");
        const handle = await base.acquireLease(r, c);
        return {
          release: async () => {
            events.push("release");
            await handle.release();
          },
        };
      },
    };
    const h = harness({ ledger });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    events.length = 0;
    await h.controller.startAttempt(runId, laneId, START);

    expect(events.filter((e) => e === "acquire")).toHaveLength(1);
    expect(events.filter((e) => e === "release")).toHaveLength(1);
    expect(events[0]).toBe("acquire");
    expect(events.at(-1)).toBe("release");
    // Registration, binding and the brief all landed inside that one lease.
    const inside = events.slice(1, -1);
    expect(inside).toContain("commit:interactive_attempt_started");
    expect(inside).toContain("commit:interactive_attempt_bound");
    expect(inside).toContain("commit:lane_steer_submitted");
  });
});

describe("P2-B delivery state is derived, never ambiguous", () => {
  test("no intent reads as none; a live control reads as delivered", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    let [a] = await h.controller.attempts(runId, laneId);
    expect(a!.controls).toHaveLength(0);

    await h.controller.cancelTurn(runId, laneId);
    [a] = await h.controller.attempts(runId, laneId);
    expect(controlDeliveryState(a!.controls.at(-1)!)).toBe("delivered");
  });

  test("an intent whose delivery never landed reads as unconfirmed", async () => {
    const base = new InMemoryLedger();
    let blocked: string | null = null;
    const ledger: Ledger = {
      commit: async (e) => {
        if (e.type === blocked) throw new Error("ledger write failed");
        return base.commit(e);
      },
      load: (r) => base.load(r),
      list: () => base.list(),
      acquireLease: (r, c) => base.acquireLease(r, c),
    };
    const h = harness({ ledger });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    blocked = "lane_control_delivered";
    await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow();

    // The effect happened; the delivery record did not.
    expect(h.control.sendKeysCalls).toHaveLength(1);
    const [a] = await h.controller.attempts(runId, laneId);
    expect(a!.controls.at(-1)?.control).toBe("cancel-turn");
    expect(a!.controls.at(-1)?.delivery).toBeNull();
    expect(controlDeliveryState(a!.controls.at(-1)!)).toBe("unconfirmed");
    // A fresh controller replays to the same answer and repeats nothing.
    const fresh = harness({ ledger: base });
    const [replayed] = await fresh.controller.attempts(runId, laneId);
    expect(controlDeliveryState(replayed!.controls.at(-1)!)).toBe("unconfirmed");
    expect(fresh.control.sendKeysCalls).toHaveLength(0);
  });

  test("an effect that failed reads as failed", async () => {
    class ThrowingKeys extends FakeHerdrAgentControl {
      override async sendKeys(): Promise<never> {
        throw new Error("herdr agent send-keys failed (exit 1)");
      }
    }
    const h = harness({
      control: (adapter) => new ThrowingKeys({ panes: adapter }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow();
    const [a] = await h.controller.attempts(runId, laneId);
    expect(controlDeliveryState(a!.controls.at(-1)!)).toBe("failed");
  });

  test("the CLI never renders control=null delivered=null", async () => {
    const { runFlowCli } = await import("../src/cli/flow.ts");
    const ledgerRoot = await mkdtemp(join(tmpdir(), "flow-r3-cli-"));
    try {
      const ledger = new FsLedger(ledgerRoot);
      const h = harness({ ledger });
      const { runId, laneId } = await h.controller.openLane({ ...LANE });
      await h.controller.startAttempt(runId, laneId, START);
      let out = "";
      const code = await runFlowCli(
        ["cancel-turn", runId, laneId],
        { write: (t: string) => (out += t) },
        { write: () => {} },
        {
          environment: { FLOW_LEDGER_ROOT: ledgerRoot },
          interactiveFactory: () => h.controller,
        },
      );
      expect(code).toBe(0);
      expect(out).toContain("delivery=delivered");
      expect(out).not.toContain("control=null delivered=null");
    } finally {
      await rm(ledgerRoot, { recursive: true, force: true });
    }
  });
});

describe("P2-B reducer pairs every delivery with its intent", () => {
  const base = (runId: string, sequence: number) => ({
    schemaVersion: 1 as const,
    eventId: `${runId}#${sequence}`,
    runId,
    sequence,
    at: sequence,
    controllerEpoch: 0,
  });

  async function seeded() {
    const ledger = new InMemoryLedger();
    const runId = "run-pair";
    await ledger.commit({
      ...base(runId, 1),
      type: "run_started",
      actor: "runtime",
      data: {
        workflow: "w", workspace: "ws", cwd: "/tmp", splitDirection: "right",
        tabId: "t1", controllerPaneId: "p1", fixedPoint: null, issue: null,
      },
    });
    await ledger.commit({
      ...base(runId, 2),
      type: "lane_registered",
      actor: "runtime",
      laneId: "l1",
      data: {
        kind: "interactive", laneId: "l1", paneId: "p1", agentKind: "claude",
        model: "m", effort: "high", worktreePath: "/tmp/wt",
        artifactRoot: "/tmp/art", repoRoot: "/tmp",
      },
    });
    await ledger.commit({
      ...base(runId, 3),
      type: "interactive_attempt_started",
      actor: "runtime",
      laneId: "l1",
      data: {
        attemptId: "a1", ordinal: 1, parentAttemptId: null, agentKind: "claude",
        model: "m", effort: "high", paneId: "p2", expectedAgentName: "f-l1-a1",
        worktreePath: "/tmp/wt",
        briefFile: "/tmp/b", checkpointFile: "/tmp/c", resultPointer: "/tmp/r",
        authorization: { actor: "human", note: "ok" },
      },
    });
    return { ledger, runId };
  }

  test("a delivery with no intent is rejected", async () => {
    const { ledger, runId } = await seeded();
    await expect(
      ledger.commit({
        ...base(runId, 4),
        type: "lane_control_delivered",
        actor: "runtime",
        laneId: "l1",
        data: {
          attemptId: "a1", controlId: "c1", control: "cancel-turn",
          method: "send-keys", delivered: true, detail: null, observedStatus: null,
        },
      }),
    ).rejects.toThrow(/no pending control intent/);
  });

  test("a duplicate delivery is rejected", async () => {
    const { ledger, runId } = await seeded();
    await ledger.commit({
      ...base(runId, 4),
      type: "lane_cancel_turn",
      actor: "human",
      laneId: "l1",
      data: { attemptId: "a1", controlId: "c1", method: "send-keys", keys: ["esc"] },
    });
    await ledger.commit({
      ...base(runId, 5),
      type: "lane_control_delivered",
      actor: "runtime",
      laneId: "l1",
      data: {
        attemptId: "a1", controlId: "c1", control: "cancel-turn",
        method: "send-keys", delivered: true, detail: null, observedStatus: null,
      },
    });
    await expect(
      ledger.commit({
        ...base(runId, 6),
        type: "lane_control_delivered",
        actor: "runtime",
        laneId: "l1",
        data: {
          attemptId: "a1", controlId: "c1", control: "cancel-turn",
          method: "send-keys", delivered: true, detail: null, observedStatus: null,
        },
      }),
    ).rejects.toThrow(/already recorded/);
  });

  test("a delivery naming another control's intent is rejected", async () => {
    const { ledger, runId } = await seeded();
    await ledger.commit({
      ...base(runId, 4),
      type: "lane_cancel_turn",
      actor: "human",
      laneId: "l1",
      data: { attemptId: "a1", controlId: "c1", method: "send-keys", keys: ["esc"] },
    });
    await expect(
      ledger.commit({
        ...base(runId, 5),
        type: "lane_control_delivered",
        actor: "runtime",
        laneId: "l1",
        data: {
          attemptId: "a1", controlId: "c1", control: "abort-session",
          method: "signal-process-group", delivered: true, detail: null,
          observedStatus: null,
        },
      }),
    ).rejects.toThrow(/does not match/);
  });
});

describe("P2-D write-lane worktree isolation", () => {
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const p = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
             GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }

  async function repo(name: string): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "f.txt"), "hello\n", "utf8");
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "init");
    return dir;
  }

  test("the isolation matrix", async () => {
    const main = await repo("repo-a");
    const other = await repo("repo-b");
    const linked = join(root, "wt-a");
    await git(main, "worktree", "add", "-q", "--detach", linked);
    const otherLinked = join(root, "wt-b");
    await git(other, "worktree", "add", "-q", "--detach", otherLinked);
    const plainDir = join(root, "plain");
    await mkdir(plainDir, { recursive: true });

    const isolation = new GitWriteLaneIsolation();
    const verify = (worktreePath: string, repoRoot = main) =>
      isolation.verifyWriteWorktree({ repoRoot, worktreePath });

    // 1. a system directory
    expect(await verify("/etc")).toMatchObject({ ok: false });
    // 2. a plain directory that is not a worktree
    expect(await verify(plainDir)).toMatchObject({ ok: false });
    // 3. another repository's worktree
    expect(await verify(otherLinked)).toMatchObject({ ok: false });
    // 4. the repository's own main checkout
    expect(await verify(main)).toMatchObject({ ok: false });
    // 5. a legitimate linked worktree, which reports its canonical paths
    const accepted = await verify(linked);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.canonicalWorktreePath).toBe(await realpath(linked));
      expect(accepted.canonicalRepoRoot).toBe(await realpath(main));
    }
    // relative paths are refused before any git call
    expect(await verify("wt-a")).toMatchObject({ ok: false });
  });

  test("a dirty linked worktree fails the starting baseline", async () => {
    const main = await repo("repo-c");
    const linked = join(root, "wt-c");
    await git(main, "worktree", "add", "-q", "--detach", linked);
    await writeFile(join(linked, "scratch.txt"), "uncommitted\n", "utf8");
    const outcome = await new GitWriteLaneIsolation().verifyWriteWorktree({
      repoRoot: main,
      worktreePath: linked,
    });
    expect(outcome.ok).toBe(false);
  });

  test("a rejected worktree creates no event, no pane, and no agent", async () => {
    const refusing: WriteLaneIsolationPort = {
      verifyWriteWorktree: async () => ({
        ok: false,
        reason: "not a linked worktree of the declared repository",
      }),
    };
    const h = harness({ isolation: refusing });
    await expect(
      h.controller.openLane({ ...LANE, worktreePath: "/etc" }),
    ).rejects.toThrow(/not a linked worktree/);
    expect(await h.ledger.list()).toHaveLength(0);
    expect(h.adapter.dispatched).toHaveLength(0);
    expect(h.control.startCalls).toHaveLength(0);
  });
});

describe("P2-C the ledger lease survives concurrent churn", () => {
  test("a lock file that is present but unwritten is reported as corrupt", async () => {
    // Round-four rule: publication is atomic, so a lock can no longer be
    // legitimately half-written. One that is unreadable names an owner nobody
    // can check, so it is surfaced rather than waited on forever.
    const dir = await mkdtemp(join(tmpdir(), "flow-r3-empty-"));
    try {
      const ledger = new FsLedger(dir);
      const runDir = join(dir, "runs", "run-empty");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "controller.lock"), "", "utf8");
      let message = "";
      try {
        await ledger.acquireLease("run-empty", {
          controllerId: "c",
          pid: process.pid,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("corrupt");
      expect(message).not.toContain("already held");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a genuinely malformed lock file is still reported as corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r3-bad-"));
    try {
      const ledger = new FsLedger(dir);
      const runDir = join(dir, "runs", "run-bad");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "controller.lock"), "not json at all\n", "utf8");
      await expect(
        ledger.acquireLease("run-bad", { controllerId: "c", pid: process.pid }),
      ).rejects.toThrow(/corrupt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("high-frequency contention yields only success or already-held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r3-lease-"));
    try {
      const ledger = new FsLedger(dir);
      const runId = "run-lease";
      const controller = { controllerId: "c", pid: process.pid };
      const errors: string[] = [];
      for (let round = 0; round < 40; round++) {
        const attempts = Array.from({ length: 4 }, async () => {
          try {
            const lease = await ledger.acquireLease(runId, controller);
            await lease.release();
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        });
        await Promise.all(attempts);
      }
      const corrupt = errors.filter((e) => e.includes("corrupt"));
      expect(corrupt).toEqual([]);
      for (const message of errors) {
        expect(message).toContain("already held");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
