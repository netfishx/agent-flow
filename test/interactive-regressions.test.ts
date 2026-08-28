// One minimal regression per review finding. Every test here failed against
// 1c25ed7 and is the reason the corresponding fix exists.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FakeHerdrAgentControl } from "../src/herdr/fake-agent-control.ts";
import type { AgentInfoView } from "../src/herdr/agent-json.ts";
import { InMemoryLedger, type Ledger } from "../src/runtime/ledger.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import { attemptDisposition } from "../src/interactive/attempts.ts";
import {
  AttemptNotControllableError,
  InteractiveLaneController,
  LaneTakenOverError,
  RetryNotAuthorizedError,
  pendingRetries,
} from "../src/interactive/control-plane.ts";
import { agentNameFor } from "../src/herdr/agent-argv.ts";
import { buildNativeArgs } from "../src/interactive/commands.ts";
import { existsSync } from "node:fs";
import { RealHerdrAgentControl } from "../src/herdr/real-agent-control.ts";

/** Accepts every worktree; isolation itself is proved against real git. */
const permissiveIsolation = {
  verifyWriteWorktree: async (input: {
    readonly repoRoot: string;
    readonly worktreePath: string;
  }) => ({
    ok: true as const,
    canonicalRepoRoot: input.repoRoot,
    canonicalWorktreePath: input.worktreePath,
  }),
};


let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flow-regress-"));
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

const START = {
  authorization: { note: "owner authorized" },
} as const;

function harness(options: {
  /** Built with the harness's adapter so a started agent occupies its pane. */
  readonly control?: (adapter: FakeHerdrAdapter) => FakeHerdrAgentControl;
  readonly ledger?: Ledger;
  readonly adapter?: FakeHerdrAdapter;
} = {}) {
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
    isolation: permissiveIsolation,
    artifactRoot: root,
    clock: () => clock.now() + ++tick,
    idgen: () => `id-${++seq}`,
    sessionIdgen: () => "sess-1",
  });
  return { adapter, control: agentControl, ledger, controller };
}

async function opened(h: ReturnType<typeof harness>) {
  const { runId, laneId } = await h.controller.openLane({ ...LANE });
  await h.controller.startAttempt(runId, laneId, START);
  const [attempt] = await h.controller.attempts(runId, laneId);
  return { runId, laneId, attempt: attempt! };
}

describe("P1-1 abort refuses a pane the runtime no longer owns", () => {
  test("no SIGINT is delivered to a reoccupied pane", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    h.control.reoccupy(attempt.agentName!, "amp");
    await h.controller.reconcileAttempt(runId, laneId, attempt.attemptId);

    const before = h.adapter.interruptedPaneIds.length;
    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      AttemptNotControllableError,
    );
    expect(h.adapter.interruptedPaneIds).toHaveLength(before);
  });

  test("no SIGINT is delivered when the pane is gone", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    h.control.killAgent(attempt.agentName!);
    const gone = new FakeHerdrAdapter({ missingPaneIds: [attempt.paneId] });
    const recovered = harness({
      adapter: gone,
      control: () => h.control,
      ledger: h.ledger,
    });
    await recovered.controller.reconcileAttempt(runId, laneId, attempt.attemptId);
    await expect(
      recovered.controller.abortSession(runId, laneId),
    ).rejects.toThrow(AttemptNotControllableError);
    expect(gone.interruptedPaneIds).toHaveLength(0);
  });

  test("abort probes the pane before signalling, even with no prior reconcile", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    h.control.reoccupy(attempt.agentName!, "amp");
    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      AttemptNotControllableError,
    );
    expect(h.adapter.interruptedPaneIds).toHaveLength(0);
  });
});

describe("P1-2 a performed control never loses its intent", () => {
  /**
   * `getAgent` answers `okCalls` times and then fails. Abort probes before it
   * acts, so its probe consumes the first call; cancel-turn does not probe, so
   * its very first read is the post-effect observation. Either way the failure
   * modelled is a transient socket error AFTER the control landed — not a
   * control plane that was already broken when it was asked to act.
   */
  class ObservationFails extends FakeHerdrAgentControl {
    private calls = 0;
    constructor(
      private readonly okCalls: number,
      options: ConstructorParameters<typeof FakeHerdrAgentControl>[0],
    ) {
      super(options);
    }
    override async getAgent(target: string): Promise<AgentInfoView | null> {
      this.calls += 1;
      if (this.calls <= this.okCalls) return super.getAgent(target);
      throw new Error("herdr agent get failed (exit 1): io_error: socket closed");
    }
  }

  test("cancel-turn keeps the intent when the observation read throws", async () => {
    // No probe: the first read is the observation, and it fails.
    const h = harness({
      control: (adapter) => new ObservationFails(0, { panes: adapter }),
    });
    const { runId, laneId } = await opened(h);
    const before = h.control.sendKeysCalls.length;
    await h.controller.cancelTurn(runId, laneId);

    expect(h.control.sendKeysCalls).toHaveLength(before + 1);
    const [after] = await h.controller.attempts(runId, laneId);
    expect(after!.lastCancelTurnAt).not.toBeNull();
    expect(after!.controls.at(-1)?.control).toBe("cancel-turn");
    expect(after!.controls.at(-1)?.delivery?.delivered).toBe(true);
    // Unobserved, and recorded as unobserved rather than as a confirmation.
    expect(after!.controls.at(-1)?.delivery?.observedStatus).toBeNull();
  });

  test("abort keeps the intent and the terminal fact when observation throws", async () => {
    // The probe answers; the post-signal observation is what fails.
    const h = harness({
      control: (adapter) => new ObservationFails(1, { panes: adapter }),
    });
    const { runId, laneId } = await opened(h);
    await h.controller.abortSession(runId, laneId);

    expect(h.adapter.interruptedPaneIds).toHaveLength(1);
    const [after] = await h.controller.attempts(runId, laneId);
    expect(after!.lastAbortAt).not.toBeNull();
    expect(after!.endReason).toBe("aborted");
    expect(attemptDisposition(after!)).toBe("aborted");
  });

  test("intent is durable even if the Herdr effect itself throws", async () => {
    class ThrowingKeys extends FakeHerdrAgentControl {
      override async sendKeys(): Promise<never> {
        throw new Error("herdr agent send-keys failed (exit 1)");
      }
    }
    const h = harness({ control: (adapter) => new ThrowingKeys({ panes: adapter }) });
    const { runId, laneId } = await opened(h);
    await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow(
      /send-keys failed/,
    );
    const [after] = await h.controller.attempts(runId, laneId);
    // The intent survives; the delivery says it did NOT land.
    expect(after!.lastCancelTurnAt).not.toBeNull();
    expect(after!.controls.at(-1)?.delivery?.delivered).toBe(false);
  });
});

