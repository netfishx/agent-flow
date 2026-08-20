// WorkflowRuntime issue-sync call-site tests. These exercise controller
// boundaries through the real runtime with fake Herdr and tracker adapters.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  ControllerLeaseHeldError,
  InMemoryLedger,
  type LeaseHandle,
  type Ledger,
} from "../src/runtime/ledger.ts";
import {
  PartialDispatchError,
  WorkflowRuntime,
} from "../src/runtime/runtime.ts";
import {
  type CommentRef,
  type IssueTracker,
  IssueTrackerError,
} from "../src/issue/tracker.ts";
import type { HerdrAdapter } from "../src/herdr/adapter.ts";
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

class LeaseFailureLedger implements Ledger {
  acquireCalls = 0;

  constructor(
    private readonly delegate: Ledger,
    private readonly failure: Error,
  ) {}

  commit(event: RunEvent): Promise<void> {
    return this.delegate.commit(event);
  }

  load(runId: string) {
    return this.delegate.load(runId);
  }

  list() {
    return this.delegate.list();
  }

  async acquireLease(): Promise<LeaseHandle> {
    this.acquireCalls += 1;
    throw this.failure;
  }
}

/**
 * Delegates every ledger call, fails one commit type, and fails every lease
 * release. Both failures are needed to reach the double-error window: the
 * commit failure is the mutation's own error, the release failure is what used
 * to replace it.
 */
class ReleaseFailureLedger implements Ledger {
  constructor(
    private readonly delegate: Ledger,
    private readonly failCommitOn: RunEventType,
  ) {}

  commit(event: RunEvent): Promise<void> {
    if (event.type === this.failCommitOn) {
      return Promise.reject(
        new Error(`injected ${event.type} commit failure`),
      );
    }
    return this.delegate.commit(event);
  }

  load(runId: string) {
    return this.delegate.load(runId);
  }

  list() {
    return this.delegate.list();
  }

  async acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    const lease = await this.delegate.acquireLease(runId, controller);
    return {
      release: async () => {
        await lease.release();
        throw new Error("injected controller lease release failure");
      },
    };
  }
}

class BeforeAcquireLedger implements Ledger {
  acquireCalls = 0;
  releaseCalls = 0;

  constructor(
    private readonly delegate: Ledger,
    private readonly beforeAcquire: () => Promise<void>,
  ) {}

  commit(event: RunEvent): Promise<void> {
    return this.delegate.commit(event);
  }

  load(runId: string) {
    return this.delegate.load(runId);
  }

  list() {
    return this.delegate.list();
  }

  async acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    this.acquireCalls += 1;
    await this.beforeAcquire();
    const lease = await this.delegate.acquireLease(runId, controller);
    return {
      release: async () => {
        await lease.release();
        this.releaseCalls += 1;
      },
    };
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

class ArmableConfirmationLossLedger extends InMemoryLedger {
  private armed = false;

  loseNextConfirmation(): void {
    this.armed = true;
  }

  protected override beforeCommit(event: RunEvent): void {
    if (this.armed && event.type === "issue_delivery_confirmed") {
      this.armed = false;
      throw new Error("injected confirmation commit loss");
    }
  }
}

class RecordingLedger extends InMemoryLedger {
  readonly events: RunEvent[] = [];
  leaseAcquisitions = 0;
  leaseReleases = 0;

  override async commit(event: RunEvent): Promise<void> {
    await super.commit(event);
    this.events.push(structuredClone(event));
  }

  override async acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    this.leaseAcquisitions += 1;
    const lease = await super.acquireLease(runId, controller);
    return {
      release: async () => {
        await lease.release();
        this.leaseReleases += 1;
      },
    };
  }
}

class CompleteFailingTracker extends FakeIssueTracker {
  override async createComment(
    ref: IssueRef,
    body: string,
  ): Promise<CommentRef> {
    if (body.includes(":complete -->")) {
      throw new IssueTrackerError(
        "injected complete delivery failure",
        true,
      );
    }
    return super.createComment(ref, body);
  }
}

class ExplodingHerdrAdapter implements HerdrAdapter {
  private fail(method: string): Promise<never> {
    return Promise.reject(
      new Error(`finished-run retry called HerdrAdapter.${method}`),
    );
  }

  createTab(): Promise<never> {
    return this.fail("createTab");
  }

  splitPane(): Promise<never> {
    return this.fail("splitPane");
  }

  runInPane(): Promise<never> {
    return this.fail("runInPane");
  }

  waitForOutput(): Promise<never> {
    return this.fail("waitForOutput");
  }

  processInfo(): Promise<never> {
    return this.fail("processInfo");
  }

  focusPane(): Promise<never> {
    return this.fail("focusPane");
  }

  interruptPane(): Promise<never> {
    return this.fail("interruptPane");
  }
}

class ExitBeforeBlockedCheckpointLedger extends InMemoryLedger {
  readonly events: RunEvent[] = [];
  private injected = false;

  override async commit(event: RunEvent): Promise<void> {
    if (
      !this.injected &&
      event.type === "lane_checkpoint" &&
      event.data.semanticState === "blocked"
    ) {
      this.injected = true;
      const exitEvent = {
        ...event,
        type: "lane_exited",
        actor: "runtime",
        data: { exitCode: 0 },
      } as const satisfies RunEvent;
      await super.commit(exitEvent);
      this.events.push(structuredClone(exitEvent));
    }
    await super.commit(event);
    this.events.push(structuredClone(event));
  }
}

/**
 * Parks the first marker query until the test releases it, so a second
 * reconciliation can be driven into the exact window where the first has
 * already recorded its intent but has not yet created its comment.
 */
