// Two boundaries that the control plane's own tests cannot reach: the CLI's
// argv parsing, and a durable ledger round-trip that replays every interactive
// event from disk into the same projection.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseInteractiveArgs,
  runFlowCli,
} from "../src/cli/flow.ts";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FakeHerdrAgentControl } from "../src/herdr/fake-agent-control.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import { attemptDisposition } from "../src/interactive/attempts.ts";
import { InteractiveLaneController } from "../src/interactive/control-plane.ts";

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
    brief: "implement it",
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
    expect(stdout.text).toContain("steer submitted=2 observed=2");
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
      brief: "second go",
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
    expect(before!.steerSubmissions).toBe(2);
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

  test("a replayed run needs no pane to tell two attempts apart", async () => {
    const root = await tempRoot();
    const { controller, runId, laneId } = await seedLane(root);
    const [first] = await controller.attempts(runId, laneId);
    await controller.authorizeRetry(runId, laneId, first!.attemptId, "retry");
    await controller.startAttempt(runId, laneId, {
      brief: "again",
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
    const briefFile = join(root, "brief.md");
    await writeFile(briefFile, "implement the ticket\n", "utf8");

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
        "--brief-file", briefFile,
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
        "--worktree", "/tmp",
      ]),
    ).toBeNull();
  });

  test("start-attempt requires both a brief file and an authorization note", () => {
    expect(
      parseInteractiveArgs(["start-attempt", "r1", "l1", "--brief-file", "/b"]),
    ).toBeNull();
    expect(
      parseInteractiveArgs(["start-attempt", "r1", "l1", "--note", "ok"]),
    ).toBeNull();
  });
});