describe("P1-3 terminal facts are permanent", () => {
  test("a start failure cannot be rewritten by a later abort", async () => {
    const h = harness({
      control: (adapter) =>
        new FakeHerdrAgentControl({
          panes: adapter,
          defaultProgram: { startFailure: "herdr agent start timed out" },
        }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, START);
    const [failed] = await h.controller.attempts(runId, laneId);
    expect(failed!.endReason).toBe("start-failed");
    expect(failed!.endCause).toContain("timed out");

    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      AttemptNotControllableError,
    );
    const [after] = await h.controller.attempts(runId, laneId);
    expect(after!.endReason).toBe("start-failed");
    expect(after!.endCause).toContain("timed out");
    expect(h.adapter.interruptedPaneIds).toHaveLength(0);
  });

  test("an ended attempt refuses steer, cancel, and abort", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.abortSession(runId, laneId);
    for (const call of [
      () => h.controller.steer(runId, laneId, "x"),
      () => h.controller.cancelTurn(runId, laneId),
      () => h.controller.abortSession(runId, laneId),
    ]) {
      await expect(call()).rejects.toThrow(AttemptNotControllableError);
    }
  });

  test("a checkpoint is write-once per attempt", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.collectAgentCheckpoint(runId, laneId, attempt.attemptId);
    await expect(
      h.controller.collectAgentCheckpoint(runId, laneId, attempt.attemptId),
    ).rejects.toThrow(/checkpoint/);
  });
});

describe("P1-4 / P2-2 reconciliation observes but never resurrects", () => {
  test("a live observation after an end does not restore controllability", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    h.control.reoccupy(attempt.agentName!, "amp");
    expect(
      await h.controller.reconcileAttempt(runId, laneId, attempt.attemptId),
    ).toBe("reoccupied");

    h.control.reoccupy(attempt.agentName!, "claude");
    expect(
      await h.controller.reconcileAttempt(runId, laneId, attempt.attemptId),
    ).toBe("live");
    const [after] = await h.controller.attempts(runId, laneId);
    // The latest observation is kept...
    expect(after!.reconciliation?.outcome).toBe("live");
    // ...and the attempt stays ended and uncontrollable.
    expect(after!.endReason).toBe("lost");
    await expect(h.controller.steer(runId, laneId, "x")).rejects.toThrow(
      AttemptNotControllableError,
    );
  });

  test("repeat reconciliation of a live attempt is allowed and keeps latest", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    for (let i = 0; i < 3; i++) {
      expect(
        await h.controller.reconcileAttempt(runId, laneId, attempt.attemptId),
      ).toBe("live");
    }
    const [after] = await h.controller.attempts(runId, laneId);
    expect(after!.reconciliation?.outcome).toBe("live");
    expect(after!.endReason).toBeNull();
    // Still steerable: a live observation is not a state change.
    await expect(h.controller.steer(runId, laneId, "x")).resolves.toBeDefined();
  });
});

describe("P1-4 retry authorization is consumed atomically", () => {
  test("two concurrent retries on one authorization produce exactly one child", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.authorizeRetry(runId, laneId, attempt.attemptId, "once");

    const panesBefore = h.control.startCalls.length;
    const results = await Promise.allSettled([
      h.controller.startAttempt(runId, laneId, {
        ...START,
        parentAttemptId: attempt.attemptId,
      }),
      h.controller.startAttempt(runId, laneId, {
        ...START,
        parentAttemptId: attempt.attemptId,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason),
    ).toContain("retry authorization");

    const attempts = await h.controller.attempts(runId, laneId);
    expect(attempts).toHaveLength(2);
    expect(h.control.startCalls).toHaveLength(panesBefore + 1);
    expect(pendingRetries((await h.ledger.load(runId))!, attempt.attemptId)).toBe(0);
    // No orphan: every attempt either bound an agent or recorded a failure.
    for (const a of attempts) {
      expect(a.agentName !== null || a.endReason !== null).toBe(true);
    }
  });

  test("pendingRetries never goes negative", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.authorizeRetry(runId, laneId, attempt.attemptId, "once");
    await h.controller.startAttempt(runId, laneId, {
      ...START,
      parentAttemptId: attempt.attemptId,
    });
    expect(pendingRetries((await h.ledger.load(runId))!, attempt.attemptId)).toBe(0);
    await expect(
      h.controller.startAttempt(runId, laneId, {
        ...START,
        parentAttemptId: attempt.attemptId,
      }),
    ).rejects.toThrow(RetryNotAuthorizedError);
    expect(
      pendingRetries((await h.ledger.load(runId))!, attempt.attemptId),
    ).toBeGreaterThanOrEqual(0);
  });

  test("supersededBy is derived, with no event of its own", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.authorizeRetry(runId, laneId, attempt.attemptId, "retry");
    await h.controller.startAttempt(runId, laneId, {
      ...START,
      parentAttemptId: attempt.attemptId,
    });
    const [before, after] = await h.controller.attempts(runId, laneId);
    expect(before!.supersededBy).toBe(after!.attemptId);
    expect(attemptDisposition(before!)).toBe("superseded");
  });
});

