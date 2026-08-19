// The interactive write lane's control plane, driven end to end through the
// fake Herdr seams. No real Herdr, no CLI, no model call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FakeHerdrAgentControl } from "../src/herdr/fake-agent-control.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import { attemptDisposition } from "../src/interactive/attempts.ts";
import {
  AttemptNotControllableError,
  InteractiveLaneController,
  LaneTakenOverError,
  RetryNotAuthorizedError,
  pendingRetries,
} from "../src/interactive/control-plane.ts";
import type {
  FakeAgentControlOptions,
} from "../src/herdr/fake-agent-control.ts";
import type { FakeHerdrAdapterOptions } from "../src/herdr/fake-adapter.ts";

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
  root = await mkdtemp(join(tmpdir(), "flow-interactive-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function harness(
  options: {
    readonly adapter?: FakeHerdrAdapterOptions;
    readonly agent?: FakeAgentControlOptions;
  } = {},
) {
  const clock = createClock(1_000);
  const adapter = new FakeHerdrAdapter({ clock, ...options.adapter });
  const agentControl = new FakeHerdrAgentControl(options.agent);
  const ledger = new InMemoryLedger();
  let seq = 0;
  const controller = new InteractiveLaneController({
    adapter,
    agentControl,
    ledger,
    isolation: permissiveIsolation,
    artifactRoot: root,
    clock: () => clock.now(),
    idgen: () => `id-${++seq}`,
    sessionIdgen: () => `sess-${seq}`,
  });
  return { adapter, agentControl, ledger, controller, clock };
}

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

function attemptInput(dir: string, note = "owner authorized attempt") {
  return {
    brief: "implement the ticket",
        authorization: { note },
  };
}

async function openLaneWithAttempt(
  options: Parameters<typeof harness>[0] = {},
) {
  const h = harness(options);
  const { runId, laneId } = await h.controller.openLane({ ...LANE });
  const started = await h.controller.startAttempt(
    runId,
    laneId,
    attemptInput(root),
  );
  return { ...h, runId, laneId, started };
}

describe("attempt identity and lineage", () => {
  test("an attempt records pane, paths, and its human authorization", async () => {
    const { controller, runId, laneId, started } = await openLaneWithAttempt();
    expect(started.started).toBe(true);
    const [attempt] = await controller.attempts(runId, laneId);
    expect(attempt).toBeDefined();
    expect(attempt!.ordinal).toBe(1);
    expect(attempt!.parentAttemptId).toBeNull();
    expect(attempt!.authorization.actor).toBe("human");
    expect(attempt!.authorization.note).toBe("owner authorized attempt");
    expect(attempt!.paneId).not.toBe("");
    expect(attempt!.checkpointFile).toContain("checkpoint.md");
    expect(attempt!.agentName).not.toBeNull();
  });

  test("the runtime provisions the pane; agent start never creates layout", async () => {
    const { adapter, agentControl, controller, runId, started } =
      await openLaneWithAttempt();
    // The runtime split the pane; the agent surface only started into it, and
    // dispatched no command of its own.
    expect(adapter.dispatched).toHaveLength(0);
    expect(agentControl.startCalls).toHaveLength(1);
    const run = await controller.inspect(runId);
    expect(agentControl.startCalls[0]!.paneId).not.toBe(run.controllerPaneId);
    expect(agentControl.startCalls[0]!.kind).toBe("claude");
    expect(started.startFailure).toBeNull();
  });

  test("native argv is passed after the separator and is overridable", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, {
      ...attemptInput(root),
      nativeArgs: ["--model", "opus"],
    });
    expect(h.agentControl.startCalls[0]!.nativeArgs).toEqual([
      "--model",
      "opus",
    ]);
  });

  test("a failed start is a start failure, not a retry", async () => {
    const h = harness({
      agent: { defaultProgram: { startFailure: "timeout after 30000ms" } },
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    const started = await h.controller.startAttempt(
      runId,
      laneId,
      attemptInput(root),
    );
    expect(started.started).toBe(false);
    expect(started.startFailure).toContain("timeout");
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.endCause).toContain("timeout");
    expect(attempt!.endReason).toBe("start-failed");
    // No second attempt was created on its own.
    expect(await h.controller.attempts(runId, laneId)).toHaveLength(1);
    expect(h.agentControl.startCalls).toHaveLength(1);
  });
});