class GatedMarkerTracker extends FakeIssueTracker {
  private armed = false;
  private parked = false;
  private readonly entry = Promise.withResolvers<void>();
  private readonly gate = Promise.withResolvers<void>();

  /** Resolves once a marker query is parked inside the remote window. */
  get parkedInMarkerQuery(): Promise<void> {
    return this.entry.promise;
  }

  arm(): void {
    this.armed = true;
  }

  release(): void {
    this.gate.resolve();
  }

  override async findCommentByMarker(
    ref: IssueRef,
    markerValue: string,
  ): Promise<CommentRef | null> {
    const found = await super.findCommentByMarker(ref, markerValue);
    if (this.armed && !this.parked) {
      this.parked = true;
      this.entry.resolve();
      await this.gate.promise;
    }
    return found;
  }
}

/** Lets a test observe that a lane has entered its drive-slice boundary. */
class BoundaryReportingRuntime extends WorkflowRuntime {
  constructor(
    deps: RuntimeDeps,
    private readonly onBoundary: (laneId: string) => void,
  ) {
    super(deps);
  }

  protected override async onDriveSliceBoundary(
    runId: string,
    laneId: string,
  ): Promise<void> {
    this.onBoundary(laneId);
    await super.onDriveSliceBoundary(runId, laneId);
  }
}

class BoundaryReconcileRuntime extends WorkflowRuntime {
  async reconcileAtBoundary(
    runId: string,
    laneId: string,
  ): Promise<void> {
    await this.onDriveSliceBoundary(runId, laneId);
  }
}

class LeaseControlRuntime extends WorkflowRuntime {
  async holdControllerLease(runId: string): Promise<void> {
    await this.acquireControllerLease(runId);
  }

  async returnControllerLease(runId: string): Promise<void> {
    await this.releaseControllerLease(runId);
  }
}