describe("P2-3 the ledger lease is actually held", () => {
  test("mutations acquire and release the lease", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const base = new InMemoryLedger();
    const ledger: Ledger = {
      commit: (event) => base.commit(event),
      load: (runId) => base.load(runId),
      list: () => base.list(),
      acquireLease: async (runId, controller) => {
        acquired.push(runId);
        const handle = await base.acquireLease(runId, controller);
        return {
          release: async () => {
            released.push(runId);
            await handle.release();
          },
        };
      },
    };
    const h = harness({ ledger });
    const { runId, laneId } = await opened(h);
    expect(acquired.length).toBeGreaterThan(0);
    expect(released).toHaveLength(acquired.length);
    await h.controller.cancelTurn(runId, laneId);
    expect(released).toHaveLength(acquired.length);
  });

  test("a lease that cannot be acquired stops the mutation before any effect", async () => {
    const base = new InMemoryLedger();
    let fail = false;
    const ledger: Ledger = {
      commit: (event) => base.commit(event),
      load: (runId) => base.load(runId),
      list: () => base.list(),
      acquireLease: async (runId, controller) => {
        if (fail) throw new Error("controller lease is already held");
        return base.acquireLease(runId, controller);
      },
    };
    const h = harness({ ledger });
    const { runId, laneId } = await opened(h);
    fail = true;
    const keysBefore = h.control.sendKeysCalls.length;
    await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow(
      /lease/,
    );
    expect(h.control.sendKeysCalls).toHaveLength(keysBefore);
  });

  test("the lease is released even when the mutation throws", async () => {
    const released: string[] = [];
    const base = new InMemoryLedger();
    const ledger: Ledger = {
      commit: (event) => base.commit(event),
      load: (runId) => base.load(runId),
      list: () => base.list(),
      acquireLease: async (runId, controller) => {
        const handle = await base.acquireLease(runId, controller);
        return {
          release: async () => {
            released.push(runId);
            await handle.release();
          },
        };
      },
    };
    const h = harness({ ledger });
    const { runId, laneId } = await opened(h);
    const before = released.length;
    await h.controller.abortSession(runId, laneId);
    await expect(h.controller.cancelTurn(runId, laneId)).rejects.toThrow(
      AttemptNotControllableError,
    );
    expect(released.length).toBeGreaterThan(before);
  });
});

describe("P2-4 unknown Herdr errors fail closed", () => {
  test("only agent_not_found means the agent is absent", async () => {
    const control = new RealHerdrAgentControl({ binary: "/nonexistent-herdr" });
    // A binary that cannot run is a control-plane failure, never "no agent".
    await expect(control.getAgent("whatever")).rejects.toThrow();
  });

  test("an unclassified error is not turned into a missing agent", async () => {
    class OddError extends FakeHerdrAgentControl {
      override async getAgent(): Promise<never> {
        throw new Error("herdr agent get failed (exit 1): io_error: broken pipe");
      }
    }
    const h = harness({ control: (adapter) => new OddError({ panes: adapter }) });
    const { runId, laneId, attempt } = await opened(h);
    // Reconciliation must not read a control-plane failure as a dead agent
    // while the pane is demonstrably still there.
    const outcome = await h.controller.reconcileAttempt(
      runId,
      laneId,
      attempt.attemptId,
    );
    expect(outcome).toBe("unknown-probe");
    const [after] = await h.controller.attempts(runId, laneId);
    expect(after!.endReason).toBeNull();
    expect(after!.exitCode).toBeNull();
    await expect(h.controller.steer(runId, laneId, "x")).rejects.toThrow(
      AttemptNotControllableError,
    );
  });
});

describe("agent names are collision-free", () => {
  test("attempt ids that share a long prefix get different names", () => {
    const a = agentNameFor("impl-1", "att-mabcdefg-a1");
    const b = agentNameFor("impl-1", "att-mabcdefg-b2");
    expect(a).not.toBe(b);
    const many = new Set(
      Array.from({ length: 500 }, (_, i) =>
        agentNameFor("a-very-long-lane-identifier", `att-mabcdefg-${i}`),
      ),
    );
    expect(many.size).toBe(500);
  });
});

describe("session identity keeps its unavailable reason", () => {
  test("a kind with no observable session records why", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({
      ...LANE,
      laneId: "impl-2",
      agentKind: "codex",
    });
    await h.controller.startAttempt(runId, laneId, START);
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.session.kind).toBe("unavailable");
    if (attempt!.session.kind === "unavailable") {
      expect(attempt!.session.reason.length).toBeGreaterThan(0);
    }
  });

  test("a pre-assigned session id is recorded as measured", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    expect(attempt.session.kind).toBe("measured");
    void runId;
    void laneId;
  });
});

describe("old ledgers still replay", () => {
  test("a run written before the interactive lane loads unchanged", async () => {
    const ledger = new FsLedger(root);
    const base = { schemaVersion: 1 as const, runId: "run-old", controllerEpoch: 0 };
    await ledger.commit({
      ...base,
      eventId: "run-old#1",
      sequence: 1,
      at: 1,
      type: "run_started",
      actor: "runtime",
      data: {
        workflow: "legacy",
        workspace: "ws",
        cwd: "/tmp",
        splitDirection: "right",
        tabId: "t1",
        controllerPaneId: "p1",
        fixedPoint: null,
        issue: null,
      },
    });
    await ledger.commit({
      ...base,
      eventId: "run-old#2",
      sequence: 2,
      at: 2,
      type: "lane_registered",
      actor: "runtime",
      laneId: "sim-1",
      data: {
        laneId: "sim-1",
        paneId: "p2",
        logFile: "/tmp/log",
        stderrFile: "/tmp/err",
        sentinelToken: "FLOW_run-old_LANE_sim-1_EXIT",
        steps: 1,
        stepDelaySeconds: 0,
      },
    });
    const view = await new FsLedger(root).load("run-old");
    expect(view!.lanes["sim-1"]!.kind).toBe("simulated");
    expect(view!.lanes["sim-1"]!.logFile).toBe("/tmp/log");
    expect(view!.interactiveAttemptOrder).toEqual([]);
    expect(view!.retryAuthorizations).toEqual([]);
  });
});

