// WorkflowRuntime issue-sync call-site tests. These exercise controller
// boundaries through the real runtime with fake Herdr and tracker adapters.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClock,
  FakeHerdrAdapter,
  FakeIssueTracker,
} from "../src/testing.ts";
import { marker } from "../src/issue/milestones.ts";
import type {
  CreatedTab,
  CreateTabOptions,
  PaneRef,
  SplitPaneOptions,
} from "../src/herdr/types.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
import {
  type CommentRef,
  type IssueTracker,
} from "../src/issue/tracker.ts";
import type {
  IssueRef,
  LaneResult,
  RunEvent,
  RunEventActor,
  RunEventDataByType,
  RunEventType,
  RuntimeDeps,
} from "../src/index.ts";

const roots: string[] = [];
const issue = {
  owner: "netfishx",
  repo: "agent-flow",
  number: 27,
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

class CountingAdapter extends FakeHerdrAdapter {
  createdTabs = 0;
  createdPanes = 0;

  override async createTab(
    options: CreateTabOptions,
  ): Promise<CreatedTab> {
    this.createdTabs++;
    return super.createTab(options);
  }

  override async splitPane(
    options: SplitPaneOptions,
  ): Promise<PaneRef> {
    this.createdPanes++;
    return super.splitPane(options);
  }
}

class RememberingTracker extends FakeIssueTracker {
  private readonly comments = new Map<string, CommentRef>();

  override async findCommentByMarker(
    ref: IssueRef,
    markerValue: string,
  ): Promise<CommentRef | null> {
    const configured = await super.findCommentByMarker(ref, markerValue);
    return configured ?? this.comments.get(markerValue) ?? null;
  }

  override async createComment(
    ref: IssueRef,
    body: string,
  ): Promise<CommentRef> {
    const comment = await super.createComment(ref, body);
    this.comments.set(body.split("\n")[0]!, comment);
    return comment;
  }
}

class LoseFirstConfirmationLedger extends InMemoryLedger {
  private lost = false;

  protected override beforeCommit(event: RunEvent): void {
    if (!this.lost && event.type === "issue_delivery_confirmed") {
      this.lost = true;
      throw new Error("injected confirmation commit loss");
    }
  }
}

class DecisionAfterAwaitRuntime extends WorkflowRuntime {
  private appended = false;

  constructor(
    deps: RuntimeDeps,
    private readonly appendDecision: (runId: string) => Promise<void>,
  ) {
    super(deps);
  }

  override async awaitLane(
    runId: string,
    laneId: string,
    timeoutMs: number,
  ): Promise<LaneResult> {
    const result = await super.awaitLane(runId, laneId, timeoutMs);
    if (!this.appended) {
      this.appended = true;
      await this.appendDecision(runId);
    }
    return result;
  }
}

async function setup(options: {
  readonly tracker?: IssueTracker;
  readonly runId?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-issue-sync-"));
  roots.push(root);
  const clock = createClock(1_000);
  const adapter = new CountingAdapter({
    clock,
    lanes: [{ laneId: "review", exitCode: 0 }],
  });
  const ledger = new InMemoryLedger();
  const runtime = new WorkflowRuntime({
    adapter,
    ledger,
    clock: clock.now,
    idgen: () => options.runId ?? "run-issue-sync",
    readResultFile: adapter.readResultFile,
    sleep: async () => {},
    ...(options.tracker === undefined
      ? {}
      : { issueTracker: options.tracker }),
  });
  return { root, adapter, ledger, runtime };
}

function config(root: string, bound = true) {
  return {
    workflow: "cross-review",
    workspace: "agent-flow",
    cwd: join(root, "work"),
    lanes: [{ laneId: "review", role: "reviewer", steps: 1 }],
    ...(bound ? { issue } : {}),
  };
}

async function appendEvent<T extends RunEventType>(
  ledger: InMemoryLedger,
  runId: string,
  type: T,
  data: RunEventDataByType[T],
  options: {
    readonly laneId?: string;
    readonly actor?: RunEventActor;
  } = {},
): Promise<void> {
  const run = await ledger.load(runId);
  if (run === null) throw new Error("expected run");
  const sequence = run.lastAppliedSequence + 1;
  await ledger.commit({
    schemaVersion: 1,
    eventId: `${runId}#${sequence}`,
    runId,
    sequence,
    type,
    at: run.updatedAt + 1,
    actor: options.actor ?? "runtime",
    controllerEpoch: run.controllerEpoch,
    data,
    ...(options.laneId === undefined
      ? {}
      : { laneId: options.laneId }),
  } as RunEvent);
}

describe("WorkflowRuntime issue synchronization", () => {
  test("rejects a bound run without a tracker before any Herdr call", async () => {
    const { root, adapter, runtime } = await setup();

    await expect(runtime.startWorkflow(config(root))).rejects.toThrow(
      /bound issue requires an issue tracker/,
    );

    expect(adapter.createdTabs).toBe(0);
    expect(adapter.createdPanes).toBe(0);
    expect(adapter.dispatched).toEqual([]);
  });

  test("reconciles the start milestone after dispatch completes", async () => {
    const tracker = new FakeIssueTracker();
    const { root, ledger, runtime } = await setup({ tracker });

    const handle = await runtime.startWorkflow(config(root));
    const run = await ledger.load(handle.runId);

    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(1);
    expect(run?.deliveryOrder).toEqual(["run-issue-sync:3:start"]);
    expect(run?.deliveries["run-issue-sync:3:start"]).toMatchObject({
      state: "delivered",
      intents: 1,
    });
  });

  test("delivers exactly one start and one completion comment end to end", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({ tracker });

    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    await runtime.resumeWorkflow(handle.runId);
    await runtime.resumeWorkflow(handle.runId);

    const run = await ledger.load(handle.runId);
    const createdBodies = tracker.calls
      .filter((call) => call.operation === "createComment")
      .map((call) => call.arguments[1] as string);
    expect(run?.finishStatus).toBe("clean");
    expect(createdBodies).toHaveLength(2);
    expect(createdBodies.filter((body) => body.includes(":start -->"))).toHaveLength(1);
    expect(
      createdBodies.filter((body) => body.includes(":complete -->")),
    ).toHaveLength(1);
    expect(run?.deliveryOrder).toHaveLength(2);
    expect(
      run?.deliveryOrder.map(
        (deliveryId) => run.deliveries[deliveryId]?.state,
      ),
    ).toEqual(["delivered", "delivered"]);
  });

  test("an unbound run makes zero tracker calls through completion", async () => {
    const tracker = new FakeIssueTracker();
    const { root, runtime } = await setup({ tracker });

    const handle = await runtime.startWorkflow(config(root, false));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);

    expect(tracker.calls).toEqual([]);
  });

  test("inspect leaves a retryable due delivery untouched", async () => {
    const failing = new FakeIssueTracker({
      failure: { operation: "resolveIssue", retryable: true },
    });
    const { root, adapter, ledger, runtime } = await setup({
      tracker: failing,
      runId: "run-inspect-due",
    });
    const handle = await runtime.startWorkflow(config(root));
    const healthy = new FakeIssueTracker();
    const observer = new WorkflowRuntime({
      adapter,
      ledger,
      clock: createClock(5_000).now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: healthy,
    });

    await observer.inspectWorkflow(handle.runId);

    expect(healthy.calls).toEqual([]);
    expect(
      (await ledger.load(handle.runId))?.deliveries[
        "run-inspect-due:3:start"
      ],
    ).toMatchObject({
      state: "failed",
      lastFailure: { retryable: true },
    });
  });

  test("a drive slice delivers a decision while its lane remains non-terminal", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-drive-slice-"),
    );
    roots.push(root);
    const clock = createClock(7_500);
    const adapter = new CountingAdapter({
      clock,
      lanes: [
        {
          laneId: "review",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
      ],
    });
    const ledger = new InMemoryLedger();
    const tracker = new FakeIssueTracker();
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-drive-slice-only",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await appendEvent(
      ledger,
      handle.runId,
      "owner_decision_recorded",
      {
        decision: "changes-requested",
        note: "recorded between dispatch and terminal facts",
        resultingIssueState: "needs-info",
      },
      { actor: "human" },
    );

    const lane = await runtime.awaitLane(
      handle.runId,
      "review",
      1,
    );

    const run = await ledger.load(handle.runId);
    const decision = run?.decisions[0];
    if (decision === undefined) {
      throw new Error("expected owner decision");
    }
    const deliveryId =
      `${handle.runId}:${decision.sequence}:decision`;
    expect(lane).toMatchObject({
      state: "running",
      timedOut: true,
    });
    expect(run?.finishStatus).toBeNull();
    expect(run?.deliveries[deliveryId]).toMatchObject({
      kind: "decision",
      state: "delivered",
    });
    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes("## Owner decision")),
    ).toHaveLength(1);
  });

  test("a lost confirmation commit is backfilled on resume without reposting start", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-confirm-"),
    );
    roots.push(root);
    const clock = createClock(10_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const ledger = new LoseFirstConfirmationLedger();
    const tracker = new RememberingTracker();
    const deps = {
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-confirmation-loss",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    };
    const handle = await new WorkflowRuntime(deps).startWorkflow(
      config(root),
    );

    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(1);

    await new WorkflowRuntime({
      ...deps,
      idgen: () => "unused",
    }).resumeWorkflow(handle.runId, 1_000);

    const run = await ledger.load(handle.runId);
    const createdBodies = tracker.calls
      .filter((call) => call.operation === "createComment")
      .map((call) => call.arguments[1] as string);
    expect(
      createdBodies.filter((body) => body.includes(":start -->")),
    ).toHaveLength(1);
    expect(
      run?.deliveries["run-confirmation-loss:3:start"],
    ).toMatchObject({
      state: "delivered",
      intents: 2,
    });
    expect(run?.finishStatus).toBe("clean");
  });

  test("resume tail delivers a decision recorded after the last driven lane returns", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-resume-tail-"),
    );
    roots.push(root);
    const clock = createClock(15_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const ledger = new InMemoryLedger();
    const tracker = new FakeIssueTracker();
    const deps: RuntimeDeps = {
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-resume-tail-only",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    };
    const handle = await new WorkflowRuntime(deps).startWorkflow(
      config(root),
    );
    const resumed = new DecisionAfterAwaitRuntime(
      { ...deps, idgen: () => "unused" },
      (runId) =>
        appendEvent(
          ledger,
          runId,
          "owner_decision_recorded",
          {
            decision: "changes-requested",
            note: "recorded after lane drive",
            resultingIssueState: "needs-info",
          },
          { actor: "human" },
        ),
    );

    await resumed.resumeWorkflow(handle.runId, 1_000);

    const run = await ledger.load(handle.runId);
    const decision = run?.decisions[0];
    if (decision === undefined) {
      throw new Error("expected owner decision");
    }
    const deliveryId =
      `${handle.runId}:${decision.sequence}:decision`;
    expect(run?.deliveries[deliveryId]).toMatchObject({
      kind: "decision",
      state: "delivered",
      labelTransition: "not-applicable",
    });
    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes("## Owner decision")),
    ).toHaveLength(1);
  });

  test.each([
    "resolveIssue",
    "findCommentByMarker",
    "createComment",
    "readCurrentLabels",
    "compareAndSetTriageLabel",
  ] as const)(
    "a %s failure does not change lane or finish outcomes",
    async (operation) => {
      const baseline = await setup({
        runId: `run-baseline-${operation}`,
      });
      const baselineHandle = await baseline.runtime.startWorkflow(
        config(baseline.root, false),
      );
      await baseline.runtime.confirmLaneStarted(
        baselineHandle.runId,
        "review",
      );
      await baseline.runtime.awaitLane(
        baselineHandle.runId,
        "review",
        1_000,
      );
      const baselineRun = await baseline.ledger.load(
        baselineHandle.runId,
      );

      const runId = `run-failure-${operation}`;
      const tracker = new FakeIssueTracker({
        failure: { operation, retryable: true },
        ...(operation === "readCurrentLabels"
          ? {
              markerHit: {
                body: `${marker(`${runId}:3:start`)}\n\nexisting`,
                comment: {
                  commentId: 91,
                  commentUrl:
                    "https://example.invalid/comment/91",
                },
              },
            }
          : {}),
        ...(operation === "compareAndSetTriageLabel"
          ? { labels: ["ready-for-agent"] }
          : {}),
      });
      const failing = await setup({ tracker, runId });
      const handle = await failing.runtime.startWorkflow(
        config(failing.root),
      );
      if (operation === "compareAndSetTriageLabel") {
        await appendEvent(
          failing.ledger,
          handle.runId,
          "lane_checkpoint",
          {
            semanticState: "blocked",
            checkpointFile: join(
              failing.root,
              "work",
              runId,
              "checkpoints",
              "review.md",
            ),
            blockers: ["owner decision required"],
          },
          { laneId: "review", actor: "agent" },
        );
      }
      await failing.runtime.confirmLaneStarted(handle.runId, "review");
      await failing.runtime.awaitLane(handle.runId, "review", 1_000);
      const failingRun = await failing.ledger.load(handle.runId);

      expect(failingRun?.finishStatus).toBe(baselineRun?.finishStatus);
      expect(failingRun?.breakdown).toEqual(baselineRun?.breakdown);
      expect(failingRun?.lanes.review?.runtimeState).toBe(
        baselineRun?.lanes.review?.runtimeState,
      );
      expect(failingRun?.lanes.review?.exitCode).toBe(
        baselineRun?.lanes.review?.exitCode,
      );
    },
  );

  test("an unusable artifact pointer at a drive boundary does not stop completion", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-pointer-"),
    );
    roots.push(root);
    const clock = createClock(20_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [
        { laneId: "bad", exitCode: 0 },
        { laneId: "good", exitCode: 0 },
      ],
    });
    const ledger = new InMemoryLedger();
    const tracker = new FakeIssueTracker();
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-bad-pointer",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow({
      ...config(root),
      lanes: [
        { laneId: "bad", steps: 1 },
        { laneId: "good", steps: 1 },
      ],
    });
    await appendEvent(
      ledger,
      handle.runId,
      "lane_exited",
      { exitCode: 0 },
      { laneId: "bad" },
    );
    await appendEvent(
      ledger,
      handle.runId,
      "lane_contract_evaluated",
      {
        contractState: "satisfied",
        resultFile: "/outside/run/result.txt",
        errors: [],
      },
      { laneId: "bad", actor: "validator" },
    );
    await appendEvent(
      ledger,
      handle.runId,
      "lane_verification_recorded",
      {
        verificationState: "verified",
        evidenceFile: "/outside/run/evidence.json",
      },
      { laneId: "bad", actor: "runner" },
    );

    await runtime.confirmLaneStarted(handle.runId, "good");
    await expect(
      runtime.awaitLane(handle.runId, "good", 1_000),
    ).resolves.toMatchObject({ state: "complete", exitCode: 0 });

    expect((await ledger.load(handle.runId))?.finishStatus).toBe(
      "clean",
    );
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(1);
  });
});
