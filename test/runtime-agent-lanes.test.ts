// Agent-lane behavior through the WorkflowRuntime public interface: fake
// Herdr adapter, in-memory ledger, fake review-isolation port, injected
// clock/idgen/sessionIdgen. Assertions read ledger events and projections —
// the approved seam — never runtime internals.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClock,
  FakeHerdrAdapter,
  type FakeLaneProgram,
} from "../src/herdr/fake-adapter.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import type { RunEvent, FixedPoint } from "../src/runtime/events.ts";
import type {
  AgentLaneSpec,
  LaneSpec,
  RuntimeDeps,
} from "../src/runtime/types.ts";
import { REPORT_CONTRACT_BLOCK } from "../src/review/contract.ts";
import type { BundleSourceFile } from "../src/review/bundle.ts";
import {
  FakeReviewIsolation,
  type FakeReviewIsolationOptions,
} from "../src/review/fake-isolation.ts";

const VALID_REPORT = "VERDICT: approve\nCONFIDENCE: high\nFINDINGS: none\n";

function claudeRaw(report: string, sessionId: string): string {
  return `${[
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: report,
      session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ].join("\n")}\n`;
}

class RecordingLedger extends InMemoryLedger {
  readonly events: RunEvent[] = [];
  protected override beforeCommit(event: RunEvent): void {
    this.events.push(event);
  }
}

const FIXED_POINT: FixedPoint = {
  repoRoot: "/repo",
  baseCommit: "aaaa000000000000000000000000000000000000",
  headCommit: "bbbb111111111111111111111111111111111111",
  diffHash: "sha256:feedface",
  dirtyStatePolicy: "record-hash",
  capturedAt: 0,
};

const BUNDLE: BundleSourceFile[] = [
  { path: "bundle/issue.md", role: "issue", content: "Do the thing.\n" },
  { path: "bundle/spec.md", role: "spec", content: "Spec body.\n" },
  { path: "bundle/standards.md", role: "standards", content: "Rules.\n" },
];

function agentLane(
  laneId: string,
  agentKind: AgentLaneSpec["agentKind"],
  axis: AgentLaneSpec["axis"],
): AgentLaneSpec {
  return {
    kind: "agent",
    laneId,
    axis,
    agentKind,
    model: `${agentKind}-model`,
    effort: "high",
  };
}

async function setup(options: {
  lanes: FakeLaneProgram[];
  isolation?: FakeReviewIsolationOptions;
}) {
  const cwd = await mkdtemp(join(tmpdir(), "flow-agent-"));
  const clock = createClock(0);
  const fake = new FakeHerdrAdapter({ clock, lanes: options.lanes });
  const ledger = new RecordingLedger();
  const isolation = new FakeReviewIsolation(options.isolation);
  let sessions = 0;
  const deps: RuntimeDeps = {
    adapter: fake,
    ledger,
    clock: clock.now,
    idgen: () => "run-agent",
    readResultFile: fake.readResultFile,
    sleep: async () => {},
    reviewIsolation: isolation,
    sessionIdgen: () =>
      `00000000-0000-4000-8000-00000000000${(sessions += 1)}`,
  };
  return { runtime: new WorkflowRuntime(deps), fake, ledger, isolation, cwd };
}

function start(
  runtime: WorkflowRuntime,
  cwd: string,
  lanes: LaneSpec[],
) {
  return runtime.startWorkflow({
    workflow: "review",
    workspace: "w1",
    cwd,
    lanes,
    fixedPoint: FIXED_POINT,
    inputBundle: BUNDLE,
  });
}