describe("launching a session and briefing it are separate operations", () => {
  // Stage 1 measured Herdr 0.8.2 calling a Codex update modal `idle` with
  // `interactive_ready: true`. A launch therefore proves a session exists, not
  // that anything can be told to it, and the runtime refuses to guess.
  const AUTH = { authorization: { note: "owner authorized" } } as const;

  /** Fails the test if a launch consults vendor lifecycle state at all. */
  class NoStateProbe extends FakeHerdrAgentControl {
    override async getAgent(): Promise<never> {
      throw new Error("startAttempt read vendor agent state");
    }

    override async waitForState(): Promise<never> {
      throw new Error("startAttempt waited on vendor agent state");
    }
  }

  async function launched(h: ReturnType<typeof harness>) {
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    const outcome = await h.controller.startAttempt(runId, laneId, AUTH);
    const [attempt] = await h.controller.attempts(runId, laneId);
    return { runId, laneId, outcome, attempt: attempt! };
  }

  test("a start Herdr calls idle and ready still submits no prompt", async () => {
    const h = harness();
    const { outcome, attempt } = await launched(h);

    expect(outcome.started).toBe(true);
    expect(h.control.startCalls).toHaveLength(1);
    // Advisory readiness authorizes nothing.
    expect(h.control.promptCalls).toEqual([]);
    expect(attempt.steerSubmissions).toBe(0);
  });

  test("the attempt is bound and controllable once the session is up", async () => {
    const h = harness();
    const { attempt } = await launched(h);

    expect(attempt.agentName).toBe(attempt.expectedAgentName);
    expect(attempt.endReason).toBeNull();
    expect(attemptDisposition(attempt)).toBe("running");
  });

  test("an operator steer is the first and only prompt", async () => {
    const h = harness();
    const { runId, laneId } = await launched(h);

    const observation = await h.controller.steer(runId, laneId, "AF49 brief");

    expect(h.control.promptCalls.map((call) => call.text)).toEqual([
      "AF49 brief",
    ]);
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.steerSubmissions).toBe(1);
    // The existing steer evidence chain carries the brief: intent, delivery,
    // observation — no new event and no new state.
    expect(observation.outcome).toBe("state-observed");
    expect(attempt!.advisory.length).toBeGreaterThan(0);
  });

  test("a launch needs no vendor TUI state to succeed", async () => {
    const h = harness({
      control: (adapter) => new NoStateProbe({ panes: adapter }),
    });

    const { outcome } = await launched(h);

    expect(outcome.started).toBe(true);
    expect(outcome.startFailure).toBeNull();
    expect(h.control.promptCalls).toEqual([]);
  });
});

describe("the default grok interactive write lane fails closed", () => {
  // Stage 2 measured grok 1.0.10 writing a file in `--permission-mode default`
  // with no approval UI at all, and its documented `ask` rules cannot be set
  // per invocation: there is no `--ask` flag and the env overlay silently drops
  // `permission.*`. A lane whose human approval gate cannot be guaranteed does
  // not start by default.
  const GROK_LANE = { ...LANE, agentKind: "grok", model: "grok-4.6" } as const;

  test("buildNativeArgs refuses grok and says why", () => {
    const build = () =>
      buildNativeArgs({
        agentKind: "grok",
        model: "grok-4.6",
        effort: "high",
        sessionId: "11111111-2222-3333-4444-555555555555",
      });

    expect(build).toThrow(/grok/i);
    let message = "";
    try {
      build();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The three facts an operator needs, in the error itself.
    expect(message).toContain("interactive write lane");
    expect(message).toContain("per-invocation");
    expect(message).toContain("nativeArgs");
  });

  test("a grok attempt with no override creates nothing at all", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...GROK_LANE });
    const panesAfterOpen = h.adapter.splitCwds.length;
    const eventsAfterOpen = (await h.ledger.load(runId))!.lastAppliedSequence;

    await expect(
      h.controller.startAttempt(runId, laneId, {
        authorization: { note: "owner authorized" },
      }),
    ).rejects.toThrow(/grok/i);

    const after = (await h.ledger.load(runId))!;
    // No event, no pane, no agent, no artifact.
    expect(after.lastAppliedSequence).toBe(eventsAfterOpen);
    expect(await h.controller.attempts(runId, laneId)).toHaveLength(0);
    expect(h.adapter.splitCwds).toHaveLength(panesAfterOpen);
    expect(h.control.startCalls).toHaveLength(0);
    expect(h.control.promptCalls).toHaveLength(0);
    expect(existsSync(join(root, runId))).toBe(false);
  });

  test("an owner nativeArgs override is used whole, with no default mixed in", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...GROK_LANE });
    const override = ["--no-leader", "-m", "grok-4.6", "--permission-mode", "plan"];

    const outcome = await h.controller.startAttempt(runId, laneId, {
      authorization: { note: "owner authorized this override" },
      nativeArgs: override,
    });

    expect(outcome.started).toBe(true);
    expect(h.control.startCalls).toHaveLength(1);
    // Exactly the operator's array — the refused defaults are not appended.
    expect(h.control.startCalls[0]!.nativeArgs).toEqual(override);
    expect(h.control.startCalls[0]!.kind).toBe("grok");
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.agentName).not.toBeNull();
  });
});

