// Round-four regressions: the two crash windows, the lease's atomic publish,
// control history, and the canonical worktree path. Each failed against
// bc3e7de and is the reason its fix exists.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FakeHerdrAgentControl } from "../src/herdr/fake-agent-control.ts";
import type { AgentInfoView } from "../src/herdr/agent-json.ts";
import { InMemoryLedger, type Ledger } from "../src/runtime/ledger.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import {
  AttemptNotBoundError,
  InteractiveLaneController,
  controlDeliveryState,
  unresolvedControls,
} from "../src/interactive/control-plane.ts";
import type { WriteLaneIsolationPort } from "../src/interactive/isolation.ts";
import type { AgentPromptResult } from "../src/herdr/agent-control.ts";
import type { AgentPromptOptions } from "../src/herdr/agent-argv.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flow-r4-"));
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
const START = { authorization: { note: "authorized" } } as const;

function permissive(canonical?: {
  repoRoot: string;
  worktreePath: string;
}): WriteLaneIsolationPort {
  return {
    verifyWriteWorktree: async (input) => ({
      ok: true,
      canonicalRepoRoot: canonical?.repoRoot ?? input.repoRoot,
      canonicalWorktreePath: canonical?.worktreePath ?? input.worktreePath,
    }),
  };
}

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
    isolation: options.isolation ?? permissive(),
    artifactRoot: root,
    clock: () => clock.now() + ++tick,
    idgen: () => `id-${++seq}`,
    sessionIdgen: () => "sess-1",
  });
  return { adapter, control: agentControl, ledger, controller };
}

/** A ledger that drops one event type, modelling a controller dying there. */
function dyingLedger(base: Ledger, dropAfter: () => string | null): Ledger {
  return {
    commit: async (event) => {
      if (event.type === dropAfter()) {
        throw new Error("controller died before recording this event");
      }
      return base.commit(event);
    },
    load: (runId) => base.load(runId),
    list: () => base.list(),
    acquireLease: (runId, controller) => base.acquireLease(runId, controller),
  };
}