describe("agent lane registration and dispatch", () => {
  test("records the bundle, discriminated registration, and agent command", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const { runtime, fake, ledger, isolation, cwd } = await setup({
      lanes: [
        {
          laneId: "claude-standards",
          exitCode: 0,
          rawReport: claudeRaw(VALID_REPORT, sessionId),
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("claude-standards", "claude", "standards"),
    ]);

    const bundleEvent = ledger.events.find(
      (event) => event.type === "input_bundle_captured",
    );
    expect(bundleEvent).toBeDefined();
    const bundleData = bundleEvent!.data as {
      files: readonly { path: string }[];
      bundleHash: string;
    };
    expect(bundleData.files.map((file) => file.path)).toEqual([
      "bundle/issue.md",
      "bundle/spec.md",
      "bundle/standards.md",
    ]);

    const registered = ledger.events.find(
      (event) => event.type === "lane_registered",
    )!.data as unknown as Record<string, unknown>;
    expect(registered).toMatchObject({
      kind: "agent",
      axis: "standards",
      agentKind: "claude",
      model: "claude-model",
      effort: "high",
      bundleHash: bundleData.bundleHash,
      preassignedSessionId: sessionId,
      role: "claude:standards",
    });

    const runDir = join(cwd, handle.runId);
    const brief = await readFile(
      join(runDir, "briefs", "claude-standards.md"),
      "utf8",
    );
    expect(brief).toContain(REPORT_CONTRACT_BLOCK);
    expect(brief).toContain(bundleData.bundleHash);
    expect(
      await readFile(join(runDir, "bundle", "standards.md"), "utf8"),
    ).toBe("1\tRules.\n");
    expect(
      JSON.parse(await readFile(join(runDir, "bundle", "manifest.json"), "utf8")),
    ).toMatchObject({ bundleHash: bundleData.bundleHash });

    expect(isolation.created).toEqual([
      {
        repoRoot: FIXED_POINT.repoRoot,
        headCommit: FIXED_POINT.headCommit,
        path: join(runDir, "worktrees", "claude-standards"),
      },
    ]);
    const command = fake.dispatched[0]!.command;
    expect(command).toContain("--session-id");
    expect(command).toContain("stream-json");
    expect(command).toContain("# flow agent lane");
  });

  test("agent lanes refuse to start without their required inputs", async () => {
    const { runtime, cwd } = await setup({ lanes: [] });
    const lane = [agentLane("claude-spec", "claude", "spec")];
    await expect(
      runtime.startWorkflow({
        workflow: "review",
        workspace: "w1",
        cwd,
        lanes: lane,
        inputBundle: BUNDLE,
      }),
    ).rejects.toThrow("agent lanes require a captured fixed point");
    await expect(
      runtime.startWorkflow({
        workflow: "review",
        workspace: "w1",
        cwd,
        lanes: lane,
        fixedPoint: FIXED_POINT,
      }),
    ).rejects.toThrow("agent lanes require a captured input bundle");
  });
});

describe("agent lane completion", () => {
  test("derives report, checkpoint, session, and evidence from raw bytes", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const { runtime, ledger, isolation, cwd } = await setup({
      lanes: [
        {
          laneId: "claude-standards",
          exitCode: 0,
          rawReport: claudeRaw(VALID_REPORT, sessionId),
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("claude-standards", "claude", "standards"),
    ]);
    const result = await runtime.awaitLane(
      handle.runId,
      "claude-standards",
      60_000,
    );
    expect(result.state).toBe("complete");
    expect(result.exitCode).toBe(0);

    const run = (await ledger.load(handle.runId))!;
    const lane = run.lanes["claude-standards"]!;
    expect(lane.contractState).toBe("satisfied");
    expect(lane.contractErrors).toEqual([]);
    expect(lane.semanticState).toBe("complete");
    expect(lane.sessionIdentity).toEqual({
      kind: "measured",
      id: sessionId,
      evidence:
        "pre-assigned via --session-id; echoed by the lane's raw stream",
    });
    expect(run.finishStatus).toBe("clean");

    const runDir = join(cwd, handle.runId);
    expect(
      await readFile(
        join(runDir, "results", "claude-standards-result.txt"),
        "utf8",
      ),
    ).toBe(VALID_REPORT);
    const evidence = JSON.parse(
      await readFile(
        join(runDir, "evidence", "claude-standards-evidence.json"),
        "utf8",
      ),
    );
    expect(evidence).toMatchObject({
      exitCode: 0,
      termination: "sentinel-exit",
      rawReportArtifact: join(runDir, "reports", "claude-standards.raw"),
      tokens: {
        source: "claude result event",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });

    // The worktree was verified before the terminal event and then removed.
    const types = ledger.events.map((event) =>
      event.type === "lane_isolation_verified"
        ? `isolation:${(event.data as { phase: string }).phase}`
        : event.type,
    );
    expect(types.indexOf("isolation:post")).toBeGreaterThan(-1);
    expect(types.indexOf("isolation:post")).toBeLessThan(
      types.indexOf("lane_exited"),
    );
    expect(isolation.removed).toEqual([
      {
        repoRoot: FIXED_POINT.repoRoot,
        path: join(runDir, "worktrees", "claude-standards"),
      },
    ]);
  });

  test("codex session id comes only from the lane's own stderr", async () => {
    const { runtime, ledger, cwd } = await setup({
      lanes: [
        {
          laneId: "codex-spec",
          exitCode: 0,
          rawReport: VALID_REPORT,
          stderrContent:
            "OpenAI Codex v0.146.0\nsession id: 019fb080-9dc7-7173-8893-97f6f777329b\ntokens used\n1,234\n",
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("codex-spec", "codex", "spec"),
    ]);
    await runtime.awaitLane(handle.runId, "codex-spec", 60_000);
    const lane = (await ledger.load(handle.runId))!.lanes["codex-spec"]!;
    expect(lane.contractState).toBe("satisfied");
    expect(lane.sessionIdentity).toEqual({
      kind: "measured",
      id: "019fb080-9dc7-7173-8893-97f6f777329b",
      evidence: "parsed from the lane's own stderr `session id:` line",
    });
  });

  test("a codex lane without the banner records unavailable, never a guess", async () => {
    const { runtime, ledger, cwd } = await setup({
      lanes: [
        {
          laneId: "codex-spec",
          exitCode: 0,
          rawReport: VALID_REPORT,
          stderrContent: "no banner today\n",
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("codex-spec", "codex", "spec"),
    ]);
    await runtime.awaitLane(handle.runId, "codex-spec", 60_000);
    const lane = (await ledger.load(handle.runId))!.lanes["codex-spec"]!;
    expect(lane.sessionIdentity).toEqual({
      kind: "unavailable",
      reason: "no `session id:` line in the lane's stderr",
    });
  });

  test("a malformed report is a recorded violation, not a rerun", async () => {
    const { runtime, fake, ledger, cwd } = await setup({
      lanes: [
        {
          laneId: "grok-standards",
          exitCode: 0,
          rawReport: "I looked around but forgot the contract.\n",
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("grok-standards", "grok", "standards"),
    ]);
    await runtime.awaitLane(handle.runId, "grok-standards", 60_000);
    const run = (await ledger.load(handle.runId))!;
    const lane = run.lanes["grok-standards"]!;
    expect(lane.contractState).toBe("violated");
    expect(lane.contractErrors).toEqual([
      "VERDICT header is missing",
      "CONFIDENCE header is missing",
      "FINDINGS header is missing",
    ]);
    expect(lane.semanticState).toBe("partial");
    // Contract quality never re-dispatches: exactly one dispatch happened.
    expect(fake.dispatched).toHaveLength(1);
    // Exit codes stay runtime truth: the run itself finished clean.
    expect(run.finishStatus).toBe("clean");
  });

  test("a lost raw report keeps the failure pointed at the raw artifact", async () => {
    const { runtime, ledger, cwd } = await setup({
      lanes: [
        {
          laneId: "claude-spec",
          exitCode: 0,
          omitRawReport: true,
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("claude-spec", "claude", "spec"),
    ]);
    await runtime.awaitLane(handle.runId, "claude-spec", 60_000);
    const lane = (await ledger.load(handle.runId))!.lanes["claude-spec"]!;
    expect(lane.contractState).toBe("violated");
    expect(lane.contractErrors[0]).toContain("raw report unavailable");
    expect(lane.contractErrors[0]).toContain("claude-spec.raw");
    // Session identity still resolves from the pre-assigned id.
    expect(lane.sessionIdentity).toMatchObject({
      kind: "measured",
      id: "00000000-0000-4000-8000-000000000001",
    });
  });
});

describe("isolation outcomes", () => {
  // idgen is fixed to "run-agent", so worktree paths are known before start.
  const worktreeOf = (cwd: string, laneId: string) =>
    join(cwd, "run-agent", "worktrees", laneId);

  test("a failed post-flight makes the run invalid and retains the worktree", async () => {
    const cwdSeed = await mkdtemp(join(tmpdir(), "flow-agent-"));
    const worktree = worktreeOf(cwdSeed, "claude-standards");
    const pass = {
      headOk: true,
      cleanOk: true,
      diffHashOk: true,
      detail: null,
    };
    const dirty = {
      headOk: true,
      cleanOk: false,
      diffHashOk: true,
      detail: "worktree is dirty",
    };
    const clock = createClock(0);
    const fake = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "claude-standards",
          exitCode: 0,
          rawReport: claudeRaw(
            VALID_REPORT,
            "00000000-0000-4000-8000-000000000001",
          ),
        },
      ],
    });
    const ledger = new RecordingLedger();
    const isolation = new FakeReviewIsolation({
      verifications: { [worktree]: [pass, dirty] },
    });
    let sessions = 0;
    const runtime = new WorkflowRuntime({
      adapter: fake,
      ledger,
      clock: clock.now,
      idgen: () => "run-agent",
      readResultFile: fake.readResultFile,
      sleep: async () => {},
      reviewIsolation: isolation,
      sessionIdgen: () =>
        `00000000-0000-4000-8000-00000000000${(sessions += 1)}`,
    });
    const handle = await start(runtime, cwdSeed, [
      agentLane("claude-standards", "claude", "standards"),
    ]);
    await runtime.awaitLane(handle.runId, "claude-standards", 60_000);
    const run = (await ledger.load(handle.runId))!;
    expect(run.lanes["claude-standards"]!.isolationPost).toMatchObject({
      cleanOk: false,
      detail: "worktree is dirty",
    });
    expect(run.finishStatus).toBe("invalid");
    expect(isolation.removed).toEqual([]);
  });

  test("a failed pre-flight never dispatches that lane; others proceed", async () => {
    const cwdSeed = await mkdtemp(join(tmpdir(), "flow-agent-"));
    const clock = createClock(0);
    const fake = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "codex-spec",
          exitCode: 0,
          rawReport: VALID_REPORT,
          stderrContent: "session id: 019fb080-9dc7-7173-8893-97f6f777329b\n",
        },
      ],
    });
    const ledger = new RecordingLedger();
    const isolation = new FakeReviewIsolation({
      failCreateFor: [worktreeOf(cwdSeed, "grok-standards")],
    });
    let sessions = 0;
    const runtime = new WorkflowRuntime({
      adapter: fake,
      ledger,
      clock: clock.now,
      idgen: () => "run-agent",
      readResultFile: fake.readResultFile,
      sleep: async () => {},
      reviewIsolation: isolation,
      sessionIdgen: () =>
        `00000000-0000-4000-8000-00000000000${(sessions += 1)}`,
    });
    const handle = await start(runtime, cwdSeed, [
      agentLane("grok-standards", "grok", "standards"),
      agentLane("codex-spec", "codex", "spec"),
    ]);
    // Only the healthy lane was physically dispatched.
    expect(fake.dispatched).toHaveLength(1);
    expect(fake.dispatched[0]!.command).toContain("codex-spec");
    const afterStart = (await ledger.load(handle.runId))!;
    expect(afterStart.lanes["grok-standards"]!.runtimeState).toBe(
      "failed_to_start",
    );
    expect(afterStart.lanes["grok-standards"]!.startRejection).toContain(
      "isolation pre-flight failed",
    );

    await runtime.awaitLane(handle.runId, "codex-spec", 60_000);
    // Terminal facts for the never-started lane land on inspection.
    await runtime.inspectWorkflow(handle.runId);
    const run = (await ledger.load(handle.runId))!;
    expect(run.lanes["grok-standards"]!.sessionIdentity).toEqual({
      kind: "unavailable",
      reason: "lane never started",
    });
    // failed_to_start degrades the run without invalidating it.
    expect(run.finishStatus).toBe("degraded");
  });

  test("an interrupted agent lane records exit 130 and an honest partial", async () => {
    const { runtime, fake, ledger, cwd } = await setup({
      lanes: [
        {
          laneId: "grok-spec",
          exitCode: 0,
          rawReport: "",
          staysRunningAfterMatch: false,
          waitMatches: true,
        },
      ],
    });
    const handle = await start(runtime, cwd, [
      agentLane("grok-spec", "grok", "spec"),
    ]);
    await runtime.confirmLaneStarted(handle.runId, "grok-spec");
    const interrupt = await runtime.interruptLane(handle.runId, "grok-spec");
    expect(interrupt.delivered).toBe(true);
    const result = await runtime.awaitLane(handle.runId, "grok-spec", 60_000);
    expect(result.exitCode).toBe(130);
    expect(result.state).toBe("interrupted");
    const run = (await ledger.load(handle.runId))!;
    const lane = run.lanes["grok-spec"]!;
    expect(lane.semanticState).toBe("partial");
    expect(lane.contractState).toBe("violated");
    expect(run.finishStatus).toBe("degraded");
    void fake;
  });
});

describe("finish-status fail-closed rule", () => {
  test("a terminal agent lane WITHOUT a post-flight record forces invalid", async () => {
    const { reduce } = await import("../src/runtime/reducer.ts");
    const { expectedFinishStatus } = await import(
      "../src/runtime/reducer.ts"
    );
    let sequence = 0;
    const runId = "run-x";
    const next = (
      state: Parameters<typeof reduce>[0],
      partial: Record<string, unknown>,
    ) =>
      reduce(state, {
        schemaVersion: 1,
        eventId: `${runId}#${(sequence += 1)}`,
        runId,
        sequence,
        at: sequence,
        controllerEpoch: 0,
        ...partial,
      } as Parameters<typeof reduce>[1]);
    let state = next(undefined, {
      type: "run_started",
      actor: "runtime",
      data: {
        workflow: "review",
        workspace: "w1",
        cwd: "/tmp/x",
        splitDirection: "down",
        tabId: "t1",
        controllerPaneId: "p0",
        fixedPoint: FIXED_POINT,
        issue: null,
      },
    });
    state = next(state, {
      type: "lane_registered",
      actor: "runtime",
      laneId: "claude-spec",
      data: {
        laneId: "claude-spec",
        paneId: "p1",
        logFile: "/tmp/x/l",
        stderrFile: "/tmp/x/e",
        sentinelToken: "FLOW_run-x_LANE_claude-spec_EXIT",
        kind: "agent",
        axis: "spec",
        agentKind: "claude",
        model: "m",
        effort: "high",
        promptFile: "/tmp/x/b",
        bundleHash: "h",
        rawReportFile: "/tmp/x/r",
        worktreePath: "/tmp/x/w",
        preassignedSessionId: null,
      },
    });
    state = next(state, {
      type: "lane_exited",
      actor: "runtime",
      laneId: "claude-spec",
      data: { exitCode: 0 },
    });
    // No lane_isolation_verified(post) exists: the ONLY legal finish is
    // invalid — a clean run_finished must be rejected by the reducer.
    expect(expectedFinishStatus(state)).toBe("invalid");
    expect(() =>
      next(state, {
        type: "run_finished",
        actor: "runtime",
        data: {
          status: "clean",
          breakdown: {
            exitedZero: 1,
            exitedNonZero: 0,
            crashed: 0,
            lost: 0,
            failedToStart: 0,
          },
        },
      }),
    ).toThrow('run_finished status must be "invalid"');
  });

  test("simulated runs never consult isolation", async () => {
    const { runtime, cwd, ledger } = await setup({
      lanes: [{ laneId: "sim-1", exitCode: 0 }],
    });
    const handle = await runtime.startWorkflow({
      workflow: "wf",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "sim-1", steps: 1, stepDelaySeconds: 0.01 }],
    });
    await runtime.awaitLane(handle.runId, "sim-1", 60_000);
    expect((await ledger.load(handle.runId))!.finishStatus).toBe("clean");
  });
});