describe("session identity comes from evidence, never from an unused id", () => {
  // Stage 9 measured the defect: an owner override launched grok with
  // `--no-leader -m grok-4.6 --reasoning-effort high --permission-mode default`
  // and Herdr reported no session, yet the bind recorded the controller's own
  // generated uuid as `measured`, with evidence naming a `--session-id` flag
  // that was not in the argv.
  const GROK_LANE = { ...LANE, agentKind: "grok", model: "grok-4.6" } as const;
  const OVERRIDE = ["--no-leader", "-m", "grok-4.6", "--permission-mode", "plan"];

  test("an override carrying no --session-id records unavailable, not a minted id", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...GROK_LANE });

    await h.controller.startAttempt(runId, laneId, {
      authorization: { note: "owner authorized this override" },
      nativeArgs: OVERRIDE,
    });

    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.session.kind).toBe("unavailable");
    expect(attempt!.session).not.toHaveProperty("id");
    const reason = (attempt!.session as { reason: string }).reason;
    expect(reason).toContain("reported no session id");
    expect(reason).toContain("--session-id");
    // The generated id must appear nowhere the ledger can be read from: it
    // never reached the process, so it is evidence of nothing.
    const run = await h.ledger.load(runId);
    expect(JSON.stringify(run)).not.toContain("sess-1");
  });

  test("an override that does carry --session-id records that real value", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...GROK_LANE });

    await h.controller.startAttempt(runId, laneId, {
      authorization: { note: "owner authorized this override" },
      nativeArgs: [...OVERRIDE, "--session-id", "owner-session"],
    });

    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.session.kind).toBe("measured");
    expect((attempt!.session as { id: string }).id).toBe("owner-session");
    expect((attempt!.session as { evidence: string }).evidence).toContain(
      "actual argv",
    );
  });

  test("the claude default still records the id its own argv carried", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...LANE });

    await h.controller.startAttempt(runId, laneId, START);

    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(h.control.startCalls[0]!.nativeArgs).toContain("--session-id");
    expect(attempt!.session.kind).toBe("measured");
    expect((attempt!.session as { id: string }).id).toBe("sess-1");
    expect((attempt!.session as { evidence: string }).evidence).toContain(
      "actual argv",
    );
  });

  test("a session Herdr observed outranks the argv fallback", async () => {
    const h = harness({
      control: (adapter) =>
        new FakeHerdrAgentControl({
          panes: adapter,
          defaultProgram: { sessionId: "herdr-observed" },
        }),
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });

    await h.controller.startAttempt(runId, laneId, START);

    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.session.kind).toBe("measured");
    // The argv carried "sess-1"; Herdr's own report wins.
    expect((attempt!.session as { id: string }).id).toBe("herdr-observed");
    expect((attempt!.session as { evidence: string }).evidence).toContain(
      "herdr agent surface",
    );
  });
});

// ---------------------------------------------------------------------------
// Revision 14 — the final-audit findings that needed production code.
// Each test below fails against d111113 and is the reason its fix exists.
// ---------------------------------------------------------------------------

/** Wraps a ledger so a test can read exactly which events were committed. */
function recording(base: Ledger) {
  const committed: RunEvent[] = [];
  const ledger: Ledger = {
    commit: async (event) => {
      committed.push(event);
      await base.commit(event);
    },
    load: (runId) => base.load(runId),
    list: () => base.list(),
    acquireLease: (runId, controller) => base.acquireLease(runId, controller),
  };
  return { ledger, committed };
}

function ownershipData(committed: readonly RunEvent[], type: string) {
  const event = committed.find((candidate) => candidate.type === type);
  expect(event).toBeDefined();
  return event!.data as Record<string, unknown>;
}

/** Seeds one raw event straight into a ledger, the way an old run recorded it. */
async function seed(
  ledger: Ledger,
  runId: string,
  type: "lane_takeover" | "lane_release",
  laneId: string,
): Promise<void> {
  const run = (await ledger.load(runId))!;
  await ledger.commit({
    schemaVersion: 1,
    eventId: `${runId}#${run.lastAppliedSequence + 1}`,
    runId,
    sequence: run.lastAppliedSequence + 1,
    at: 9_000 + run.lastAppliedSequence,
    controllerEpoch: 0,
    type,
    actor: "human",
    laneId,
    // The shape every takeover and release carried before Revision 14.
    data: {},
  } as RunEvent);
}

describe("SP2 takeover and release are distinguishable from the ledger alone", () => {
  test("both record attempt, pane, target, method, and observed state", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId, attempt } = await opened(h);
    committed.length = 0;

    await h.controller.takeover(runId, laneId);
    await h.controller.release(runId, laneId);

    for (const type of ["lane_takeover", "lane_release"]) {
      const data = ownershipData(committed, type);
      expect(data.attemptId).toBe(attempt.attemptId);
      expect(data.paneId).toBe(attempt.paneId);
      // The agent this lane is actually controlled through, not the pane.
      expect(data.target).toBe(attempt.agentName);
      // A value that says what changed: the ledger's control mode, nothing else.
      expect(data.method).toBe("ledger-control-mode");
      expect(data.observedStatus).not.toBeUndefined();
    }
    // Actor stays on the envelope, where every other control intent carries it.
    const takeover = committed.find((e) => e.type === "lane_takeover")!;
    expect(takeover.actor).toBe("human");
    expect(takeover.laneId).toBe(laneId);
  });

  test("ownership never sends a prompt, a key, or a signal", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    const prompts = h.control.promptCalls.length;
    const keys = h.control.sendKeysCalls.length;
    const signals = h.adapter.interruptedPaneIds.length;

    await h.controller.takeover(runId, laneId);
    await h.controller.release(runId, laneId);

    expect(h.control.promptCalls).toHaveLength(prompts);
    expect(h.control.sendKeysCalls).toHaveLength(keys);
    expect(h.adapter.interruptedPaneIds).toHaveLength(signals);
    // The read it does make is exactly that: a read.
    expect(h.control.startCalls).toHaveLength(1);
  });

  test("an unreadable agent records null and still switches ownership", async () => {
    class UnreadableAgent extends FakeHerdrAgentControl {
      override async getAgent(target: string): Promise<AgentInfoView | null> {
        this.getCalls.push(target);
        throw new Error("herdr agent get failed (exit 1): io_error: broken pipe");
      }
    }
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({
      ledger,
      control: (adapter) => new UnreadableAgent({ panes: adapter }),
    });
    const { runId, laneId } = await opened(h);
    committed.length = 0;

    // A best-effort observation that cannot answer must not block ownership,
    // and must never be replaced by a guessed status.
    await h.controller.takeover(runId, laneId);
    expect(ownershipData(committed, "lane_takeover").observedStatus).toBeNull();
    const [held] = await h.controller.attempts(runId, laneId);
    expect(held!.controlMode).toBe("human_owned");

    await h.controller.release(runId, laneId);
    expect(ownershipData(committed, "lane_release").observedStatus).toBeNull();
    const [freed] = await h.controller.attempts(runId, laneId);
    expect(freed!.controlMode).toBe("managed");
  });

  test("a lane with no attempt yet records nulls rather than inventing a target", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    committed.length = 0;

    await h.controller.takeover(runId, laneId);
    const data = ownershipData(committed, "lane_takeover");
    expect(data.attemptId).toBeNull();
    expect(data.paneId).toBeNull();
    expect(data.target).toBeNull();
    expect(data.observedStatus).toBeNull();
    expect(data.method).toBe("ledger-control-mode");
  });

  test("a historical empty payload still replays and still gates control", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);

    await seed(h.ledger, runId, "lane_takeover", laneId);
    const [held] = await h.controller.attempts(runId, laneId);
    expect(held!.controlMode).toBe("human_owned");
    await expect(h.controller.steer(runId, laneId, "no")).rejects.toThrow(
      LaneTakenOverError,
    );

    await seed(h.ledger, runId, "lane_release", laneId);
    const [freed] = await h.controller.attempts(runId, laneId);
    expect(freed!.controlMode).toBe("managed");
    await h.controller.steer(runId, laneId, "resumed");
    expect(h.control.promptCalls.at(-1)!.text).toBe("resumed");
  });
});