describe("P1-1 crash window 1: started committed, agent never started", () => {
  test("recovery records lost without claiming an agent left", async () => {
    const base = new InMemoryLedger();
    let dying: string | null = null;
    class NeverStarts extends FakeHerdrAgentControl {
      override async startAgent(): Promise<never> {
        throw new Error("controller died mid-start");
      }
    }
    const h = harness({
      ledger: dyingLedger(base, () => dying),
      control: (adapter) => new NeverStarts({ panes: adapter }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    dying = "interactive_attempt_ended";
    await expect(h.controller.startAttempt(runId, laneId, START)).rejects.toThrow();

    const fresh = harness({
      ledger: base,
      adapter: h.adapter,
      control: () => h.control,
    });
    const [pending] = await fresh.controller.attempts(runId, laneId);
    expect(pending!.agentName).toBeNull();

    const outcome = await fresh.controller.reconcileAttempt(
      runId,
      laneId,
      pending!.attemptId,
    );
    expect(outcome).toBe("missing");
    const [after] = await fresh.controller.attempts(runId, laneId);
    expect(after!.endReason).toBe("lost");
    // The pane never hosted an agent, so it cannot have stopped hosting one.
    expect(after!.reconciliation?.detail).not.toContain("no longer hosts");
    expect(after!.reconciliation?.detail).toContain("never started");
  });
});

describe("P1-1 crash window 2: agent started, bind never committed", () => {
  async function orphaned() {
    const base = new InMemoryLedger();
    let dying: string | null = null;
    const h = harness({
      ledger: dyingLedger(base, () => dying),
      // Herdr reports a session for this agent, so adoption must record the
      // REAL returned identity rather than inventing or dropping one.
      control: (adapter) =>
        new FakeHerdrAgentControl({
          panes: adapter,
          defaultProgram: { sessionId: "sess-from-herdr" },
        }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    dying = "interactive_attempt_bound";
    await expect(h.controller.startAttempt(runId, laneId, START)).rejects.toThrow();
    // A real agent is alive in that pane.
    expect(h.control.startCalls).toHaveLength(1);
    const fresh = harness({
      ledger: base,
      adapter: h.adapter,
      control: () => h.control,
    });
    const [attempt] = await fresh.controller.attempts(runId, laneId);
    return { base, h, fresh, runId, laneId, attempt: attempt! };
  }

  test("a strictly matching live agent is adopted and becomes controllable", async () => {
    const { fresh, runId, laneId, attempt } = await orphaned();
    expect(attempt.agentName).toBeNull();

    expect(
      await fresh.controller.reconcileAttempt(runId, laneId, attempt.attemptId),
    ).toBe("live");
    const [bound] = await fresh.controller.attempts(runId, laneId);
    expect(bound!.agentName).not.toBeNull();
    expect(bound!.session.kind).toBe("measured");
    if (bound!.session.kind === "measured") {
      expect(bound!.session.id).toBe("sess-from-herdr");
    }
    expect(bound!.endReason).toBeNull();

    // Controls work again.
    await expect(
      fresh.controller.steer(runId, laneId, "carry on"),
    ).resolves.toBeDefined();
    await expect(fresh.controller.cancelTurn(runId, laneId)).resolves.toBeDefined();
    await expect(fresh.controller.abortSession(runId, laneId)).resolves.toBeUndefined();
  });

  test("adoption restores the binding and submits nothing", async () => {
    const { fresh, h, runId, laneId, attempt } = await orphaned();
    // The crash happened before any prompt was submitted.
    expect(h.control.promptCalls).toHaveLength(0);
    expect(attempt.steerSubmissions).toBe(0);

    await fresh.controller.reconcileAttempt(runId, laneId, attempt.attemptId);
    const [after] = await fresh.controller.attempts(runId, laneId);

    // Adopted, controllable — and still told nothing. The adopted session may
    // be sitting on a trust or update dialog, and recovery cannot see that any
    // more than a launch can.
    expect(after!.agentName).not.toBeNull();
    expect(after!.steerSubmissions).toBe(0);
    expect(h.control.promptCalls).toHaveLength(0);

    // Reconciling again still submits nothing.
    await fresh.controller.reconcileAttempt(runId, laneId, attempt.attemptId);
    expect(h.control.promptCalls).toHaveLength(0);

    // The operator briefs it explicitly, exactly once.
    await fresh.controller.steer(runId, laneId, "do it");
    expect(h.control.promptCalls.map((c) => c.text)).toEqual(["do it"]);
  });

  test("an unconfirmed steer submission is not replayed", async () => {
    const base = new InMemoryLedger();
    let dying: string | null = null;
    const h = harness({ ledger: dyingLedger(base, () => dying) });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    // Dies after submitting the operator's brief, before recording what was
    // observed.
    dying = "lane_steer_observed";
    await expect(h.controller.steer(runId, laneId, "do it")).rejects.toThrow();
    expect(h.control.promptCalls).toHaveLength(1);

    const fresh = harness({
      ledger: base,
      adapter: h.adapter,
      control: () => h.control,
    });
    const [attempt] = await fresh.controller.attempts(runId, laneId);
    expect(attempt!.steerSubmissions).toBe(1);
    await fresh.controller.reconcileAttempt(runId, laneId, attempt!.attemptId);
    // Still exactly one prompt: an unconfirmed submission is never replayed.
    expect(h.control.promptCalls).toHaveLength(1);
  });

  test("the same pane running a different kind is not adopted", async () => {
    const { fresh, h, runId, laneId, attempt } = await orphaned();
    h.control.reoccupyByPane(attempt.paneId, { agent: "codex" });
    expect(
      await fresh.controller.reconcileAttempt(runId, laneId, attempt.attemptId),
    ).toBe("reoccupied");
    const [after] = await fresh.controller.attempts(runId, laneId);
    expect(after!.agentName).toBeNull();
    expect(after!.endReason).toBe("lost");
    expect(h.control.promptCalls).toHaveLength(0);
    expect(h.adapter.interruptedPaneIds).toHaveLength(0);
  });

  test("the same pane running a different agent name is not adopted", async () => {
    // The expected name resolves to nothing, so the pane itself is asked who
    // is there — and it answers with a stranger.
    const { fresh, h, runId, laneId, attempt } = await orphaned();
    h.control.renameAgentOnPane(attempt.paneId, "someone-elses-agent");
    expect(
      await fresh.controller.reconcileAttempt(runId, laneId, attempt.attemptId),
    ).toBe("reoccupied");
    const [after] = await fresh.controller.attempts(runId, laneId);
    expect(after!.agentName).toBeNull();
    expect(after!.reconciliation?.detail).toContain("someone-elses-agent");
    expect(h.control.promptCalls).toHaveLength(0);
    expect(h.adapter.interruptedPaneIds).toHaveLength(0);
  });

  test("a lookup failure stays unknown and fabricates no absence", async () => {
    const base = new InMemoryLedger();
    let dying: string | null = null;
    const h = harness({ ledger: dyingLedger(base, () => dying) });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    dying = "interactive_attempt_bound";
    await expect(h.controller.startAttempt(runId, laneId, START)).rejects.toThrow();

    class LookupFails extends FakeHerdrAgentControl {
      override async getAgent(): Promise<never> {
        throw new Error("herdr agent get failed (exit 1): io_error");
      }
    }
    const broken = new LookupFails();
    const fresh = harness({
      ledger: base,
      adapter: h.adapter,
      control: () => broken,
    });
    const [attempt] = await fresh.controller.attempts(runId, laneId);
    expect(
      await fresh.controller.reconcileAttempt(runId, laneId, attempt!.attemptId),
    ).toBe("unknown-probe");
    const [after] = await fresh.controller.attempts(runId, laneId);
    expect(after!.endReason).toBeNull();
    expect(after!.agentName).toBeNull();
    await expect(fresh.controller.steer(runId, laneId, "x")).rejects.toThrow(
      AttemptNotBoundError,
    );
  });
});

describe("P1-2 the controller lease is published atomically", () => {
  test("a legacy empty lock does not deadlock forever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-lease-"));
    try {
      const ledger = new FsLedger(dir);
      const runDir = join(dir, "runs", "run-orphan");
      await mkdir(runDir, { recursive: true });
      // What the old create-then-write sequence left behind on a crash.
      await writeFile(join(runDir, "controller.lock"), "", "utf8");
      let message = "";
      try {
        await ledger.acquireLease("run-orphan", {
          controllerId: "c",
          pid: process.pid,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // A stable unreadable lock is CORRUPT, not contention: it names an
      // owner nobody can check, so it must be surfaced, never waited on.
      expect(message).toContain("corrupt");
      expect(message).not.toContain("already held");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed lock is still corrupt and is not deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-bad-"));
    try {
      const ledger = new FsLedger(dir);
      const runDir = join(dir, "runs", "run-bad");
      await mkdir(runDir, { recursive: true });
      const lockFile = join(runDir, "controller.lock");
      await writeFile(lockFile, "{not json", "utf8");
      await expect(
        ledger.acquireLease("run-bad", { controllerId: "c", pid: process.pid }),
      ).rejects.toThrow(/corrupt/);
      // Ownership could not be proven, so the file is left for a human.
      expect(await Bun.file(lockFile).text()).toBe("{not json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a live owner is never overwritten; a dead one is taken over", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-own-"));
    try {
      const ledger = new FsLedger(dir);
      const held = await ledger.acquireLease("run-own", {
        controllerId: "a",
        pid: process.pid,
      });
      await expect(
        ledger.acquireLease("run-own", { controllerId: "b", pid: process.pid }),
      ).rejects.toThrow(/already held/);
      await held.release();

      const runDir = join(dir, "runs", "run-dead");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "controller.lock"),
        `${JSON.stringify({ schemaVersion: 1, controllerId: "gone", pid: 999_999, epoch: 3, acquiredAt: 1 })}\n`,
        "utf8",
      );
      const taken = await ledger.acquireLease("run-dead", {
        controllerId: "c",
        pid: process.pid,
      });
      await taken.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a competitor only ever observes absence or complete JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-atomic-"));
    try {
      const ledger = new FsLedger(dir);
      const runDir = join(dir, "runs", "run-atomic");
      await mkdir(runDir, { recursive: true });
      const lockFile = join(runDir, "controller.lock");
      const seen: string[] = [];
      const watcher = (async () => {
        for (let i = 0; i < 2_000; i++) {
          try {
            const text = await Bun.file(lockFile).text();
            seen.push(text);
          } catch {
            seen.push("<absent>");
          }
        }
      })();
      for (let round = 0; round < 40; round++) {
        const lease = await ledger.acquireLease("run-atomic", {
          controllerId: "c",
          pid: process.pid,
        });
        await lease.release();
      }
      await watcher;
      for (const text of seen) {
        if (text === "<absent>" || text === "") continue;
        expect(() => JSON.parse(text)).not.toThrow();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no temp files survive success, contention, or failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-temp-"));
    try {
      const ledger = new FsLedger(dir);
      const held = await ledger.acquireLease("run-temp", {
        controllerId: "a",
        pid: process.pid,
      });
      await ledger
        .acquireLease("run-temp", { controllerId: "b", pid: process.pid })
        .catch(() => {});
      await held.release();
      await Promise.all(
        Array.from({ length: 8 }, () =>
          ledger
            .acquireLease("run-temp", { controllerId: "x", pid: process.pid })
            .then((l) => l.release())
            .catch(() => {}),
        ),
      );
      const entries = await readdir(join(dir, "runs", "run-temp"));
      expect(entries.filter((e) => e.includes("lock.tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contention at 40x4 and 200x6 yields no corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-stress-"));
    try {
      const ledger = new FsLedger(dir);
      for (const [rounds, racers] of [
        [40, 4],
        [200, 6],
      ] as const) {
        const errors: string[] = [];
        for (let round = 0; round < rounds; round++) {
          await Promise.all(
            Array.from({ length: racers }, async () => {
              try {
                const lease = await ledger.acquireLease("run-s", {
                  controllerId: "c",
                  pid: process.pid,
                });
                await lease.release();
              } catch (error) {
                errors.push(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }),
          );
        }
        expect(errors.filter((e) => e.includes("corrupt"))).toEqual([]);
        for (const message of errors) expect(message).toContain("already held");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("P2-1 control history keeps every record", () => {
  async function withBlockedDelivery() {
    const base = new InMemoryLedger();
    let blocked: string | null = null;
    const ledger: Ledger = {
      commit: async (event) => {
        if (event.type === blocked) throw new Error("ledger write failed");
        return base.commit(event);
      },
      load: (runId) => base.load(runId),
      list: () => base.list(),
      acquireLease: (runId, c) => base.acquireLease(runId, c),
    };
    const h = harness({ ledger });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    blocked = "lane_control_delivered";
    await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow();
    blocked = null;
    return { base, h, runId, laneId };
  }

  test("an unconfirmed record survives the next control", async () => {
    const { h, runId, laneId } = await withBlockedDelivery();
    let [a] = await h.controller.attempts(runId, laneId);
    expect(a!.controls).toHaveLength(1);
    const firstId = a!.controls[0]!.controlId;
    expect(controlDeliveryState(a!.controls[0]!)).toBe("unconfirmed");

    // A later control is still allowed: no new deadlock.
    await h.controller.cancelTurn(runId, laneId);
    [a] = await h.controller.attempts(runId, laneId);
    expect(a!.controls).toHaveLength(2);
    expect(a!.controls[0]!.controlId).toBe(firstId);
    expect(controlDeliveryState(a!.controls[0]!)).toBe("unconfirmed");
    expect(controlDeliveryState(a!.controls[1]!)).toBe("delivered");
    expect(unresolvedControls(a!).map((c) => c.controlId)).toEqual([firstId]);
  });

  test("history replays identically from a durable ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flow-r4-hist-"));
    try {
      const ledger = new FsLedger(dir);
      const h = harness({ ledger });
      const { runId, laneId } = await h.controller.openLane({ ...LANE });
      await h.controller.startAttempt(runId, laneId, START);
      await h.controller.cancelTurn(runId, laneId);
      await h.controller.cancelTurn(runId, laneId);
      const live = (await h.controller.attempts(runId, laneId))[0]!;
      const replayed = (await new FsLedger(dir).load(runId))!;
      const disk =
        replayed.interactiveAttempts[replayed.interactiveAttemptOrder[0]!]!;
      expect(disk.controls.map((c) => c.controlId)).toEqual(
        live.controls.map((c) => c.controlId),
      );
      expect(disk.controls.map((c) => controlDeliveryState(c))).toEqual(
        live.controls.map((c) => controlDeliveryState(c)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the CLI shows unresolved controls", async () => {
    const { runFlowCli } = await import("../src/cli/flow.ts");
    const ledgerRoot = await mkdtemp(join(tmpdir(), "flow-r4-cli-"));
    try {
      const base = new FsLedger(ledgerRoot);
      let blocked: string | null = null;
      const ledger: Ledger = {
        commit: async (event) => {
          if (event.type === blocked) throw new Error("ledger write failed");
          return base.commit(event);
        },
        load: (runId) => base.load(runId),
        list: () => base.list(),
        acquireLease: (runId, c) => base.acquireLease(runId, c),
      };
      const h = harness({ ledger });
      const { runId, laneId } = await h.controller.openLane({ ...LANE });
      await h.controller.startAttempt(runId, laneId, START);
      blocked = "lane_control_delivered";
      await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow();
      blocked = null;

      let out = "";
      const code = await runFlowCli(
        ["reconcile", runId, laneId, (await h.controller.attempts(runId, laneId))[0]!.attemptId],
        { write: (t: string) => (out += t) },
        { write: () => {} },
        {
          environment: { FLOW_LEDGER_ROOT: ledgerRoot },
          interactiveFactory: () => h.controller,
        },
      );
      expect(code).toBe(0);
      expect(out).toContain("unresolvedControls=1");
      expect(out).not.toContain("control=null delivered=null");
    } finally {
      await rm(ledgerRoot, { recursive: true, force: true });
    }
  });
});

describe("P2-1 the reducer pairs deliveries strictly", () => {
  const envelope = (runId: string, sequence: number) => ({
    schemaVersion: 1 as const,
    eventId: `${runId}#${sequence}`,
    runId,
    sequence,
    at: sequence,
    controllerEpoch: 0,
  });

  async function seeded(attempts = ["a1"]) {
    const ledger = new InMemoryLedger();
    const runId = "run-pair";
    let n = 0;
    await ledger.commit({
      ...envelope(runId, ++n),
      type: "run_started",
      actor: "runtime",
      data: {
        workflow: "w", workspace: "ws", cwd: "/tmp", splitDirection: "right",
        tabId: "t1", controllerPaneId: "p1", fixedPoint: null, issue: null,
      },
    });
    await ledger.commit({
      ...envelope(runId, ++n),
      type: "lane_registered",
      actor: "runtime",
      laneId: "l1",
      data: {
        kind: "interactive", laneId: "l1", paneId: "p1", agentKind: "claude",
        model: "m", effort: "high", worktreePath: "/tmp/wt",
        artifactRoot: "/tmp/art", repoRoot: "/tmp",
      },
    });
    for (const attemptId of attempts) {
      await ledger.commit({
        ...envelope(runId, ++n),
        type: "interactive_attempt_started",
        actor: "runtime",
        laneId: "l1",
        data: {
          attemptId, ordinal: attempts.indexOf(attemptId) + 1,
          parentAttemptId: null, agentKind: "claude", model: "m", effort: "high",
          paneId: `p-${attemptId}`, worktreePath: "/tmp/wt",
          expectedAgentName: `f-l1-${attemptId}`,
          briefFile: "/tmp/b", checkpointFile: "/tmp/c", resultPointer: "/tmp/r",
          authorization: { actor: "human", note: "ok" },
        },
      });
    }
    return { ledger, runId, next: () => ++n };
  }

  const intent = (
    runId: string, sequence: number, attemptId: string, controlId: string,
  ) => ({
    ...envelope(runId, sequence),
    type: "lane_cancel_turn" as const,
    actor: "human" as const,
    laneId: "l1",
    data: {
      attemptId, controlId, target: "t1",
      method: "send-keys" as const, keys: ["esc"],
    },
  });

  const delivery = (
    runId: string, sequence: number, attemptId: string, controlId: string,
    control: "cancel-turn" | "abort-session" = "cancel-turn",
  ) => ({
    ...envelope(runId, sequence),
    type: "lane_control_delivered" as const,
    actor: "runtime" as const,
    laneId: "l1",
    data: {
      attemptId, controlId, control, target: "t1",
      method: control === "cancel-turn"
        ? ("send-keys" as const)
        : ("signal-process-group" as const),
      delivered: true, detail: null, observedStatus: null,
    },
  });

  test("a controlId cannot be reused after another control intervenes", async () => {
    const { ledger, runId, next } = await seeded();
    await ledger.commit(intent(runId, next(), "a1", "c1"));
    await ledger.commit(intent(runId, next(), "a1", "c2"));
    await expect(ledger.commit(intent(runId, next(), "a1", "c1"))).rejects.toThrow(
      /already used/,
    );
  });

  test("a delivery cannot cross attempts", async () => {
    const { ledger, runId, next } = await seeded(["a1", "a2"]);
    await ledger.commit(intent(runId, next(), "a1", "c1"));
    await expect(
      ledger.commit(delivery(runId, next(), "a2", "c1")),
    ).rejects.toThrow(/no pending control intent/);
  });

  test("a delivery cannot change the control kind", async () => {
    const { ledger, runId, next } = await seeded();
    await ledger.commit(intent(runId, next(), "a1", "c1"));
    await expect(
      ledger.commit(delivery(runId, next(), "a1", "c1", "abort-session")),
    ).rejects.toThrow(/does not match/);
  });

  test("a duplicate delivery is rejected", async () => {
    const { ledger, runId, next } = await seeded();
    await ledger.commit(intent(runId, next(), "a1", "c1"));
    await ledger.commit(delivery(runId, next(), "a1", "c1"));
    await expect(
      ledger.commit(delivery(runId, next(), "a1", "c1")),
    ).rejects.toThrow(/already recorded/);
  });

  test("a delivery with no intent at all is rejected", async () => {
    const { ledger, runId, next } = await seeded();
    await expect(
      ledger.commit(delivery(runId, next(), "a1", "ghost")),
    ).rejects.toThrow(/no pending control intent/);
  });
});

describe("P2-2 the canonical worktree path is the only one used", () => {
  test("the ledger and Herdr both receive the canonical path", async () => {
    const real = join(root, "real-wt");
    await mkdir(real, { recursive: true });
    const link = join(root, "link-wt");
    await Bun.spawn(["ln", "-s", real, link]).exited;

    const h = harness({
      isolation: permissive({ repoRoot: root, worktreePath: real }),
    });
    const { runId, laneId } = await h.controller.openLane({
      ...LANE,
      worktreePath: link,
      repoRoot: root,
    });
    await h.controller.startAttempt(runId, laneId, START);

    const run = (await h.ledger.load(runId))!;
    expect(run.lanes[laneId]!.worktreePath).toBe(real);
    expect(run.lanes[laneId]!.repoRoot).toBe(root);
    const attempt =
      run.interactiveAttempts[run.interactiveAttemptOrder[0]!]!;
    expect(attempt.worktreePath).toBe(real);
    // The pane was opened on the canonical path, not the symlink.
    expect(h.adapter.splitCwds).toContain(real);
    expect(h.adapter.splitCwds).not.toContain(link);
  });

  test("re-pointing the symlink after preflight changes nothing", async () => {
    const real = join(root, "verified");
    const decoy = join(root, "decoy");
    await mkdir(real, { recursive: true });
    await mkdir(decoy, { recursive: true });
    const link = join(root, "swing");
    await Bun.spawn(["ln", "-s", real, link]).exited;

    const h = harness({
      isolation: permissive({ repoRoot: root, worktreePath: real }),
    });
    const { runId, laneId } = await h.controller.openLane({
      ...LANE,
      worktreePath: link,
      repoRoot: root,
    });
    // The symlink now points somewhere that was never verified.
    await rm(link);
    await Bun.spawn(["ln", "-s", decoy, link]).exited;
    await h.controller.startAttempt(runId, laneId, START);

    const run = (await h.ledger.load(runId))!;
    expect(run.lanes[laneId]!.worktreePath).toBe(real);
    expect(h.adapter.splitCwds).not.toContain(decoy);
    expect(h.adapter.splitCwds).not.toContain(link);
  });

  test("a verification failure leaves no event, pane, or agent", async () => {
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
    expect(h.adapter.splitCwds).toHaveLength(0);
    expect(h.control.startCalls).toHaveLength(0);
  });
});

describe("a failed lease release never erases the mutation error", () => {
  /**
   * Sabotages the run's controller lock from inside the mutation body, so the
   * release at the end of the same critical section cannot prove ownership and
   * throws. `verdict` decides whether the body itself fails too.
   */
  class SabotagingSteer extends FakeHerdrAgentControl {
    constructor(
      options: { readonly panes: FakeHerdrAdapter },
      private readonly sabotage: () => Promise<"throw" | "pass">,
    ) {
      super(options);
    }

    override async promptAgent(
      target: string,
      text: string,
      options: AgentPromptOptions = {},
    ): Promise<AgentPromptResult> {
      if ((await this.sabotage()) === "throw") {
        throw new Error("injected steer failure");
      }
      return super.promptAgent(target, text, options);
    }
  }

  /** Returns the rejection of a steer, or null when it resolved. */
  async function steerUnder(
    verdict: "throw" | "pass",
    corruptLock: boolean,
  ): Promise<unknown> {
    const ledgerRoot = join(root, "ledger");
    let runDir = "";
    let armed = false;
    const h = harness({
      ledger: new FsLedger(ledgerRoot),
      control: (adapter) =>
        new SabotagingSteer({ panes: adapter }, async () => {
          // The attempt's own brief steers too; only the explicit steer below
          // is sabotaged.
          if (!armed) return "pass";
          if (corruptLock) {
            await writeFile(join(runDir, "controller.lock"), "{not json", "utf8");
          }
          return verdict;
        }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    runDir = join(ledgerRoot, "runs", runId);
    await h.controller.startAttempt(runId, laneId, START);
    armed = true;
    return h.controller.steer(runId, laneId, "keep going").then(
      () => null,
      (error: unknown) => error,
    );
  }

  test("a body failure stays primary and the release failure stays visible", async () => {
    const error = await steerUnder("throw", true);
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    // Both facts survive: why the mutation failed, and that the lock is stuck.
    expect(failure.message).toContain("injected steer failure");
    expect(failure.message).toContain("controller lease release failed");
    expect(failure.message).toContain("corrupt controller lease");
    // The caller can still recognize the original error by identity.
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toBe("injected steer failure");
  });

  test("a release failure alone is raised as itself", async () => {
    const error = await steerUnder("pass", true);
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toContain("corrupt controller lease");
    expect(failure.message).not.toContain("injected steer failure");
  });

  test("a body failure with a clean release is rethrown untouched", async () => {
    const error = await steerUnder("throw", false);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("injected steer failure");
    expect((error as Error).cause).toBeUndefined();
  });
});