/** Runs every already-scheduled microtask and timer callback to completion. */
async function settleEventLoop(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

async function finishedRunWithOutstandingComplete(runId: string) {
  const root = await mkdtemp(
    join(tmpdir(), "agent-flow-finished-delivery-"),
  );
  roots.push(root);
  const clock = createClock(3_000);
  const adapter = new CountingAdapter({
    clock,
    lanes: [{ laneId: "review", exitCode: 0 }],
  });
  const ledger = new RecordingLedger();
  const runtime = new WorkflowRuntime({
    adapter,
    ledger,
    clock: clock.now,
    idgen: () => runId,
    readResultFile: adapter.readResultFile,
    sleep: async () => {},
    issueTracker: new CompleteFailingTracker(),
  });
  const handle = await runtime.startWorkflow(config(root));
  await runtime.confirmLaneStarted(handle.runId, "review");
  await runtime.awaitLane(handle.runId, "review", 1_000);
  const finished = await ledger.load(handle.runId);
  if (finished === null || finished.finishedSequence === null) {
    throw new Error("expected a finished source run");
  }
  const completeId =
    `${handle.runId}:${finished.finishedSequence}:complete`;
  expect(finished.deliveries[completeId]).toMatchObject({
    state: "failed",
    lastFailure: { retryable: true },
  });
  return { adapter, clock, completeId, finished, handle, ledger, root };
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

  test("records an unfinished owner decision lease-free with the human actor", async () => {
    const { root, adapter, ledger, runtime } = await setup();
    const handle = await runtime.startWorkflow(config(root, false));
    const refusingLedger = new LeaseFailureLedger(
      ledger,
      new ControllerLeaseHeldError("live controller"),
    );
    const recorder = new WorkflowRuntime({
      adapter,
      ledger: refusingLedger,
      clock: () => 2_000,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    const status = await recorder.recordOwnerDecision(handle.runId, {
      decision: "accepted",
      note: "",
    });

    expect(status.state).toBe("running");
    expect(refusingLedger.acquireCalls).toBe(0);
    expect((await ledger.load(handle.runId))?.decisions).toEqual([
      {
        sequence: 5,
        at: 2_000,
        actor: "human",
        decision: "accepted",
        note: "",
        resultingIssueState: null,
      },
    ]);
  });

  test("records a finished owner decision without a lease when no tracker exists", async () => {
    const { root, adapter, ledger, runtime } = await setup();
    const handle = await runtime.startWorkflow(config(root, false));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    const refusingLedger = new LeaseFailureLedger(
      ledger,
      new Error("a tracker-free decision must not acquire a lease"),
    );
    const recorder = new WorkflowRuntime({
      adapter,
      ledger: refusingLedger,
      clock: () => 2_500,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await recorder.recordOwnerDecision(handle.runId, {
      decision: "accepted",
      note: "Recorded locally without a delivery adapter.",
    });

    expect(refusingLedger.acquireCalls).toBe(0);
    expect((await ledger.load(handle.runId))?.decisions.at(-1)).toMatchObject({
      actor: "human",
      decision: "accepted",
      resultingIssueState: null,
    });
  });

  test("a finished unbound owner decision ignores an injected tracker and the controller lease", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root, false));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    tracker.calls.splice(0);
    const countingLedger = new BeforeAcquireLedger(
      ledger,
      async () => {},
    );
    const recorder = new WorkflowRuntime({
      adapter,
      ledger: countingLedger,
      clock: () => 2_625,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });

    await recorder.recordOwnerDecision(handle.runId, {
      decision: "accepted",
      note: "Unbound decisions remain local.",
    });

    expect(countingLedger.acquireCalls).toBe(0);
    expect(countingLedger.releaseCalls).toBe(0);
    expect(tracker.calls).toEqual([]);
  });

  test("bound resume and owner decision fail closed without a tracker", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    const decisionCount = (await ledger.load(handle.runId))!.decisions.length;
    const unconfigured = new WorkflowRuntime({
      adapter,
      ledger,
      clock: () => 2_750,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      unconfigured.resumeWorkflow(handle.runId),
    ).rejects.toThrow("bound issue requires an issue tracker");
    await expect(
      unconfigured.recordOwnerDecision(handle.runId, {
        decision: "accepted",
        note: "must not be recorded without its configured delivery path",
      }),
    ).rejects.toThrow("bound issue requires an issue tracker");

    expect((await ledger.load(handle.runId))!.decisions).toHaveLength(
      decisionCount,
    );
  });

  test("finished bound resume stays read-only when every delivery is settled", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    const refusingLedger = new LeaseFailureLedger(
      ledger,
      new Error("settled finished run must not acquire a lease"),
    );

    const status = await new WorkflowRuntime({
      adapter,
      ledger: refusingLedger,
      clock: () => 2_900,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    }).resumeWorkflow(handle.runId);

    expect(status.state).toBe("complete");
    expect(refusingLedger.acquireCalls).toBe(0);
  });

  test("finished resume reloads under the lease and returns when another controller settled the work", async () => {
    const {
      adapter,
      clock,
      completeId,
      handle,
      ledger,
    } = await finishedRunWithOutstandingComplete(
      "run-finished-settled-race",
    );
    const failed = (await ledger.load(handle.runId))!.deliveries[
      completeId
    ]!;
    const eventsBefore = ledger.events.length;
    let settled = false;
    const racingLedger = new BeforeAcquireLedger(ledger, async () => {
      if (settled) return;
      settled = true;
      await appendEvent(
        ledger,
        handle.runId,
        "issue_delivery_intended",
        {
          deliveryId: completeId,
          kind: "complete",
          laneId: null,
          payloadHash: failed.payloadHash,
        },
      );
      await appendEvent(
        ledger,
        handle.runId,
        "issue_delivery_confirmed",
        {
          deliveryId: completeId,
          commentId: 31,
          commentUrl:
            "https://example.invalid/issues/30#issuecomment-31",
          labelTransition: "not-applicable",
        },
      );
    });

    const status = await new WorkflowRuntime({
      adapter,
      ledger: racingLedger,
      clock: clock.now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: new FakeIssueTracker(),
    }).resumeWorkflow(handle.runId);

    expect(status.state).toBe("complete");
    expect(racingLedger.acquireCalls).toBe(1);
    expect(racingLedger.releaseCalls).toBe(1);
    expect(
      ledger.events
        .slice(eventsBefore)
        .filter((event) => event.type === "controller_attached"),
    ).toHaveLength(0);
  });

  test("finished resume keeps a controller lease the runtime already held", async () => {
    const {
      handle,
      ledger,
    } = await finishedRunWithOutstandingComplete(
      "run-finished-held-controller",
    );
    const runtime = new LeaseControlRuntime({
      adapter: new ExplodingHerdrAdapter(),
      ledger,
      clock: () => 3_500,
      idgen: () => "unused",
      readResultFile: async () => {
        throw new Error("finished-run retry read a lane artifact");
      },
      sleep: async () => {},
      issueTracker: new FakeIssueTracker(),
    });
    await runtime.holdControllerLease(handle.runId);
    const releasesBefore = ledger.leaseReleases;

    await runtime.resumeWorkflow(handle.runId);

    expect(ledger.leaseReleases).toBe(releasesBefore);
    await runtime.returnControllerLease(handle.runId);
    expect(ledger.leaseReleases).toBe(releasesBefore + 1);
  });

  test("finished resume retries deliveries under a new epoch without touching Herdr or lane facts", async () => {
    const {
      completeId,
      finished,
      handle,
      ledger,
    } = await finishedRunWithOutstandingComplete(
      "run-finished-delivery-retry",
    );
    const eventsBefore = ledger.events.length;
    const acquisitionsBefore = ledger.leaseAcquisitions;
    const releasesBefore = ledger.leaseReleases;
    const tracker = new FakeIssueTracker({
      createdComment: {
        commentId: 30,
        commentUrl:
          "https://example.invalid/issues/30#issuecomment-30",
      },
    });

    const status = await new WorkflowRuntime({
      adapter: new ExplodingHerdrAdapter(),
      ledger,
      clock: () => 4_000,
      idgen: () => "unused",
      readResultFile: async () => {
        throw new Error("finished-run retry read a lane artifact");
      },
      sleep: async () => {},
      issueTracker: tracker,
    }).resumeWorkflow(handle.runId);
    const reloaded = await ledger.load(handle.runId);
    const appended = ledger.events.slice(eventsBefore);

    expect(status).toMatchObject({
      state: "complete",
      lanes: [{ laneId: "review", state: "complete", exitCode: 0 }],
    });
    expect(reloaded).toMatchObject({
      finishStatus: finished.finishStatus,
      breakdown: finished.breakdown,
      controllerEpoch: finished.controllerEpoch + 1,
      lanes: {
        review: {
          runtimeState: finished.lanes.review!.runtimeState,
          exitCode: finished.lanes.review!.exitCode,
          contractState: finished.lanes.review!.contractState,
          verificationState: finished.lanes.review!.verificationState,
        },
      },
      deliveries: {
        [completeId]: {
          state: "delivered",
          intents: 2,
          commentUrl:
            "https://example.invalid/issues/30#issuecomment-30",
        },
      },
    });
    expect(ledger.leaseAcquisitions).toBe(acquisitionsBefore + 1);
    expect(ledger.leaseReleases).toBe(releasesBefore + 1);
    expect(appended[0]).toMatchObject({
      type: "controller_attached",
      controllerEpoch: finished.controllerEpoch,
      data: { epoch: finished.controllerEpoch + 1 },
    });
    expect(
      appended.filter((event) => event.type === "controller_attached"),
    ).toHaveLength(1);
    expect(
      appended.filter((event) => event.type === "run_finished"),
    ).toHaveLength(0);
    expect(
      appended.filter((event) => event.type.startsWith("lane_")),
    ).toHaveLength(0);
  });

  test("finished resume contains a retry failure without changing runtime outcomes", async () => {
    const {
      completeId,
      finished,
      handle,
      ledger,
    } = await finishedRunWithOutstandingComplete(
      "run-finished-delivery-failure",
    );

    const status = await new WorkflowRuntime({
      adapter: new ExplodingHerdrAdapter(),
      ledger,
      clock: () => 4_500,
      idgen: () => "unused",
      readResultFile: async () => {
        throw new Error("finished-run retry read a lane artifact");
      },
      sleep: async () => {},
      issueTracker: new CompleteFailingTracker(),
    }).resumeWorkflow(handle.runId);
    const reloaded = await ledger.load(handle.runId);

    expect(status).toMatchObject({
      state: "complete",
      lanes: [{ laneId: "review", state: "complete", exitCode: 0 }],
    });
    expect(reloaded).toMatchObject({
      finishStatus: finished.finishStatus,
      breakdown: finished.breakdown,
      deliveries: {
        [completeId]: {
          state: "failed",
          intents: 2,
          lastFailure: {
            reason: "injected complete delivery failure",
            retryable: true,
          },
        },
      },
    });
    for (const laneId of finished.laneOrder) {
      expect(reloaded!.lanes[laneId]).toEqual(
        finished.lanes[laneId],
      );
    }
  });

  test("a start failure stays primary when its lease release also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-flow-start-release-"));
    roots.push(root);
    const clock = createClock(1_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger: new ReleaseFailureLedger(new InMemoryLedger(), "run_started"),
      clock: clock.now,
      idgen: () => "run-start-release",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    const error = await runtime.startWorkflow(config(root, false)).then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toContain("injected run_started commit failure");
    expect(failure.message).toContain("controller lease release failed");
    expect(failure.message).toContain(
      "injected controller lease release failure",
    );
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toBe(
      "injected run_started commit failure",
    );
  });

  test("a finished resume failure stays primary when its lease release also fails", async () => {
    const { handle, ledger } = await finishedRunWithOutstandingComplete(
      "run-finished-delivery-release",
    );

    const error = await new WorkflowRuntime({
      adapter: new ExplodingHerdrAdapter(),
      ledger: new ReleaseFailureLedger(ledger, "controller_attached"),
      clock: () => 4_000,
      idgen: () => "unused",
      readResultFile: async () => {
        throw new Error("finished-run retry read a lane artifact");
      },
      sleep: async () => {},
      issueTracker: new FakeIssueTracker(),
    })
      .resumeWorkflow(handle.runId)
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );

    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toContain(
      "injected controller_attached commit failure",
    );
    expect(failure.message).toContain("controller lease release failed");
    expect(failure.message).toContain(
      "injected controller lease release failure",
    );
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toBe(
      "injected controller_attached commit failure",
    );
  });

  test("finished resume with outstanding delivery refuses a live controller holder", async () => {
    const {
      adapter,
      clock,
      finished,
      handle,
      ledger,
    } = await finishedRunWithOutstandingComplete(
      "run-finished-live-controller",
    );
    const held = new LeaseFailureLedger(
      ledger,
      new ControllerLeaseHeldError("live controller"),
    );

    await expect(
      new WorkflowRuntime({
        adapter,
        ledger: held,
        clock: clock.now,
        idgen: () => "unused",
        readResultFile: adapter.readResultFile,
        sleep: async () => {},
        issueTracker: new FakeIssueTracker(),
      }).resumeWorkflow(handle.runId),
    ).rejects.toThrow("live controller");

    expect((await ledger.load(handle.runId))!.controllerEpoch).toBe(
      finished.controllerEpoch,
    );
  });

  test("finished resume does not attach when a planning failure is the only outstanding condition", async () => {
    const {
      completeId,
      handle,
      ledger,
      root,
    } = await finishedRunWithOutstandingComplete(
      "run-finished-planning-failure",
    );
    const failed = (await ledger.load(handle.runId))!.deliveries[
      completeId
    ]!;
    await appendEvent(
      ledger,
      handle.runId,
      "issue_delivery_intended",
      {
        deliveryId: completeId,
        kind: "complete",
        laneId: null,
        payloadHash: failed.payloadHash,
      },
    );
    await appendEvent(
      ledger,
      handle.runId,
      "issue_delivery_failed",
      {
        deliveryId: completeId,
        reason: "requires operator",
        retryable: false,
      },
    );
    await appendEvent(
      ledger,
      handle.runId,
      "lane_checkpoint",
      {
        semanticState: "blocked",
        checkpointFile: join(root, "work", "outside-run", "review.md"),
      },
      { laneId: "review", actor: "agent" },
    );
    const eventsBefore = ledger.events.length;
    const tracker = new FakeIssueTracker();

    await new WorkflowRuntime({
      adapter: new ExplodingHerdrAdapter(),
      ledger,
      clock: () => 5_000,
      idgen: () => "unused",
      readResultFile: async () => {
        throw new Error("finished-run retry read a lane artifact");
      },
      sleep: async () => {},
      issueTracker: tracker,
    }).resumeWorkflow(handle.runId);
    const appended = ledger.events.slice(eventsBefore);

    expect(
      appended.filter((event) => event.type === "controller_attached"),
    ).toHaveLength(0);
    expect(
      appended.filter((event) =>
        event.type.startsWith("issue_delivery_"),
      ),
    ).toHaveLength(0);
    expect(tracker.calls).toEqual([]);
  });

  test("a finished run acquires a lease and reconciles one owner decision", async () => {
    const tracker = new FakeIssueTracker();
    const { root, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    tracker.calls.splice(0);

    await runtime.recordOwnerDecision(handle.runId, {
      decision: "changes-requested",
      note: "Address the two review findings.",
      resultingIssueState: "ready-for-agent",
    });

    const run = await ledger.load(handle.runId);
    const decision = run?.decisions.at(-1);
    if (decision === undefined) throw new Error("expected owner decision");
    const delivery = run?.deliveries[
      `${handle.runId}:${decision.sequence}:decision`
    ];
    const createdBodies = tracker.calls
      .filter((call) => call.operation === "createComment")
      .map((call) => call.arguments[1] as string);
    expect(delivery).toMatchObject({
      kind: "decision",
      state: "delivered",
      labelTransition: "not-applicable",
    });
    expect(createdBodies).toHaveLength(1);
    expect(createdBodies[0]).toContain(
      "Recorded from the owner through the trusted local CLI.",
    );
    expect(createdBodies[0]).toContain("ready-for-agent");
    expect(createdBodies[0]).toContain("did not enact the issue state");
    expect(
      tracker.calls.some(
        (call) => call.operation === "compareAndSetTriageLabel",
      ),
    ).toBeFalse();
  });

  test("recording on a finished run preserves a controller lease already held by this runtime", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-held-lease-"),
    );
    roots.push(root);
    const clock = createClock(4_000);
    const adapter = new CountingAdapter({
      clock,
      failRunInPane: true,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const ledger = new InMemoryLedger();
    const tracker = new FakeIssueTracker();
    const runtime = new BoundaryReconcileRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-held-finished-lease",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    let runId: string | null = null;
    try {
      await runtime.startWorkflow(config(root));
    } catch (error) {
      expect(error).toBeInstanceOf(PartialDispatchError);
      runId = (error as PartialDispatchError).runId;
    }
    if (runId === null) throw new Error("expected partial dispatch");
    expect((await ledger.load(runId))?.finishStatus).toBe("degraded");
    tracker.calls.splice(0);

    await runtime.recordOwnerDecision(runId, {
      decision: "accepted",
      note: "The held controller delivers this decision.",
    });

    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes(":decision -->")),
    ).toHaveLength(1);
    await appendEvent(
      ledger,
      runId,
      "owner_decision_recorded",
      {
        decision: "changes-requested",
        note: "A later boundary must still own reconciliation.",
        resultingIssueState: null,
      },
      { actor: "human" },
    );
    tracker.calls.splice(0);

    await runtime.reconcileAtBoundary(runId, "review");

    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes(":decision -->")),
    ).toHaveLength(1);
  });

  test("a live finished-run lease holder leaves the committed decision for its next boundary", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    tracker.calls.splice(0);
    const held = new LeaseFailureLedger(
      ledger,
      new ControllerLeaseHeldError(
        `controller lease for run "${handle.runId}" is already held`,
      ),
    );
    const recorder = new WorkflowRuntime({
      adapter,
      ledger: held,
      clock: () => 20_000,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });

    await recorder.recordOwnerDecision(handle.runId, {
      decision: "rejected",
      note: "The controller will deliver this.",
    });

    expect(held.acquireCalls).toBe(1);
    expect(tracker.calls).toEqual([]);
    expect((await ledger.load(handle.runId))?.decisions.at(-1)).toMatchObject({
      actor: "human",
      decision: "rejected",
      resultingIssueState: null,
    });
  });

  test("a non-holder lease failure propagates after the owner decision is durable", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    const failed = new LeaseFailureLedger(
      ledger,
      new Error("lease storage unavailable"),
    );
    const recorder = new WorkflowRuntime({
      adapter,
      ledger: failed,
      clock: () => 21_000,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });

    await expect(
      recorder.recordOwnerDecision(handle.runId, {
        decision: "rejected",
        note: "Durable before delivery acquisition.",
      }),
    ).rejects.toThrow("lease storage unavailable");
    expect((await ledger.load(handle.runId))?.decisions.at(-1)).toMatchObject({
      actor: "human",
      decision: "rejected",
    });
  });

  test("multiple owner decisions each receive a distinct decision delivery", async () => {
    const tracker = new FakeIssueTracker();
    const { root, ledger, runtime } = await setup({ tracker });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.awaitLane(handle.runId, "review", 1_000);
    tracker.calls.splice(0);

    await runtime.recordOwnerDecision(handle.runId, {
      decision: "accepted",
      note: "Ship it.",
      resultingIssueState: "ready-for-human",
    });
    await runtime.recordOwnerDecision(handle.runId, {
      decision: "changes-requested",
      note: "One more adjustment.",
    });

    const run = await ledger.load(handle.runId);
    const decisionDeliveries = run?.deliveryOrder
      .map((deliveryId) => run.deliveries[deliveryId]!)
      .filter((delivery) => delivery.kind === "decision");
    const bodies = tracker.calls
      .filter((call) => call.operation === "createComment")
      .map((call) => call.arguments[1] as string);
    expect(decisionDeliveries).toHaveLength(2);
    expect(new Set(decisionDeliveries?.map(({ deliveryId }) => deliveryId)).size)
      .toBe(2);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.split("\n")[0])).size).toBe(2);
    expect(bodies[1]).toContain(
      "Resulting issue state stated by the owner:** not stated",
    );
    expect(
      decisionDeliveries?.every(
        ({ labelTransition }) => labelTransition === "not-applicable",
      ),
    ).toBeTrue();
  });

  test("recording an owner decision rejects an unknown run", async () => {
    const { runtime } = await setup();

    await expect(
      runtime.recordOwnerDecision("missing", {
        decision: "accepted",
        note: "No run exists.",
      }),
    ).rejects.toThrow('run not found: "missing"');
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

  test("inspection cannot synchronize when its runtime still holds the lease", async () => {
    const tracker = new FakeIssueTracker();
    const { root, adapter, ledger, runtime } = await setup({
      tracker,
      runId: "run-inspect-held-lease",
    });
    const handle = await runtime.startWorkflow(config(root));
    tracker.calls.splice(0);
    adapter.finishLane("review");

    await runtime.inspectWorkflow(handle.runId);

    const run = await ledger.load(handle.runId);
    expect(run?.finishStatus).toBe("clean");
    expect(run?.deliveryOrder).toEqual([
      "run-inspect-held-lease:3:start",
    ]);
    expect(tracker.calls).toEqual([]);
  });

  test("inspection cannot synchronize terminal facts while holding the lease", async () => {
    const tracker = new FakeIssueTracker();
    const { root, ledger, runtime } = await setup({
      tracker,
      runId: "run-inspect-terminal-held-lease",
    });
    const handle = await runtime.startWorkflow(config(root));
    tracker.calls.splice(0);
    await appendEvent(
      ledger,
      handle.runId,
      "lane_exited",
      { exitCode: 0 },
      { laneId: "review" },
    );

    await runtime.inspectWorkflow(handle.runId);

    const run = await ledger.load(handle.runId);
    expect(run?.finishStatus).toBe("clean");
    expect(run?.deliveryOrder).toEqual([
      "run-inspect-terminal-held-lease:3:start",
    ]);
    expect(tracker.calls).toEqual([]);
  });

  test("a lease-free drive cannot collect a checkpoint or synchronize a delivery", async () => {
    const failing = new FakeIssueTracker({
      failure: { operation: "resolveIssue", retryable: true },
    });
    const { root, adapter, ledger, runtime } = await setup({
      tracker: failing,
      runId: "run-lease-free-drive",
    });
    const handle = await runtime.startWorkflow(config(root));
    await writeFile(
      join(
        root,
        "work",
        handle.runId,
        "checkpoints",
        "review.md",
      ),
      "STATUS: blocked\nBLOCKERS:\n- lease required\n",
      "utf8",
    );
    const healthy = new FakeIssueTracker();
    const observer = new WorkflowRuntime({
      adapter,
      ledger,
      clock: createClock(6_000).now,
      idgen: () => "unused",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: healthy,
    });

    await observer.awaitLane(handle.runId, "review", 1);

    expect(healthy.calls).toEqual([]);
    expect(
      (await ledger.load(handle.runId))?.lanes.review,
    ).toMatchObject({
      semanticState: "unknown",
      blockedAnchor: null,
    });
    expect(
      (await ledger.load(handle.runId))?.deliveries[
        "run-lease-free-drive:3:start"
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

  test("a drive slice reports one blocked comment while its lane remains running", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-blocked-live-"),
    );
    roots.push(root);
    const clock = createClock(8_000);
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
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-blocked-live",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    const checkpointFile = join(
      root,
      "work",
      handle.runId,
      "checkpoints",
      "review.md",
    );
    await mkdir(join(root, "work", handle.runId, "checkpoints"), {
      recursive: true,
    });
    await writeFile(
      checkpointFile,
      `STATUS: blocked
BLOCKERS:
- owner ruling required
NEXT:
- wait in the visible pane
GAPS:
- verification is pending
`,
      "utf8",
    );

    const lane = await runtime.awaitLane(handle.runId, "review", 1);

    const run = await ledger.load(handle.runId);
    const blockedBodies = tracker.calls
      .filter((call) => call.operation === "createComment")
      .map((call) => call.arguments[1] as string)
      .filter((body) => body.includes("is blocked"));
    expect(lane).toMatchObject({ state: "running", timedOut: true });
    expect(run?.finishStatus).toBeNull();
    expect(run?.lanes.review).toMatchObject({
      runtimeState: "running",
      semanticState: "blocked",
      checkpointFile,
    });
    expect(blockedBodies).toHaveLength(1);
    expect(blockedBodies[0]).toContain("**Role:** reviewer");
    expect(blockedBodies[0]).toContain("owner ruling required");
    expect(blockedBodies[0]).toContain("wait in the visible pane");
    expect(blockedBodies[0]).toContain("verification is pending");
    expect(blockedBodies[0]).toContain(
      "**Checkpoint:** `checkpoints/review.md`",
    );
    expect(blockedBodies[0]).toContain(
      "The triage label was moved to `needs-info`.",
    );
    const blockedDelivery = run?.deliveryOrder
      .map((deliveryId) => run.deliveries[deliveryId])
      .find((delivery) => delivery?.kind === "blocked");
    expect(blockedDelivery).toMatchObject({
      state: "delivered",
      labelTransition: "applied",
    });
    expect(
      tracker.calls.filter(
        (call) => call.operation === "compareAndSetTriageLabel",
      ),
    ).toHaveLength(1);
  });

  test("does not collect blocked when a lane exits after checkpoint selection but before commit", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-blocked-commit-race-"),
    );
    roots.push(root);
    const clock = createClock(8_500);
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
    const ledger = new ExitBeforeBlockedCheckpointLedger();
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });
    const runtime = new BoundaryReconcileRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-blocked-commit-race",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    const checkpointFile = join(
      root,
      "work",
      handle.runId,
      "checkpoints",
      "review.md",
    );
    await mkdir(join(root, "work", handle.runId, "checkpoints"), {
      recursive: true,
    });
    await writeFile(
      checkpointFile,
      "STATUS: blocked\nBLOCKERS:\n- owner ruling required\n",
      "utf8",
    );
    tracker.calls.splice(0);

    await runtime.reconcileAtBoundary(handle.runId, "review");

    const run = await ledger.load(handle.runId);
    expect({
      runtimeState: run?.lanes.review?.runtimeState,
      semanticState: run?.lanes.review?.semanticState,
      blockedAnchor: run?.lanes.review?.blockedAnchor,
      checkpointFacts: ledger.events.filter(
        (event) => event.type === "lane_checkpoint",
      ).length,
      createdComments: tracker.calls.filter(
        (call) => call.operation === "createComment",
      ).length,
      labelCompares: tracker.calls.filter(
        (call) => call.operation === "compareAndSetTriageLabel",
      ).length,
    }).toEqual({
      runtimeState: "exited",
      semanticState: "unknown",
      blockedAnchor: null,
      checkpointFacts: 0,
      createdComments: 0,
      labelCompares: 0,
    });
  });

  test("terminal collection upgrades blocked to complete exactly once", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-blocked-complete-"),
    );
    roots.push(root);
    const clock = createClock(9_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [
        {
          laneId: "review",
          exitCode: 0,
          waitMatches: false,
        },
      ],
    });
    const ledger = new RecordingLedger();
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-blocked-complete",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    const checkpointFile = join(
      root,
      "work",
      handle.runId,
      "checkpoints",
      "review.md",
    );
    await writeFile(
      checkpointFile,
      "STATUS: blocked\nBLOCKERS:\n- owner ruling required\n",
      "utf8",
    );
    await runtime.awaitLane(handle.runId, "review", 1);
    await writeFile(
      checkpointFile,
      "STATUS: complete\nBLOCKERS:\n- none\nGAPS:\n- routed onward\n",
      "utf8",
    );
    adapter.finishLane("review");

    await runtime.awaitLane(handle.runId, "review", 1);
    const checkpointCountAfterUpgrade = ledger.events.filter(
      (event) =>
        event.type === "lane_checkpoint" &&
        event.laneId === "review",
    ).length;
    await runtime.awaitLane(handle.runId, "review", 1);

    const run = await ledger.load(handle.runId);
    expect(run?.lanes.review).toMatchObject({
      runtimeState: "exited",
      semanticState: "complete",
      blockedAnchor: {
        blockers: ["owner ruling required"],
      },
    });
    expect(checkpointCountAfterUpgrade).toBe(2);
    expect(
      ledger.events.filter(
        (event) =>
          event.type === "lane_checkpoint" &&
          event.laneId === "review",
      ),
    ).toHaveLength(2);
    expect(
      ledger.events
        .filter(
          (event) =>
            event.type === "lane_checkpoint" &&
            event.laneId === "review",
        )
        .map((event) => event.actor),
    ).toEqual(["agent", "agent"]);
  });

  test("a sibling boundary collects a human-owned lane without driving it", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-human-sibling-"),
    );
    roots.push(root);
    const clock = createClock(9_500);
    const adapter = new CountingAdapter({
      clock,
      lanes: [
        {
          laneId: "human",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
        {
          laneId: "sibling",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
      ],
    });
    const ledger = new InMemoryLedger();
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-human-sibling",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow({
      ...config(root),
      lanes: [
        { laneId: "human", role: "owner-operated", steps: 1 },
        { laneId: "sibling", role: "managed", steps: 1 },
      ],
    });
    await runtime.confirmLaneStarted(handle.runId, "human");
    await runtime.confirmLaneStarted(handle.runId, "sibling");
    await runtime.takeoverLane(handle.runId, "human");
    const checkpointFile = join(
      root,
      "work",
      handle.runId,
      "checkpoints",
      "human.md",
    );
    await mkdir(join(root, "work", handle.runId, "checkpoints"), {
      recursive: true,
    });
    await writeFile(
      checkpointFile,
      "STATUS: blocked\nBLOCKERS:\n- owner input required\n",
      "utf8",
    );

    await runtime.awaitLane(handle.runId, "sibling", 1);

    const run = await ledger.load(handle.runId);
    const humanPane = adapter.paneIdForLane("human");
    expect(run?.lanes.human).toMatchObject({
      runtimeState: "running",
      controlMode: "human_owned",
      semanticState: "blocked",
    });
    expect(adapter.waitedPaneIds).not.toContain(humanPane);
    expect(adapter.interruptedPaneIds).not.toContain(humanPane);
    expect(adapter.focusedPaneId).not.toBe(humanPane);
    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes("Lane `human` is blocked")),
    ).toHaveLength(1);
  });

  test("an all-human-owned run collects only at the next resume tail", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-human-resume-"),
    );
    roots.push(root);
    const clock = createClock(9_750);
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
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });
    const deps: RuntimeDeps = {
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-human-resume",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    };
    const runtime = new WorkflowRuntime(deps);
    const handle = await runtime.startWorkflow(config(root));
    await runtime.confirmLaneStarted(handle.runId, "review");
    await runtime.takeoverLane(handle.runId, "review");
    const checkpointFile = join(
      root,
      "work",
      handle.runId,
      "checkpoints",
      "review.md",
    );
    await mkdir(join(root, "work", handle.runId, "checkpoints"), {
      recursive: true,
    });
    await writeFile(
      checkpointFile,
      "STATUS: blocked\nBLOCKERS:\n- resume-tail owner input\n",
      "utf8",
    );
    const blockedComments = () =>
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes("is blocked"));
    expect(blockedComments()).toHaveLength(0);

    await new WorkflowRuntime({
      ...deps,
      idgen: () => "unused",
    }).resumeWorkflow(handle.runId, 1);

    expect(blockedComments()).toHaveLength(1);
    expect(adapter.waitedPaneIds).toEqual([]);
    expect(adapter.interruptedPaneIds).toEqual([]);
    expect(adapter.focusedPaneId).toBeNull();
    expect((await ledger.load(handle.runId))?.finishStatus).toBeNull();
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

  test("repeated resumes backfill a lost decision confirmation without reposting", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-repeated-resume-"),
    );
    roots.push(root);
    const clock = createClock(17_500);
    const adapter = new CountingAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const ledger = new ArmableConfirmationLossLedger();
    const tracker = new RememberingTracker();
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-repeated-resume",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await runtime.startWorkflow(config(root));
    await runtime.takeoverLane(handle.runId, "review");
    await appendEvent(
      ledger,
      handle.runId,
      "owner_decision_recorded",
      {
        decision: "changes-requested",
        note: "keep the human-owned lane running",
        resultingIssueState: "needs-info",
      },
      { actor: "human" },
    );
    ledger.loseNextConfirmation();

    await runtime.resumeWorkflow(handle.runId, 1);

    const afterFirst = await ledger.load(handle.runId);
    const decision = afterFirst?.decisions[0];
    if (decision === undefined) {
      throw new Error("expected owner decision");
    }
    const deliveryId =
      `${handle.runId}:${decision.sequence}:decision`;
    expect(afterFirst?.finishStatus).toBeNull();
    expect(afterFirst?.deliveries[deliveryId]).toMatchObject({
      state: "failed",
      lastFailure: { retryable: true },
    });

    await runtime.resumeWorkflow(handle.runId, 1);

    const afterSecond = await ledger.load(handle.runId);
    expect(afterSecond?.finishStatus).toBeNull();
    expect(afterSecond?.deliveries[deliveryId]).toMatchObject({
      state: "delivered",
      intents: 2,
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

  test("concurrent lane boundaries create one delivery's comment once", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-concurrent-"),
    );
    roots.push(root);
    const clock = createClock(25_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [
        {
          laneId: "alpha",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
        {
          laneId: "beta",
          exitCode: 0,
          emitSentinel: false,
          waitMatches: false,
        },
      ],
    });
    const ledger = new InMemoryLedger();
    const tracker = new GatedMarkerTracker();
    const boundaries = new Map<string, PromiseWithResolvers<void>>([
      ["alpha", Promise.withResolvers<void>()],
      ["beta", Promise.withResolvers<void>()],
    ]);
    const runtime = new BoundaryReportingRuntime(
      {
        adapter,
        ledger,
        clock: clock.now,
        idgen: () => "run-concurrent-boundaries",
        readResultFile: adapter.readResultFile,
        sleep: async () => {},
        issueTracker: tracker,
      },
      (laneId) => boundaries.get(laneId)?.resolve(),
    );
    const handle = await runtime.startWorkflow({
      ...config(root),
      lanes: [
        { laneId: "alpha", steps: 1 },
        { laneId: "beta", steps: 1 },
      ],
    });
    await runtime.confirmLaneStarted(handle.runId, "alpha");
    await runtime.confirmLaneStarted(handle.runId, "beta");
    // An owner decision recorded mid-run is due at the next boundary of every
    // lane this controller is driving.
    await appendEvent(
      ledger,
      handle.runId,
      "owner_decision_recorded",
      {
        decision: "changes-requested",
        note: "recorded while both lanes are being driven",
        resultingIssueState: "needs-info",
      },
      { actor: "human" },
    );
    tracker.arm();
    tracker.calls.splice(0);

    const alpha = runtime.awaitLane(handle.runId, "alpha", 1);
    await tracker.parkedInMarkerQuery;
    const callsWhileParked = tracker.calls.length;
    const beta = runtime.awaitLane(handle.runId, "beta", 1);
    await boundaries.get("beta")!.promise;
    await settleEventLoop();

    // Beta reached the same boundary while alpha's pass sits between its
    // recorded intent and its comment. Alpha's marker query has not answered
    // yet, so any remote call beta made here would be one made while the
    // marker is guaranteed to be missing.
    expect(tracker.calls).toHaveLength(callsWhileParked);

    tracker.release();
    await Promise.all([alpha, beta]);

    const run = await ledger.load(handle.runId);
    const decision = run?.decisions[0];
    if (decision === undefined) throw new Error("expected owner decision");
    const deliveryId = `${handle.runId}:${decision.sequence}:decision`;
    const posts = tracker.calls.filter(
      (call) => call.operation === "createComment",
    );
    expect(
      posts.map((call) => String(call.arguments[1]).split("\n")[0]),
    ).toEqual([marker(deliveryId)]);
    expect(run?.deliveries[deliveryId]).toMatchObject({
      state: "delivered",
      intents: 1,
    });
  });

  test("a parked reconciliation does not block another run", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-per-run-"),
    );
    roots.push(root);
    const clock = createClock(30_000);
    const adapter = new CountingAdapter({
      clock,
      lanes: [
        { laneId: "alpha", exitCode: 0 },
        { laneId: "beta", exitCode: 0 },
      ],
    });
    const ledger = new InMemoryLedger();
    const tracker = new GatedMarkerTracker();
    const runIds = ["run-parked", "run-free"];
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => runIds.shift() ?? "exhausted",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    tracker.arm();

    const parked = runtime.startWorkflow({
      ...config(root),
      lanes: [{ laneId: "alpha", steps: 1 }],
    });
    await tracker.parkedInMarkerQuery;

    // A second run must reach its own issue while the first run's pass holds
    // an open remote call. Serialization is per run, not global.
    const free = await runtime.startWorkflow({
      ...config(root),
      lanes: [{ laneId: "beta", steps: 1 }],
    });
    expect(
      (await ledger.load(free.runId))?.deliveries["run-free:3:start"],
    ).toMatchObject({ state: "delivered" });

    tracker.release();
    const blocked = await parked;
    expect(
      (await ledger.load(blocked.runId))?.deliveries["run-parked:3:start"],
    ).toMatchObject({ state: "delivered" });
  });
});