describe("SP7 takeover fails closed for abort, not only for prompt and keys", () => {
  test("abort under takeover throws before probing or signalling anything", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId } = await opened(h);
    await h.controller.takeover(runId, laneId);

    const reads = h.control.getCalls.length;
    const signals = h.adapter.interruptedPaneIds.length;
    committed.length = 0;

    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      LaneTakenOverError,
    );

    // Refused before the probe: a taken-over lane is not even looked at.
    expect(h.control.getCalls).toHaveLength(reads);
    expect(h.adapter.interruptedPaneIds).toHaveLength(signals);
    const types = committed.map((event) => event.type);
    expect(types).not.toContain("lane_abort_session");
    expect(types).not.toContain("lane_control_delivered");
    expect(types).not.toContain("interactive_attempt_ended");
    expect(types).not.toContain("interactive_attempt_reconciled");

    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.endReason).toBeNull();
  });

  test("release restores abort exactly as it behaved before", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.takeover(runId, laneId);
    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      LaneTakenOverError,
    );

    await h.controller.release(runId, laneId);
    await h.controller.abortSession(runId, laneId);
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.endReason).toBe("aborted");
    expect(attempt!.exitCode).toBeNull();
    expect(attemptDisposition(attempt!)).toBe("aborted");
  });

  test("the refusal names every control it covers, and no read", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.takeover(runId, laneId);
    const error = await h.controller
      .abortSession(runId, laneId)
      .then(() => null, (caught: Error) => caught);
    expect(error).toBeInstanceOf(LaneTakenOverError);
    // The message may not keep claiming the boundary is prompt/send-keys only.
    expect(error!.message).toContain("abort");
    expect(error!.message).toContain(laneId);
  });
});

