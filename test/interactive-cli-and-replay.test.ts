// Two boundaries that the control plane's own tests cannot reach: the CLI's
// argv parsing, and a durable ledger round-trip that replays every interactive
// event from disk into the same projection.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseInteractiveArgs,
  runFlowCli,
} from "../src/cli/flow.ts";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FakeHerdrAgentControl } from "../src/herdr/fake-agent-control.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { Ledger } from "../src/runtime/ledger.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
import { attemptDisposition } from "../src/interactive/attempts.ts";
import { InteractiveLaneController } from "../src/interactive/control-plane.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import type { AgentInfoView } from "../src/herdr/agent-json.ts";
import { reduce } from "../src/runtime/reducer.ts";

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


const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-interactive-"));
  roots.push(root);
  return root;
}

class Sink {
  text = "";
  write(chunk: string): void {
    this.text += chunk;
  }
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

/**
 * The Herdr seams model the Herdr SERVER, which survives a controller exiting.
 * A test that spawns a second controller therefore shares them and rebuilds
 * only the controller — otherwise it would be modelling Herdr restarting too.
 */
interface Seams {
  readonly adapter: FakeHerdrAdapter;
  readonly agentControl: FakeHerdrAgentControl;
  next(): number;
}

function seams(): Seams {
  const clock = createClock(1_000);
  let seq = 0;
  return {
    adapter: new FakeHerdrAdapter({ clock }),
    agentControl: new FakeHerdrAgentControl(),
    next: () => ++seq,
  };
}

function controllerOver(ledger: FsLedger, shared: Seams, root: string) {
  return new InteractiveLaneController({
    adapter: shared.adapter,
    agentControl: shared.agentControl,
    ledger,
    isolation: permissiveIsolation,
    artifactRoot: root,
    clock: () => 2_000,
    idgen: () => `id-${shared.next()}`,
    sessionIdgen: () => "sess-1",
  });
}

async function seedLane(root: string) {
  const ledger = new FsLedger(root);
  const shared = seams();
  const controller = controllerOver(ledger, shared, root);
  const { runId, laneId } = await controller.openLane({ ...LANE });
  await controller.startAttempt(runId, laneId, {
    authorization: { note: "owner authorized" },
  });
  return { ledger, controller, shared, runId, laneId };
}

describe("interactive CLI argv", () => {
  test("parses each control and rejects malformed invocations", () => {
    expect(parseInteractiveArgs(["steer", "r1", "l1", "do the thing"])).toEqual({
      command: "steer",
      runId: "r1",
      laneId: "l1",
      attemptId: null,
      text: "do the thing",
      flags: {},
    });
    expect(parseInteractiveArgs(["cancel-turn", "r1", "l1"])).toEqual({
      command: "cancel-turn",
      runId: "r1",
      laneId: "l1",
      attemptId: null,
      text: null,
      flags: {},
    });
    expect(parseInteractiveArgs(["abort-session", "r1", "l1"])).toEqual({
      command: "abort-session",
      runId: "r1",
      laneId: "l1",
      attemptId: null,
      text: null,
      flags: {},
    });
    expect(parseInteractiveArgs(["reconcile", "r1", "l1", "a1"])).toEqual({
      command: "reconcile",
      runId: "r1",
      laneId: "l1",
      attemptId: "a1",
      text: null,
      flags: {},
    });
    expect(
      parseInteractiveArgs([
        "authorize-retry",
        "r1",
        "l1",
        "a1",
        "--note",
        "owner said so",
      ]),
    ).toEqual({
      command: "authorize-retry",
      runId: "r1",
      laneId: "l1",
      attemptId: "a1",
      text: "owner said so",
      flags: {},
    });

    // A retry with no recorded note is not an authorization.
    expect(parseInteractiveArgs(["authorize-retry", "r1", "l1", "a1"])).toBeNull();
    expect(
      parseInteractiveArgs(["authorize-retry", "r1", "l1", "a1", "--note"]),
    ).toBeNull();
    expect(parseInteractiveArgs(["steer", "r1", "l1"])).toBeNull();
    expect(parseInteractiveArgs(["steer", "r1", "l1", "a", "b"])).toBeNull();
    expect(parseInteractiveArgs(["cancel-turn", "r1", "l1", "extra"])).toBeNull();
    expect(parseInteractiveArgs(["reconcile", "r1", "l1"])).toBeNull();
    expect(parseInteractiveArgs(["steer", "--r1", "l1", "x"])).toBeNull();
    expect(parseInteractiveArgs(["nope", "r1", "l1"])).toBeNull();
  });

  test("a malformed invocation exits 2 and prints the interactive usage", async () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await runFlowCli(["steer", "r1"], stdout, stderr, {
      environment: { FLOW_LEDGER_ROOT: await tempRoot() },
    });
    expect(code).toBe(2);
    expect(stderr.text).toContain("flow steer <runId> <laneId> <text>");
    expect(stdout.text).toBe("");
  });

  test("steer drives the controller and renders the attempt", async () => {
    const root = await tempRoot();
    const { ledger, shared, runId, laneId } = await seedLane(root);
    const stdout = new Sink();
    const stderr = new Sink();

    const code = await runFlowCli(
      ["steer", runId, laneId, "tighten the parser"],
      stdout,
      stderr,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, shared, root),
      },
    );
    expect(stderr.text).toBe("");
    expect(code).toBe(0);
    expect(stdout.text).toContain("disposition=running");
    expect(stdout.text).toContain("steer submitted=1 observed=1");
    // The advisory channel is rendered, and rendered as what it is.
    expect(stdout.text).toContain("advisory(not evidence)");
  });

  test("authorize-retry records the authorization and shows it pending", async () => {
    const root = await tempRoot();
    const { ledger, controller, shared, runId, laneId } = await seedLane(root);
    const [attempt] = await controller.attempts(runId, laneId);
    const stdout = new Sink();
    const stderr = new Sink();

    const code = await runFlowCli(
      [
        "authorize-retry",
        runId,
        laneId,
        attempt!.attemptId,
        "--note",
        "owner authorized retry",
      ],
      stdout,
      stderr,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, shared, root),
      },
    );
    expect(stderr.text).toBe("");
    expect(code).toBe(0);
    expect(stdout.text).toContain("pendingRetries=1");
  });

  test("an unknown run exits 1 with the error, not a stack", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    const shared = seams();
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await runFlowCli(
      ["cancel-turn", "run-missing", "impl-1"],
      stdout,
      stderr,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, shared, root),
      },
    );
    expect(code).toBe(1);
    expect(stderr.text).toContain("flow: ");
    expect(stderr.text).toContain("run-missing");
  });
});