describe("steer records submission and observation separately", () => {
  test("both facts land, and neither claims the steer was applied", async () => {
    const { controller, runId, laneId } = await openLaneWithAttempt();
    const observation = await controller.steer(runId, laneId, "focus the parser");
    expect(observation.outcome).toBe("state-observed");

    // Two submissions: the brief is the first prompt, then this steer. Each is
    // counted separately from the transition observed after it.
    const [attempt] = await controller.attempts(runId, laneId);
    expect(attempt!.steerSubmissions).toBe(2);
    expect(attempt!.steerObservations).toBe(2);
    // The observation is advisory, and the attempt is not complete.
    expect(attemptDisposition(attempt!)).toBe("running");
  });

  test("a submission is recorded even when the observation never arrives", async () => {
    const h = harness({
      agent: { defaultProgram: { promptOutcomes: ["timeout"] } },
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.steerSubmissions).toBe(1);
    expect(attempt!.steerObservations).toBe(1);
    expect(attempt!.advisory).toHaveLength(0);
  });

  test("a stalled prompt is recorded as stalled and completes nothing", async () => {
    const h = harness({
      agent: {
        defaultProgram: { promptOutcomes: ["state-observed", "stalled"] },
      },
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    const observation = await h.controller.steer(runId, laneId, "keep going");
    expect(observation.outcome).toBe("stalled");
    expect(observation.observed).toBeNull();
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attemptDisposition(attempt!)).toBe("running");
  });

  test("an observed idle or done state never completes the attempt", async () => {
    const h = harness({
      agent: { defaultProgram: { statuses: ["done", "idle"] } },
    });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    await h.controller.steer(runId, laneId, "anything");
    const [attempt] = await h.controller.attempts(runId, laneId);
    expect(attempt!.advisory.map((entry) => entry.status)).toContain("done");
    expect(attemptDisposition(attempt!)).toBe("running");
  });
});

describe("cancel-turn and abort-session are different acts", () => {
  test("cancel-turn sends esc and leaves the session steerable", async () => {
    const { controller, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    await controller.cancelTurn(runId, laneId);
    expect(agentControl.sendKeysCalls).toEqual([
      { target: expect.any(String), keys: ["esc"] },
    ]);
    const [attempt] = await controller.attempts(runId, laneId);
    expect(attempt!.lastCancelTurnAt).not.toBeNull();
    expect(attempt!.endedAt).toBeNull();
    // Still steerable.
    await controller.steer(runId, laneId, "try again");
    expect(agentControl.promptCalls).toHaveLength(2);
  });

  test("abort-session signals the process group and ends the attempt", async () => {
    const { controller, adapter, runId, laneId } = await openLaneWithAttempt();
    await controller.abortSession(runId, laneId);
    expect(adapter.interruptedPaneIds).toHaveLength(1);
    const [attempt] = await controller.attempts(runId, laneId);
    expect(attempt!.endReason).toBe("aborted");
    expect(attempt!.exitCode).toBeNull();
    expect(attemptDisposition(attempt!)).toBe("aborted");
  });

  test("neither is a verdict: an aborted attempt is not complete", async () => {
    const { controller, runId, laneId } = await openLaneWithAttempt();
    await controller.abortSession(runId, laneId);
    const [attempt] = await controller.attempts(runId, laneId);
    expect(attemptDisposition(attempt!)).not.toBe("completed");
  });
});

describe("takeover is enforced at the call site", () => {
  test("no prompt and no send-keys reach a taken-over lane", async () => {
    const { controller, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    const promptsBefore = agentControl.promptCalls.length;
    const keysBefore = agentControl.sendKeysCalls.length;

    await controller.takeover(runId, laneId);
    await expect(controller.steer(runId, laneId, "no")).rejects.toThrow(
      LaneTakenOverError,
    );
    await expect(controller.cancelTurn(runId, laneId)).rejects.toThrow(
      LaneTakenOverError,
    );
    expect(agentControl.promptCalls).toHaveLength(promptsBefore);
    expect(agentControl.sendKeysCalls).toHaveLength(keysBefore);

    await controller.release(runId, laneId);
    await controller.steer(runId, laneId, "resumed");
    expect(agentControl.promptCalls).toHaveLength(promptsBefore + 1);
  });

  test("takeover state is visible on the attempt record itself", async () => {
    const { controller, runId, laneId } = await openLaneWithAttempt();
    await controller.takeover(runId, laneId);
    const [held] = await controller.attempts(runId, laneId);
    expect(held!.controlMode).toBe("human_owned");
    await controller.release(runId, laneId);
    const [released] = await controller.attempts(runId, laneId);
    expect(released!.controlMode).toBe("managed");
  });
});

describe("retry is human-authorized and append-only", () => {
  test("a retry without authorization is refused", async () => {
    const { controller, runId, laneId } = await openLaneWithAttempt();
    const [first] = await controller.attempts(runId, laneId);
    await expect(
      controller.startAttempt(runId, laneId, {
        ...attemptInput(root),
        parentAttemptId: first!.attemptId,
      }),
    ).rejects.toThrow(RetryNotAuthorizedError);
  });

  test("an authorized retry allocates a new attempt, pane, and session", async () => {
    const { controller, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    const [first] = await controller.attempts(runId, laneId);
    const firstSnapshot = structuredClone(first!);

    await controller.authorizeRetry(
      runId,
      laneId,
      first!.attemptId,
      "owner authorized retry",
    );
    const retried = await controller.startAttempt(runId, laneId, {
      ...attemptInput(root, "owner authorized retry"),
      parentAttemptId: first!.attemptId,
    });
    expect(retried.started).toBe(true);

    const attempts = await controller.attempts(runId, laneId);
    expect(attempts).toHaveLength(2);
    const [before, after] = attempts;
    expect(after!.attemptId).not.toBe(before!.attemptId);
    expect(after!.paneId).not.toBe(before!.paneId);
    expect(after!.agentName).not.toBe(before!.agentName);
    expect(after!.parentAttemptId).toBe(before!.attemptId);
    expect(after!.ordinal).toBe(2);
    expect(before!.supersededBy).toBe(after!.attemptId);

    // Every prior fact survives untouched apart from the superseded link.
    expect({ ...before!, supersededBy: firstSnapshot.supersededBy }).toEqual(
      firstSnapshot,
    );
    expect(agentControl.startCalls).toHaveLength(2);
  });

  test("one authorization buys exactly one retry", async () => {
    const { controller, ledger, runId, laneId } = await openLaneWithAttempt();
    const [first] = await controller.attempts(runId, laneId);
    await controller.authorizeRetry(runId, laneId, first!.attemptId, "once");
    expect(pendingRetries((await ledger.load(runId))!, first!.attemptId)).toBe(1);
    await controller.startAttempt(runId, laneId, {
      ...attemptInput(root),
      parentAttemptId: first!.attemptId,
    });
    expect(pendingRetries((await ledger.load(runId))!, first!.attemptId)).toBe(0);
    await expect(
      controller.startAttempt(runId, laneId, {
        ...attemptInput(root),
        parentAttemptId: first!.attemptId,
      }),
    ).rejects.toThrow(RetryNotAuthorizedError);
  });

  test("two attempts are distinguishable from ledger records alone", async () => {
    const { controller, ledger, runId, laneId } = await openLaneWithAttempt();
    const [first] = await controller.attempts(runId, laneId);
    await controller.authorizeRetry(runId, laneId, first!.attemptId, "retry");
    await controller.startAttempt(runId, laneId, {
      ...attemptInput(root),
      parentAttemptId: first!.attemptId,
    });
    // Replay from the ledger with no controller memory and no pane inspected.
    const replayed = (await ledger.load(runId))!;
    const attempts = replayed.interactiveAttemptOrder.map(
      (id) => replayed.interactiveAttempts[id]!,
    );
    expect(new Set(attempts.map((a) => a.attemptId)).size).toBe(2);
    expect(new Set(attempts.map((a) => a.paneId)).size).toBe(2);
    expect(attempts[1]!.parentAttemptId).toBe(attempts[0]!.attemptId);
  });
});

describe("controller recovery", () => {
  test("a live pane hosting the expected kind continues the attempt", async () => {
    const { controller, ledger, adapter, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    // A FRESH controller over the surviving Herdr server and the ledger.
    const fresh = freshController(ledger, adapter, agentControl);
    expect(
      await fresh.controller.reconcileAttempt(runId, laneId, attempt!.attemptId),
    ).toBe("live");
    const [after] = await fresh.controller.attempts(runId, laneId);
    expect(after!.reconciliation?.outcome).toBe("live");
    expect(after!.endedAt).toBeNull();
    expect(attemptDisposition(after!)).toBe("running");
  });

  test("a reoccupied pane fails closed to unknown with no exit code", async () => {
    const { controller, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    agentControl.reoccupy(attempt!.agentName!, "amp");

    expect(
      await controller.reconcileAttempt(runId, laneId, attempt!.attemptId),
    ).toBe("reoccupied");
    const [after] = await controller.attempts(runId, laneId);
    expect(after!.exitCode).toBeNull();
    expect(attemptDisposition(after!)).toBe("unknown");

    // No control call is issued into a pane the runtime no longer owns.
    const prompts = agentControl.promptCalls.length;
    const keys = agentControl.sendKeysCalls.length;
    await expect(
      controller.steer(runId, laneId, "should not reach"),
    ).rejects.toThrow(AttemptNotControllableError);
    await expect(controller.cancelTurn(runId, laneId)).rejects.toThrow(
      AttemptNotControllableError,
    );
    expect(agentControl.promptCalls).toHaveLength(prompts);
    expect(agentControl.sendKeysCalls).toHaveLength(keys);
  });

  test("a missing pane reconciles to unknown and invents no exit code", async () => {
    const h = harness();
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    const [attempt] = await h.controller.attempts(runId, laneId);

    h.agentControl.killAgent(attempt!.agentName!);
    const gone = new FakeHerdrAdapter({
      missingPaneIds: [attempt!.paneId],
    });
    const controller = new InteractiveLaneController({
      adapter: gone,
      agentControl: h.agentControl,
      ledger: h.ledger,
      isolation: permissiveIsolation,
      artifactRoot: root,
      clock: () => 9_000,
      idgen: () => "id-recovered",
    });
    expect(
      await controller.reconcileAttempt(runId, laneId, attempt!.attemptId),
    ).toBe("missing");
    const [after] = await controller.attempts(runId, laneId);
    expect(after!.reconciliation?.outcome).toBe("missing");
    expect(after!.exitCode).toBeNull();
    expect(after!.endReason).toBe("lost");
    expect(attemptDisposition(after!)).toBe("unknown");
  });

  test("takeover and pending retry authorization survive controller loss", async () => {
    const { controller, ledger, adapter, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    await controller.takeover(runId, laneId);
    await controller.authorizeRetry(runId, laneId, attempt!.attemptId, "later");

    const fresh = freshController(ledger, adapter, agentControl);
    const [restored] = await fresh.controller.attempts(runId, laneId);
    expect(restored!.controlMode).toBe("human_owned");
    expect(pendingRetries((await ledger.load(runId))!, attempt!.attemptId)).toBe(
      1,
    );
    // The guard is restored BEFORE any control call is permitted.
    await expect(
      fresh.controller.steer(runId, laneId, "no"),
    ).rejects.toThrow(LaneTakenOverError);
  });
});

describe("runner evidence is independent of the agent session", () => {
  test("it runs in its own pane and records the real exit code", async () => {
    const { controller, adapter, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    const logFile = join(root, "runner.log");

    const evidence = await controller.recordRunnerEvidence(
      runId,
      laneId,
      attempt!.attemptId,
      { argv: ["bun", "test"], logFile, cwd: root },
    );
    expect(evidence.exitCode).toBe(0);

    const [after] = await controller.attempts(runId, laneId);
    expect(after!.runnerEvidence).toHaveLength(1);
    const record = after!.runnerEvidence[0]!;
    expect(record.paneId).not.toBe(attempt!.paneId);
    expect(record.command).toContain("bun");
    expect(record.logFile).toBe(logFile);
    // Nothing went through the agent surface.
    expect(agentControl.promptCalls.map((call) => call.text)).not.toContain(
      "bun test",
    );
    expect(adapter.dispatched).toHaveLength(1);
  });

  test("a runner that leaves no sentinel yields a null exit code", async () => {
    const h = harness({ adapter: { runnerOmitsSentinel: true } });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    const [attempt] = await h.controller.attempts(runId, laneId);
    const evidence = await h.controller.recordRunnerEvidence(
      runId,
      laneId,
      attempt!.attemptId,
      { argv: ["false"], logFile: join(root, "no-sentinel.log"), cwd: root },
    );
    expect(evidence.exitCode).toBeNull();
    const [after] = await h.controller.attempts(runId, laneId);
    expect(attemptDisposition(after!)).toBe("running");
  });

  test("a non-zero runner exit is recorded as itself", async () => {
    const h = harness({ adapter: { runnerExitCode: 2 } });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    const [attempt] = await h.controller.attempts(runId, laneId);
    const evidence = await h.controller.recordRunnerEvidence(
      runId,
      laneId,
      attempt!.attemptId,
      { argv: ["bun", "test"], logFile: join(root, "fail.log"), cwd: root },
    );
    expect(evidence.exitCode).toBe(2);
  });
});

describe("checkpoints are agent-authored at declared paths", () => {
  test("an agent checkpoint plus runner evidence completes the attempt", async () => {
    const { controller, runId, laneId } = await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    await writeCheckpoint(attempt!.checkpointFile, "complete");

    expect(
      await controller.collectAgentCheckpoint(runId, laneId, attempt!.attemptId),
    ).toBe("agent");
    await controller.recordRunnerEvidence(runId, laneId, attempt!.attemptId, {
      argv: ["bun", "test"],
      logFile: join(root, "ok.log"),
      cwd: root,
    });
    const [after] = await controller.attempts(runId, laneId);
    expect(after!.agentCheckpoint?.origin).toBe("agent");
    expect(attemptDisposition(after!)).toBe("completed");
  });

  test("no checkpoint yields a runtime-authored unknown, not an agent claim", async () => {
    const { controller, ledger, runId, laneId } = await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    expect(
      await controller.collectAgentCheckpoint(runId, laneId, attempt!.attemptId),
    ).toBe("unknown");

    const run = (await ledger.load(runId))!;
    const after = run.interactiveAttempts[attempt!.attemptId]!;
    expect(after.agentCheckpoint?.origin).toBe("runtime");
    expect(after.agentCheckpoint?.semanticState).toBe("unknown");
    expect(attemptDisposition(after)).toBe("running");
    expect(run.lanes[laneId]!.checkpointOrigin).toBe("runtime");
  });

  test("a runtime-derived record can never complete an attempt", async () => {
    const { controller, runId, laneId } = await openLaneWithAttempt();
    const [attempt] = await controller.attempts(runId, laneId);
    await controller.collectAgentCheckpoint(runId, laneId, attempt!.attemptId);
    await controller.recordRunnerEvidence(runId, laneId, attempt!.attemptId, {
      argv: ["bun", "test"],
      logFile: join(root, "derived.log"),
      cwd: root,
    });
    const [after] = await controller.attempts(runId, laneId);
    expect(after!.agentCheckpoint?.origin).toBe("runtime");
    expect(attemptDisposition(after!)).not.toBe("completed");
  });
});

describe("advisory publication is optional and never evidence", () => {
  test("published state is released and absent from every evidence path", async () => {
    const { controller, agentControl, runId, laneId } =
      await openLaneWithAttempt();
    await controller.publishAdvisoryState(runId, laneId, "working", "live");
    await controller.releaseAdvisoryState(runId, laneId);

    expect(agentControl.reportCalls).toHaveLength(1);
    expect(agentControl.reportCalls[0]!.state).toBe("working");
    expect(agentControl.releaseCalls).toHaveLength(1);

    const [attempt] = await controller.attempts(runId, laneId);
    const published = attempt!.advisory.filter(
      (entry) => entry.source === "runtime-published",
    );
    expect(published).toHaveLength(1);
    // The whole advisory channel is invisible to the outcome.
    expect(attemptDisposition(attempt!)).toBe("running");
  });

  test("a blocked observation is a wait edge, never an outcome", async () => {
    const h = harness({ agent: { defaultProgram: { waitResult: "blocked" } } });
    const { runId, laneId } = await h.controller.openLane({ ...LANE });
    await h.controller.startAttempt(runId, laneId, attemptInput(root));
    expect(await h.controller.waitForBlocked(runId, laneId, 1_000)).toBe(true);

    const [attempt] = await h.controller.attempts(runId, laneId);
    const blocked = attempt!.advisory.filter(
      (entry) => entry.status === "blocked",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.source).toBe("herdr-detection");
    expect(attemptDisposition(attempt!)).toBe("running");
  });
});

// -------------------------------------------------------------------- helpers

/**
 * A new controller process over the SAME Herdr server and the same ledger.
 * The fakes model Herdr, which hosts the session and survives controller exit;
 * only the controller object is new, so it starts with no memory at all.
 */
function freshController(
  ledger: InMemoryLedger,
  adapter: FakeHerdrAdapter,
  agentControl: FakeHerdrAgentControl,
): { readonly controller: InteractiveLaneController } {
  return {
    controller: new InteractiveLaneController({
      adapter,
      agentControl,
      ledger,
      isolation: permissiveIsolation,
      artifactRoot: root,
      clock: () => 5_000,
      idgen: () => "id-fresh",
    }),
  };
}

async function writeCheckpoint(path: string, status: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `STATUS: ${status}\nPHASE: implementation\nCOMPLETED:\n- work\nNEXT:\n- none\nBLOCKERS:\n- none\nARTIFACTS:\n- diff\nVERIFICATION_CLAIMS:\n- bun test\nGAPS:\n- none\n`,
    "utf8",
  );
}