describe("SP3 a lane end releases the advisory source it published", () => {
  test("publish then abort releases exactly once, for that run's source", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");
    expect(h.control.releaseCalls).toHaveLength(0);

    await h.controller.abortSession(runId, laneId);

    expect(h.control.releaseCalls).toHaveLength(1);
    expect(h.control.releaseCalls[0]!.source).toBe(`agent-flow-${runId}`);
    expect(h.control.releaseCalls[0]!.paneId).toBe(attempt.paneId);
    expect(h.control.releaseCalls[0]!.agent).toBe(attempt.agentName!);
  });

  test("an attempt that never published is never released", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.abortSession(runId, laneId);
    expect(h.control.releaseCalls).toHaveLength(0);
  });

  test("cleanup changes no outcome fact and is not completion evidence", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");
    await h.controller.abortSession(runId, laneId);

    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.endReason).toBe("aborted");
    expect(attempt!.exitCode).toBeNull();
    expect(attempt!.agentCheckpoint).toBeNull();
    expect(attempt!.runnerEvidence).toHaveLength(0);
    expect(attemptDisposition(attempt!)).toBe("aborted");
    // The published record stays where it was, on the advisory channel only.
    const published = attempt!.advisory.filter(
      (entry) => entry.source === "runtime-published",
    );
    expect(published).toHaveLength(1);
  });

  test("an unclassified cleanup failure surfaces and never erases the end", async () => {
    class ReleaseBreaks extends FakeHerdrAgentControl {
      override async releaseAgentState(options: {
        readonly paneId: string;
        readonly source: string;
        readonly agent: string;
      }): Promise<void> {
        this.releaseCalls.push(options);
        throw new Error("herdr pane release-agent failed (exit 1): io_error");
      }
    }
    const h = harness({
      control: (adapter) => new ReleaseBreaks({ panes: adapter }),
    });
    const { runId, laneId } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");

    await expect(h.controller.abortSession(runId, laneId)).rejects.toThrow(
      "io_error",
    );
    // The attempt still ended. A cleanup that broke is not an attempt that
    // stayed alive, and it is not a fact the ledger may lose.
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.endReason).toBe("aborted");
    expect(attempt!.exitCode).toBeNull();
    expect(h.control.releaseCalls).toHaveLength(1);
  });

  test("a lost pane is never released: the runtime no longer owns it", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");
    h.control.killAgent(attempt.agentName!);
    const gone = new FakeHerdrAdapter({ missingPaneIds: [attempt.paneId] });
    const recovered = harness({
      adapter: gone,
      control: () => h.control,
      ledger: h.ledger,
    });

    const outcome = await recovered.controller.reconcileAttempt(
      runId,
      laneId,
      attempt.attemptId,
    );
    expect(outcome).toBe("missing");
    const [ended] = await recovered.controller.attempts(runId, laneId);
    expect(ended!.endReason).toBe("lost");
    // Nothing is sent to a pane that is gone, or to whoever holds it now.
    expect(h.control.releaseCalls).toHaveLength(0);
  });

  test("releasing a source for an absent agent succeeds, and is idempotent", async () => {
    // Models what Herdr 0.8.2 was MEASURED to do for this verb on a real pane
    // with no such agent: exit 0, empty stdout, empty stderr — twice.
    // (Evidence: agent-flow-af49r15-evidence/04-release-agent-probe.txt.)
    const stub = join(root, "herdr-absent");
    const calls = join(root, "herdr-absent.calls");
    await writeFile(
      stub,
      "#!/bin/sh\n" + `printf '%s\\n' "$*" >> ${calls}\n` + "exit 0\n",
      "utf8",
    );
    await chmod(stub, 0o755);
    const control = new RealHerdrAgentControl({ binary: stub });
    const target = {
      paneId: "w1:p2",
      source: "agent-flow-run",
      agent: "f-lane-1",
    };
    await expect(control.releaseAgentState(target)).resolves.toBeUndefined();
    await expect(control.releaseAgentState(target)).resolves.toBeUndefined();
    // Proof the stub really ran, twice, with the pane id leading the argv.
    const recorded = (await Bun.file(calls).text()).trim().split("\n");
    expect(recorded).toHaveLength(2);
    for (const line of recorded) {
      expect(line.startsWith("pane release-agent w1:p2 ")).toBe(true);
      expect(line).toContain("--source agent-flow-run");
      expect(line).toContain("--agent f-lane-1");
    }
  });

  test("a pane that does not resolve is raised, never read as a source dropped", async () => {
    // The other MEASURED answer: a nonexistent pane returns pane_not_found on
    // exit 1, and that is a different fact from an absent agent.
    const stub = join(root, "herdr-broken");
    await writeFile(
      stub,
      "#!/bin/sh\n" +
        'printf \'{"error":{"code":"pane_not_found","message":"pane wZ:p999 not found"}}\' 1>&2\n' +
        "exit 1\n",
      "utf8",
    );
    await chmod(stub, 0o755);
    const control = new RealHerdrAgentControl({ binary: stub });
    await expect(
      control.releaseAgentState({
        paneId: "wZ:p999",
        source: "agent-flow-run",
        agent: "f-lane-1",
      }),
    ).rejects.toThrow("pane_not_found");
  });

  test("a reoccupied pane is never released to its new occupant", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");
    h.control.reoccupy(attempt.agentName!, "amp");

    const outcome = await h.controller.reconcileAttempt(
      runId,
      laneId,
      attempt.attemptId,
    );
    expect(outcome).toBe("reoccupied");
    const [ended] = await h.controller.attempts(runId, laneId);
    expect(ended!.endReason).toBe("lost");
    expect(h.control.releaseCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Revision 15 — R2-S4 (retry evidence), SP3 (post-end publication), R2-S6.
// ---------------------------------------------------------------------------

/** Seeds a SECOND interactive lane, with one bound attempt, onto the same run. */
async function seedSecondLane(
  ledger: Ledger,
  runId: string,
  laneId: string,
  attemptId: string,
): Promise<void> {
  const base = (await ledger.load(runId))!;
  let sequence = base.lastAppliedSequence;
  const commit = async (
    type: RunEvent["type"],
    actor: string,
    data: unknown,
  ): Promise<void> => {
    sequence += 1;
    await ledger.commit({
      schemaVersion: 1,
      eventId: `${runId}#${sequence}`,
      runId,
      sequence,
      at: 7_000 + sequence,
      controllerEpoch: 0,
      type,
      actor,
      laneId,
      data,
    } as RunEvent);
  };
  await commit("lane_registered", "runtime", {
    kind: "interactive",
    laneId,
    paneId: "wf:p80",
    agentKind: "claude",
    model: "sonnet",
    effort: "high",
    worktreePath: "/tmp/repo-wt",
    repoRoot: "/tmp/repo",
    artifactRoot: "/tmp/artifacts",
  });
  await commit("interactive_attempt_started", "runtime", {
    attemptId,
    ordinal: 1,
    parentAttemptId: null,
    agentKind: "claude",
    model: "sonnet",
    effort: "high",
    paneId: "wf:p81",
    expectedAgentName: "f-other-1-aaaaaaaaaaaaaaaa",
    worktreePath: "/tmp/repo-wt",
    briefFile: "/tmp/b.md",
    checkpointFile: "/tmp/c.md",
    resultPointer: "/tmp/r.md",
    authorization: { actor: "human", note: "seeded" },
  });
}

describe("R2-S4 a retry authorization is readable from the ledger alone", () => {
  test("it records parent, pane, target, method, observed state, and note", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId, attempt } = await opened(h);
    committed.length = 0;

    await h.controller.authorizeRetry(
      runId,
      laneId,
      attempt.attemptId,
      "owner authorizes exactly one retry",
    );

    const event = committed.find(
      (candidate) => candidate.type === "interactive_retry_authorized",
    );
    expect(event).toBeDefined();
    expect(event!.actor).toBe("human");
    expect(event!.laneId).toBe(laneId);
    const data = event!.data as unknown as Record<string, unknown>;
    expect(data.parentAttemptId).toBe(attempt.attemptId);
    expect(data.paneId).toBe(attempt.paneId);
    expect(data.target).toBe(attempt.agentName!);
    expect(data.method).toBe("ledger-retry-authorization");
    expect(data.note).toBe("owner authorizes exactly one retry");
    // A live read at the moment of authorization, not a guess.
    expect(data.observedStatus).not.toBeUndefined();
    expect(data.observedStatus).not.toBeNull();
  });

  test("an unreadable agent records null and still authorizes", async () => {
    class UnreadableAgent extends FakeHerdrAgentControl {
      override async getAgent(target: string): Promise<AgentInfoView | null> {
        this.getCalls.push(target);
        throw new Error("herdr agent get failed (exit 1): io_error");
      }
    }
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({
      ledger,
      control: (adapter) => new UnreadableAgent({ panes: adapter }),
    });
    const { runId, laneId, attempt } = await opened(h);
    committed.length = 0;

    await h.controller.authorizeRetry(runId, laneId, attempt.attemptId, "note");
    const event = committed.find(
      (c) => c.type === "interactive_retry_authorized",
    )!;
    expect(
      (event.data as unknown as Record<string, unknown>).observedStatus,
    ).toBeNull();
    // The authorization is a human act; a failed read may not veto it.
    expect(pendingRetries(await h.controller.inspect(runId), attempt.attemptId)).toBe(1);
  });

  test("an unknown parent is refused before any event or Herdr read", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId } = await opened(h);
    const reads = h.control.getCalls.length;
    committed.length = 0;

    await expect(
      h.controller.authorizeRetry(runId, laneId, "att-does-not-exist", "note"),
    ).rejects.toThrow("att-does-not-exist");

    expect(committed).toHaveLength(0);
    expect(h.control.getCalls).toHaveLength(reads);
  });

  test("a parent from another lane is refused before any event or Herdr read", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId, attempt } = await opened(h);
    await seedSecondLane(h.ledger, runId, "other-1", "att-other-1");
    const reads = h.control.getCalls.length;
    committed.length = 0;

    // The attempt exists, but it belongs to a different lane.
    await expect(
      h.controller.authorizeRetry(runId, laneId, "att-other-1", "note"),
    ).rejects.toThrow(laneId);
    expect(committed).toHaveLength(0);
    expect(h.control.getCalls).toHaveLength(reads);

    // And the reverse direction is refused too.
    await expect(
      h.controller.authorizeRetry(runId, "other-1", attempt.attemptId, "note"),
    ).rejects.toThrow("other-1");
    expect(committed).toHaveLength(0);
  });

  test("authorizing sends no prompt, no key, and no signal", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    const prompts = h.control.promptCalls.length;
    const keys = h.control.sendKeysCalls.length;
    const signals = h.adapter.interruptedPaneIds.length;

    await h.controller.authorizeRetry(runId, laneId, attempt.attemptId, "note");

    expect(h.control.promptCalls).toHaveLength(prompts);
    expect(h.control.sendKeysCalls).toHaveLength(keys);
    expect(h.adapter.interruptedPaneIds).toHaveLength(signals);
  });

  test("a historical retry payload still replays and still buys one attempt", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    const before = (await h.ledger.load(runId))!;
    await h.ledger.commit({
      schemaVersion: 1,
      eventId: `${runId}#${before.lastAppliedSequence + 1}`,
      runId,
      sequence: before.lastAppliedSequence + 1,
      at: 9_000,
      controllerEpoch: 0,
      type: "interactive_retry_authorized",
      actor: "human",
      laneId,
      // The shape every retry authorization carried before Revision 15.
      data: { parentAttemptId: attempt.attemptId, note: "legacy" },
    } as RunEvent);

    const run = await h.controller.inspect(runId);
    expect(pendingRetries(run, attempt.attemptId)).toBe(1);
    const child = await h.controller.startAttempt(runId, laneId, {
      ...START,
      parentAttemptId: attempt.attemptId,
    });
    expect(child.started).toBe(true);
  });
});