describe("ledger replay", () => {
  test("every interactive fact survives a durable round-trip", async () => {
    const root = await tempRoot();
    const { controller, runId, laneId } = await seedLane(root);
    const [first] = await controller.attempts(runId, laneId);

    await controller.steer(runId, laneId, "keep going");
    await controller.cancelTurn(runId, laneId);
    await controller.publishAdvisoryState(runId, laneId, "working", "live");
    await controller.recordRunnerEvidence(runId, laneId, first!.attemptId, {
      argv: ["bun", "test"],
      logFile: join(root, "runner.log"),
      cwd: root,
    });
    await controller.takeover(runId, laneId);
    await controller.release(runId, laneId);
    await controller.authorizeRetry(
      runId,
      laneId,
      first!.attemptId,
      "owner authorized retry",
    );
    await controller.startAttempt(runId, laneId, {
      authorization: { note: "owner authorized retry" },
      parentAttemptId: first!.attemptId,
    });
    await controller.abortSession(runId, laneId);

    // A brand-new reader over the same directory: replay only, no memory.
    const replayed = await new FsLedger(root).load(runId);
    expect(replayed).not.toBeNull();
    const attempts = replayed!.interactiveAttemptOrder.map(
      (id) => replayed!.interactiveAttempts[id]!,
    );
    expect(attempts).toHaveLength(2);

    const [before, after] = attempts;
    expect(before!.supersededBy).toBe(after!.attemptId);
    expect(before!.steerSubmissions).toBe(1);
    expect(before!.lastCancelTurnAt).not.toBeNull();
    expect(before!.runnerEvidence).toHaveLength(1);
    expect(before!.runnerEvidence[0]!.exitCode).toBe(0);
    expect(before!.advisory.some((e) => e.source === "runtime-published")).toBe(
      true,
    );
    expect(attemptDisposition(before!)).toBe("superseded");

    expect(after!.parentAttemptId).toBe(before!.attemptId);
    expect(after!.ordinal).toBe(2);
    expect(after!.endReason).toBe("aborted");
    expect(after!.exitCode).toBeNull();
    expect(attemptDisposition(after!)).toBe("aborted");

    expect(replayed!.retryAuthorizations).toEqual([before!.attemptId]);
    expect(replayed!.lanes[laneId]!.kind).toBe("interactive");
    expect(replayed!.lanes[laneId]!.controlMode).toBe("managed");
  });

  test("a ledger written when start delivered the brief replays unchanged", async () => {
    // Hand-seeded in the pre-split shape: `interactive_attempt_started` carries
    // a briefFile, and the brief's steer was committed by the RUNTIME inside
    // the start. Those events are durable facts and must still project the
    // same attempt after the split.
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    const runId = "legacy-run";
    const laneId = "impl-1";
    const attemptId = "legacy-attempt";
    const artifactRoot = join(root, "interactive", runId, laneId);
    const events: RunEvent[] = [
      {
        schemaVersion: 1,
        eventId: `${runId}#1`,
        runId,
        sequence: 1,
        type: "run_started",
        at: 1_000,
        actor: "runtime",
        controllerEpoch: 0,
        data: {
          workflow: "impl",
          workspace: "ws",
          cwd: "/tmp/repo-wt",
          splitDirection: "right",
          tabId: "wf:t1",
          controllerPaneId: "wf:p1",
          fixedPoint: null,
          issue: null,
        },
      },
      {
        schemaVersion: 1,
        eventId: `${runId}#2`,
        runId,
        laneId,
        sequence: 2,
        type: "lane_registered",
        at: 1_001,
        actor: "runtime",
        controllerEpoch: 0,
        data: {
          kind: "interactive",
          laneId,
          paneId: "wf:p1",
          agentKind: "claude",
          model: "sonnet",
          effort: "high",
          worktreePath: "/tmp/repo-wt",
          repoRoot: "/tmp/repo",
          artifactRoot,
        },
      },
      {
        schemaVersion: 1,
        eventId: `${runId}#3`,
        runId,
        laneId,
        sequence: 3,
        type: "interactive_attempt_started",
        at: 1_002,
        actor: "runtime",
        controllerEpoch: 0,
        data: {
          attemptId,
          ordinal: 1,
          parentAttemptId: null,
          agentKind: "claude",
          model: "sonnet",
          effort: "high",
          paneId: "wf:p2",
          expectedAgentName: "f-impl-1-0123456789abcdef",
          worktreePath: "/tmp/repo-wt",
          briefFile: join(artifactRoot, "attempts", attemptId, "brief.md"),
          checkpointFile: join(artifactRoot, "attempts", attemptId, "checkpoint.md"),
          resultPointer: join(artifactRoot, "attempts", attemptId, "result.md"),
          authorization: { actor: "human", note: "owner authorized" },
        },
      },
      {
        schemaVersion: 1,
        eventId: `${runId}#4`,
        runId,
        laneId,
        sequence: 4,
        type: "interactive_attempt_bound",
        at: 1_003,
        actor: "runtime",
        controllerEpoch: 0,
        data: {
          attemptId,
          agentName: "f-impl-1-0123456789abcdef",
          session: { kind: "measured", id: "sess-legacy", source: "herdr" },
          argv: ["claude", "--model", "sonnet"],
          readinessMs: 42,
        },
      },
      {
        schemaVersion: 1,
        eventId: `${runId}#5`,
        runId,
        laneId,
        sequence: 5,
        type: "lane_steer_submitted",
        at: 1_004,
        actor: "human",
        controllerEpoch: 0,
        data: {
          attemptId,
          text: "implement the ticket",
          paneId: "wf:p2",
          target: "f-impl-1-0123456789abcdef",
        },
      },
      {
        schemaVersion: 1,
        eventId: `${runId}#6`,
        runId,
        laneId,
        sequence: 6,
        type: "lane_steer_observed",
        at: 1_005,
        actor: "runtime",
        controllerEpoch: 0,
        data: {
          attemptId,
          outcome: "state-observed",
          observedStatus: "working",
          source: "herdr-detection",
        },
      },
    ] as RunEvent[];
    for (const event of events) await ledger.commit(event);

    const replayed = (await new FsLedger(root).load(runId))!;
    const attempt = replayed.interactiveAttempts[attemptId]!;

    expect(replayed.interactiveAttemptOrder).toEqual([attemptId]);
    expect(attempt.agentName).toBe("f-impl-1-0123456789abcdef");
    expect(attempt.session.kind).toBe("measured");
    expect(attempt.briefFile).toBe(
      join(artifactRoot, "attempts", attemptId, "brief.md"),
    );
    // The brief that a start used to send is still one submission with one
    // observation, and the attempt still projects as running.
    expect(attempt.steerSubmissions).toBe(1);
    expect(attempt.steerObservations).toBe(1);
    expect(attempt.endReason).toBeNull();
    expect(attemptDisposition(attempt)).toBe("running");
  });

  test("a replayed run needs no pane to tell two attempts apart", async () => {
    const root = await tempRoot();
    const { controller, runId, laneId } = await seedLane(root);
    const [first] = await controller.attempts(runId, laneId);
    await controller.authorizeRetry(runId, laneId, first!.attemptId, "retry");
    await controller.startAttempt(runId, laneId, {
      authorization: { note: "retry" },
      parentAttemptId: first!.attemptId,
    });

    const replayed = (await new FsLedger(root).load(runId))!;
    const attempts = replayed.interactiveAttemptOrder.map(
      (id) => replayed.interactiveAttempts[id]!,
    );
    const distinguishing = attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      ordinal: attempt.ordinal,
      paneId: attempt.paneId,
      agentName: attempt.agentName,
      briefFile: attempt.briefFile,
      checkpointFile: attempt.checkpointFile,
    }));
    expect(new Set(distinguishing.map((d) => JSON.stringify(d))).size).toBe(2);
    for (const key of Object.keys(distinguishing[0]!) as (keyof (typeof distinguishing)[0])[]) {
      expect(distinguishing[0]![key]).not.toBe(distinguishing[1]![key]);
    }
  });
});