describe("SP3 an ended attempt cannot publish a new advisory source", () => {
  test("an aborted attempt is refused before reportAgentState", async () => {
    const base = new InMemoryLedger();
    const { ledger, committed } = recording(base);
    const h = harness({ ledger });
    const { runId, laneId } = await opened(h);
    await h.controller.abortSession(runId, laneId);
    const reports = h.control.reportCalls.length;
    committed.length = 0;

    await expect(
      h.controller.publishAdvisoryState(runId, laneId, "working", "late"),
    ).rejects.toThrow(AttemptNotControllableError);

    // Refused before the Herdr call, and nothing was appended.
    expect(h.control.reportCalls).toHaveLength(reports);
    expect(committed.map((event) => event.type)).not.toContain(
      "lane_advisory_state_observed",
    );
  });

  test("a lost attempt is refused too", async () => {
    const h = harness();
    const { runId, laneId, attempt } = await opened(h);
    h.control.killAgent(attempt.agentName!);
    const gone = new FakeHerdrAdapter({ missingPaneIds: [attempt.paneId] });
    const recovered = harness({
      adapter: gone,
      control: () => h.control,
      ledger: h.ledger,
    });
    await recovered.controller.reconcileAttempt(runId, laneId, attempt.attemptId);
    const reports = h.control.reportCalls.length;

    await expect(
      recovered.controller.publishAdvisoryState(runId, laneId, "working", "late"),
    ).rejects.toThrow(AttemptNotControllableError);
    expect(h.control.reportCalls).toHaveLength(reports);
  });

  test("a live attempt still publishes, and takeover does not block it", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");
    expect(h.control.reportCalls).toHaveLength(1);

    // Advisory publication is not a control: a human holding the lane does not
    // stop the runtime describing what it sees.
    await h.controller.takeover(runId, laneId);
    await h.controller.publishAdvisoryState(runId, laneId, "blocked", "held");
    expect(h.control.reportCalls).toHaveLength(2);
  });

  test("explicit release still works after the attempt ended", async () => {
    const h = harness();
    const { runId, laneId } = await opened(h);
    await h.controller.publishAdvisoryState(runId, laneId, "working", "live");
    await h.controller.abortSession(runId, laneId);
    const afterAbort = h.control.releaseCalls.length;
    expect(afterAbort).toBe(1);

    // The explicit cleanup verb keeps working on an ended attempt: it is how an
    // operator drops a source the terminal path could not reach.
    await h.controller.releaseAdvisoryState(runId, laneId);
    expect(h.control.releaseCalls).toHaveLength(afterAbort + 1);
  });
});