describe("the production entry point is reachable", () => {
  test("open-lane then start-attempt drives the real CLI path", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    const shared = seams();


    const opened = new Sink();
    const openedErr = new Sink();
    const openCode = await runFlowCli(
      [
        "open-lane",
        "--workflow", "impl",
        "--workspace", "ws",
        "--cwd", root,
        "--lane", "impl-1",
        "--kind", "claude",
        "--model", "sonnet",
        "--effort", "high",
        "--repo", root,
        "--worktree", root,
      ],
      opened,
      openedErr,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, shared, root),
      },
    );
    expect(openedErr.text).toBe("");
    expect(openCode).toBe(0);
    const runId = opened.text.match(/^runId=(\S+)/m)?.[1];
    expect(runId).toBeDefined();

    const started = new Sink();
    const startedErr = new Sink();
    const startCode = await runFlowCli(
      [
        "start-attempt",
        runId!,
        "impl-1",
        "--note", "owner authorized the first attempt",
      ],
      started,
      startedErr,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, shared, root),
      },
    );
    expect(startedErr.text).toBe("");
    expect(startCode).toBe(0);
    expect(started.text).toContain("started=true");
    expect(started.text).toContain("disposition=running");
    // Launched and bound is not instructed: the CLI says so, and names the
    // command that actually delivers the brief.
    expect(started.text).toContain("has been told nothing");
    expect(started.text).toContain("flow steer");
    expect(started.text).toContain("steer submitted=0 observed=0");

    // The lane and its attempt are durable, with declared paths under the
    // ledger root rather than anywhere the caller chose.
    const run = (await new FsLedger(root).load(runId!))!;
    const attempt = run.interactiveAttempts[run.interactiveAttemptOrder[0]!]!;
    expect(run.lanes["impl-1"]!.kind).toBe("interactive");
    expect(run.lanes["impl-1"]!.logFile).toBeNull();
    expect(run.lanes["impl-1"]!.sentinelToken).toBeNull();
    expect(attempt.checkpointFile.startsWith(root)).toBe(true);
    expect(attempt.authorization.note).toContain("owner authorized");
  });

  test("open-lane requires the repository the worktree must belong to", () => {
    // Without --repo there is nothing to verify the worktree against.
    expect(
      parseInteractiveArgs([
        "open-lane",
        "--workflow", "impl", "--workspace", "ws", "--cwd", "/tmp",
        "--lane", "impl-1", "--kind", "claude", "--model", "m",
        "--effort", "high", "--worktree", "/tmp/wt",
      ]),
    ).toBeNull();
  });

  test("open-lane rejects an unsupported agent kind", async () => {
    expect(
      parseInteractiveArgs([
        "open-lane",
        "--workflow", "impl",
        "--workspace", "ws",
        "--cwd", "/tmp",
        "--lane", "impl-1",
        "--kind", "pi",
        "--model", "m",
        "--effort", "high",
        "--repo", "/tmp",
        "--worktree", "/tmp",
      ]),
    ).toBeNull();
  });

  test("start-attempt takes an authorization note and no brief", () => {
    // The note is the human act that authorizes the attempt, and is required.
    expect(
      parseInteractiveArgs(["start-attempt", "r1", "l1"]),
    ).toBeNull();
    expect(
      parseInteractiveArgs(["start-attempt", "r1", "l1", "--note", "ok"]),
    ).not.toBeNull();
    // A brief is no longer a start input; offering one is a usage error, not
    // a silently ignored flag.
    expect(
      parseInteractiveArgs([
        "start-attempt", "r1", "l1", "--note", "ok", "--brief-file", "/b",
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Revision 15 — R2-S2. `flow takeover` / `flow release` are the only shipped
// operator verbs for ownership, and on an interactive lane they used to commit
// `data: {}`. These drive the real CLI, not the controller.
// ---------------------------------------------------------------------------

/** Reads the raw events a run's durable ledger holds, in order. */
async function eventsOf(root: string, runId: string): Promise<RunEvent[]> {
  const text = await Bun.file(join(root, "runs", runId, "events.jsonl")).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

function ownershipEvents(events: readonly RunEvent[]) {
  return events.filter(
    (event) => event.type === "lane_takeover" || event.type === "lane_release",
  );
}

describe("R2-S2 the operator CLI records ownership in full", () => {
  test("takeover and release each commit a complete payload", async () => {
    const root = await tempRoot();
    const { ledger, controller, shared, runId, laneId } = await seedLane(root);
    const [attempt] = await controller.attempts(runId, laneId);
    const options = {
      environment: { FLOW_LEDGER_ROOT: root },
      interactiveFactory: () => controllerOver(ledger, shared, root),
    };

    const out1 = new Sink();
    const err1 = new Sink();
    expect(
      await runFlowCli(["takeover", runId, laneId], out1, err1, options),
    ).toBe(0);
    expect(err1.text).toBe("");

    const out2 = new Sink();
    const err2 = new Sink();
    expect(
      await runFlowCli(["release", runId, laneId], out2, err2, options),
    ).toBe(0);
    expect(err2.text).toBe("");

    const owned = ownershipEvents(await eventsOf(root, runId));
    // Exactly one event per command, no duplicates.
    expect(owned).toHaveLength(2);
    expect(owned[0]!.type).toBe("lane_takeover");
    expect(owned[1]!.type).toBe("lane_release");
    for (const event of owned) {
      // Actor stays on the envelope, where every control intent carries it.
      expect(event.actor).toBe("human");
      expect(event.laneId).toBe(laneId);
      const data = event.data as Record<string, unknown>;
      expect(data.attemptId).toBe(attempt!.attemptId);
      expect(data.paneId).toBe(attempt!.paneId);
      expect(data.target).toBe(attempt!.agentName!);
      expect(data.method).toBe("ledger-control-mode");
      // Observed from the live agent surface, not guessed.
      expect(data.observedStatus).not.toBeUndefined();
      expect(data.observedStatus).not.toBeNull();
    }
  });

  test("an unreadable agent records null and the command still succeeds", async () => {
    const root = await tempRoot();
    const { ledger, controller, shared, runId, laneId } = await seedLane(root);
    await controller.attempts(runId, laneId);
    class Unreadable extends FakeHerdrAgentControl {
      override async getAgent(): Promise<AgentInfoView | null> {
        throw new Error("herdr agent get failed (exit 1): io_error");
      }
    }
    const blind: Seams = {
      adapter: shared.adapter,
      agentControl: new Unreadable(),
      next: shared.next,
    };
    const out = new Sink();
    const err = new Sink();
    expect(
      await runFlowCli(["takeover", runId, laneId], out, err, {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, blind, root),
      }),
    ).toBe(0);
    expect(err.text).toBe("");

    const [owned] = ownershipEvents(await eventsOf(root, runId));
    const data = owned!.data as Record<string, unknown>;
    expect(data.observedStatus).toBeNull();
    // The switch happened anyway: ownership is the human's call, not Herdr's.
    const replayed = (await ledger.load(runId))!;
    expect(replayed.lanes[laneId]!.controlMode).toBe("human_owned");
  });

  test("ownership sends no prompt, no key, and no signal", async () => {
    const root = await tempRoot();
    const { ledger, shared, runId, laneId } = await seedLane(root);
    const options = {
      environment: { FLOW_LEDGER_ROOT: root },
      interactiveFactory: () => controllerOver(ledger, shared, root),
    };
    const prompts = shared.agentControl.promptCalls.length;
    const keys = shared.agentControl.sendKeysCalls.length;
    const signals = shared.adapter.interruptedPaneIds.length;

    await runFlowCli(["takeover", runId, laneId], new Sink(), new Sink(), options);
    await runFlowCli(["release", runId, laneId], new Sink(), new Sink(), options);

    expect(shared.agentControl.promptCalls).toHaveLength(prompts);
    expect(shared.agentControl.sendKeysCalls).toHaveLength(keys);
    expect(shared.adapter.interruptedPaneIds).toHaveLength(signals);
  });

  test("a historical empty payload still replays through the same projection", async () => {
    const root = await tempRoot();
    const { ledger, runId, laneId } = await seedLane(root);
    const before = (await ledger.load(runId))!;
    // The shape every takeover carried before the payload existed.
    const legacy = {
      schemaVersion: 1,
      eventId: `${runId}#${before.lastAppliedSequence + 1}`,
      runId,
      sequence: before.lastAppliedSequence + 1,
      at: 9_000,
      controllerEpoch: 0,
      type: "lane_takeover",
      actor: "human",
      laneId,
      data: {},
    } as RunEvent;
    expect(reduce(before, legacy).lanes[laneId]!.controlMode).toBe("human_owned");
  });
});

// ---------------------------------------------------------------------------
// Revision 16 — R3-1. The CLI no longer decides what kind of lane it is
// looking at: it assembles the ownership capability and hands it over. The
// runtime holds the lane, so the run is read once for the decision.
// ---------------------------------------------------------------------------

describe("R3-1 the operator CLI reads the run once and stays lease-free", () => {
  test("takeover derives its payload from the run the runtime loaded", async () => {
    const root = await tempRoot();
    const { ledger, controller, shared, runId, laneId } = await seedLane(root);
    const [attempt] = await controller.attempts(runId, laneId);
    let loads = 0;
    let leases = 0;
    const err = new Sink();

    const exitCode = await runFlowCli(
      ["takeover", runId, laneId],
      new Sink(),
      err,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        interactiveFactory: () => controllerOver(ledger, shared, root),
        runtimeFactory: (cliLedger) => {
          // Instrumenting the INSTANCE the CLI itself holds: every later read
          // — the runtime's, the provider's, the render's — goes through it.
          const load = cliLedger.load.bind(cliLedger);
          const acquireLease = cliLedger.acquireLease.bind(cliLedger);
          const instrumented = cliLedger as {
            load: Ledger["load"];
            acquireLease: Ledger["acquireLease"];
          };
          instrumented.load = (id) => {
            loads += 1;
            return load(id);
          };
          instrumented.acquireLease = (id, owner) => {
            leases += 1;
            return acquireLease(id, owner);
          };
          return new WorkflowRuntime({
            adapter: shared.adapter,
            ledger: cliLedger,
            clock: () => 3_000,
            idgen: () => "unused-run-id",
            readResultFile: shared.adapter.readResultFile,
            sleep: async () => {},
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(err.text).toBe("");
    // One read decides the lane kind and feeds the payload; one renders the
    // result. The pre-Revision-16 chain read the same run twice before that.
    expect(loads).toBe(2);
    // Ownership never takes the controller lease, whatever layer decides it.
    expect(leases).toBe(0);
    const [owned] = ownershipEvents(await eventsOf(root, runId));
    expect(owned!.data).toMatchObject({
      attemptId: attempt!.attemptId,
      paneId: attempt!.paneId,
      target: attempt!.agentName!,
      method: "ledger-control-mode",
    });
  });
});
