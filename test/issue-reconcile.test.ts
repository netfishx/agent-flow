import { describe, expect, test } from "bun:test";
import {
  FakeIssueTracker,
  InMemoryLedger,
} from "../src/testing.ts";
import {
  canonicalPayloadHash,
  dueMilestones,
  marker,
  parseCheckpoint,
  IssueTrackerError,
  type CommentRef,
  type IssueRef,
  type RunEvent,
  type RunEventActor,
  type RunEventDataByType,
  type RunEventType,
  type RunView,
} from "../src/index.ts";
import {
  collectBlockedCheckpoint,
  reconcileIssueSync,
  type ReconcileEvent,
} from "../src/issue/reconcile.ts";

class TimeoutAfterAppliedTracker extends FakeIssueTracker {
  private applied:
    | {
        readonly marker: string;
        readonly comment: CommentRef;
      }
    | null = null;
  private timedOut = false;

  override async findCommentByMarker(
    ref: IssueRef,
    markerValue: string,
  ): Promise<CommentRef | null> {
    const configured = await super.findCommentByMarker(ref, markerValue);
    if (configured !== null) return configured;
    return this.applied?.marker === markerValue
      ? this.applied.comment
      : null;
  }

  override async createComment(
    ref: IssueRef,
    body: string,
  ): Promise<CommentRef> {
    const comment = await super.createComment(ref, body);
    if (!this.timedOut) {
      this.timedOut = true;
      this.applied = {
        marker: body.split("\n")[0]!,
        comment,
      };
      throw new IssueTrackerError("timeout after remote apply", true);
    }
    return comment;
  }
}

class FailCommentOnceTracker extends FakeIssueTracker {
  successfulComments = 0;
  private failed = false;

  override async createComment(
    ref: IssueRef,
    body: string,
  ): Promise<CommentRef> {
    if (!this.failed) {
      this.failed = true;
      this.calls.push({
        operation: "createComment",
        arguments: [ref, body],
      });
      throw new IssueTrackerError("comment unavailable", true);
    }
    const comment = await super.createComment(ref, body);
    this.successfulComments++;
    return comment;
  }
}

class DuplicateMarkerTracker extends FakeIssueTracker {
  override async findCommentByMarker(
    ref: IssueRef,
    markerValue: string,
  ): Promise<CommentRef | null> {
    await super.findCommentByMarker(ref, markerValue);
    throw new IssueTrackerError("duplicate marker condition", false);
  }
}

const runId = "run-reconcile";
const issue: IssueRef = {
  owner: "netfishx",
  repo: "agent-flow",
  number: 27,
};

class RunBuilder {
  readonly ledger = new InMemoryLedger();
  #sequence = 0;

  private constructor() {}

  static async create(bound = true): Promise<RunBuilder> {
    const builder = new RunBuilder();
    await builder.append("run_started", {
      workflow: "cross-review",
      workspace: "agent-flow",
      cwd: "/tmp/agent-flow-reconcile",
      splitDirection: "down",
      tabId: "tab",
      controllerPaneId: "controller",
      fixedPoint: null,
      issue: bound ? issue : null,
    });
    return builder;
  }

  async append<T extends RunEventType>(
    type: T,
    data: RunEventDataByType[T],
    options: {
      readonly laneId?: string;
      readonly actor?: RunEventActor;
    } = {},
  ): Promise<void> {
    const sequence = ++this.#sequence;
    await this.ledger.commit({
      schemaVersion: 1,
      eventId: `${runId}#${sequence}`,
      runId,
      ...(options.laneId === undefined
        ? {}
        : { laneId: options.laneId }),
      sequence,
      type,
      at: sequence * 100,
      actor: options.actor ?? "runtime",
      controllerEpoch: 0,
      data,
    } as RunEvent);
  }

  async appendIssueEvent(
    event: ReconcileEvent,
  ): Promise<void> {
    if (event.type === "lane_checkpoint") {
      await this.append(event.type, event.data, {
        laneId: event.laneId,
        actor: "agent",
      });
      return;
    }
    await this.append(event.type, event.data);
  }

  async registerAndDispatch(): Promise<void> {
    await this.append(
      "lane_registered",
      {
        laneId: "review",
        role: "reviewer",
        paneId: "pane",
        logFile: "/tmp/review.log",
        stderrFile: "/tmp/review.stderr",
        sentinelToken: "FLOW_REVIEW",
        steps: 1,
        stepDelaySeconds: 0,
      },
      { laneId: "review" },
    );
    await this.append("lane_dispatch_intent", {}, { laneId: "review" });
  }

  async settleStart(): Promise<void> {
    const [start] = dueMilestones(await this.view());
    if (start === undefined || start.kind !== "start") {
      throw new Error("expected start milestone");
    }
    await this.append("issue_delivery_intended", {
      deliveryId: start.deliveryId,
      kind: start.kind,
      laneId: start.laneId,
      payloadHash: canonicalPayloadHash(start.payload),
    });
    await this.append("issue_binding_resolved", {
      issueNodeId: "fake-issue-node",
    });
    await this.append("issue_delivery_confirmed", {
      deliveryId: start.deliveryId,
      commentId: 10,
      commentUrl: "https://example.invalid/comment/10",
      labelTransition: "not-applicable",
    });
  }

  async blockLane(): Promise<void> {
    await this.append(
      "lane_checkpoint",
      {
        semanticState: "blocked",
        checkpointFile:
          "/tmp/agent-flow-reconcile/run-reconcile/checkpoints/review.md",
        blockers: ["owner decision required"],
        next: ["wait for owner"],
        gaps: ["not verified"],
      },
      { laneId: "review", actor: "agent" },
    );
  }

  async view(): Promise<RunView> {
    const view = await this.ledger.load(runId);
    if (view === null) throw new Error("expected run");
    return view;
  }
}

describe("reconcileIssueSync", () => {
  test("selects a blocked checkpoint fact for a non-terminal lane", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();

    expect(
      collectBlockedCheckpoint(
        await builder.view(),
        "review",
        parseCheckpoint(`STATUS: blocked
BLOCKERS:
- owner decision required
NEXT:
- wait for owner
GAPS:
- not verified
`),
      ),
    ).toEqual({
      type: "lane_checkpoint",
      laneId: "review",
      data: {
        semanticState: "blocked",
        checkpointFile:
          "/tmp/agent-flow-reconcile/run-reconcile/checkpoints/review.md",
        blockers: ["owner decision required"],
        next: ["wait for owner"],
        gaps: ["not verified"],
      },
    });
  });

  test("skips an unchanged blocked checkpoint re-read", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.blockLane();

    expect(
      collectBlockedCheckpoint(
        await builder.view(),
        "review",
        parseCheckpoint(`STATUS: blocked
BLOCKERS:
- owner decision required
NEXT:
- wait for owner
GAPS:
- not verified
`),
      ),
    ).toBeNull();
  });

  test("selects changed blocked lines once and skips their next identical re-read", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.blockLane();
    const changed = parseCheckpoint(`STATUS: blocked
BLOCKERS:
- a newer owner decision
NEXT:
- wait for the newer ruling
GAPS:
- still not verified
`);
    const event = collectBlockedCheckpoint(
      await builder.view(),
      "review",
      changed,
    );
    expect(event).not.toBeNull();
    await builder.appendIssueEvent(event!);

    expect(
      collectBlockedCheckpoint(await builder.view(), "review", changed),
    ).toBeNull();
  });

  test("skips blocked checkpoint collection for a terminal lane", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.append(
      "lane_exited",
      { exitCode: 0 },
      { laneId: "review" },
    );

    expect(
      collectBlockedCheckpoint(
        await builder.view(),
        "review",
        parseCheckpoint("STATUS: blocked\nBLOCKERS:\n- too late\n"),
      ),
    ).toBeNull();
  });

  test.each(["complete", "partial"] as const)(
    "leaves mid-flight %s collection to the terminal path",
    async (status) => {
      const builder = await RunBuilder.create();
      await builder.registerAndDispatch();

      expect(
        collectBlockedCheckpoint(
          await builder.view(),
          "review",
          parseCheckpoint(`STATUS: ${status}\nBLOCKERS:\n- none\n`),
        ),
      ).toBeNull();
    },
  );

  test("collects and delivers a blocked checkpoint in the same reconciliation pass", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.settleStart();
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      readLaneCheckpoint: async (laneId) =>
        laneId === "review"
          ? `STATUS: blocked
BLOCKERS:
- owner decision required
NEXT:
- wait for owner
GAPS:
- not verified
`
          : null,
      tracker,
    });

    expect((await builder.view()).lanes.review).toMatchObject({
      semanticState: "blocked",
      blockedAnchor: {
        blockers: ["owner decision required"],
        next: ["wait for owner"],
        gaps: ["not verified"],
      },
    });
    expect(summary.deliveries).toEqual([
      {
        deliveryId: "run-reconcile:7:blocked:review",
        kind: "blocked",
        outcome: "posted",
      },
    ]);
    expect(
      tracker.calls.filter(
        (call) => call.operation === "compareAndSetTriageLabel",
      ),
    ).toHaveLength(1);
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(1);
  });

  test.each([
    ["absent", async (): Promise<string | null> => null],
    [
      "unreadable",
      async (): Promise<string | null> => {
        throw new Error("checkpoint permission denied");
      },
    ],
    [
      "unparseable",
      async (): Promise<string | null> =>
        "Status: blocked\nBLOCKERS:\n- ignored\n",
    ],
    [
      "working heartbeat",
      async (): Promise<string | null> =>
        "STATUS: working\nBLOCKERS:\n- none\n",
    ],
  ] as const)(
    "%s checkpoint collection creates no fact, delivery, or delivery failure",
    async (_case, readLaneCheckpoint) => {
      const builder = await RunBuilder.create();
      await builder.registerAndDispatch();
      await builder.settleStart();
      const before = await builder.view();
      const tracker = new FakeIssueTracker();

      const summary = await reconcileIssueSync({
        loadRun: () => builder.view(),
        appendEvent: (event) => builder.appendIssueEvent(event),
        readLaneCheckpoint,
        tracker,
      });

      const after = await builder.view();
      expect(after.lastAppliedSequence).toBe(before.lastAppliedSequence);
      expect(after.lanes.review?.semanticState).toBe("unknown");
      expect(after.deliveryOrder).toEqual(before.deliveryOrder);
      expect(summary).toEqual({
        deliveries: [],
        planningFailure: null,
      });
      expect(tracker.calls).toEqual([]);
    },
  );

  test("blocked to working to blocked posts once and records only changed blocked lines", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.settleStart();
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
    });
    let checkpoint =
      "STATUS: blocked\nBLOCKERS:\n- first owner ruling\n";
    const deps = {
      loadRun: () => builder.view(),
      appendEvent: (event: ReconcileEvent) =>
        builder.appendIssueEvent(event),
      readLaneCheckpoint: async () => checkpoint,
      tracker,
    };

    await reconcileIssueSync(deps);
    checkpoint = "STATUS: working\nBLOCKERS:\n- none\n";
    const beforeHeartbeat = (await builder.view()).lastAppliedSequence;
    await reconcileIssueSync(deps);
    expect((await builder.view()).lastAppliedSequence).toBe(
      beforeHeartbeat,
    );
    checkpoint =
      "STATUS: blocked\nBLOCKERS:\n- second owner ruling\n";
    await reconcileIssueSync(deps);
    const afterChangedBlock = (await builder.view()).lastAppliedSequence;
    await reconcileIssueSync(deps);

    expect((await builder.view()).lastAppliedSequence).toBe(
      afterChangedBlock,
    );
    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.includes("is blocked")),
    ).toHaveLength(1);
    expect(
      tracker.calls.filter(
        (call) => call.operation === "compareAndSetTriageLabel",
      ),
    ).toHaveLength(1);
  });

  test("posts and confirms an absent start delivery", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const tracker = new FakeIssueTracker();

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    const run = await builder.view();
    expect(summary).toEqual({
      deliveries: [
        {
          deliveryId: "run-reconcile:3:start",
          kind: "start",
          outcome: "posted",
        },
      ],
      planningFailure: null,
    });
    expect(run.issueNodeId).toBe("fake-issue-node");
    expect(run.deliveries["run-reconcile:3:start"]).toMatchObject({
      state: "delivered",
      intents: 1,
      commentId: 1,
      labelTransition: "not-applicable",
    });
    expect(
      tracker.calls.map((call) => call.operation),
    ).toEqual([
      "resolveIssue",
      "findCommentByMarker",
      "createComment",
    ]);
  });

  test("resumes a crash after intent by querying the marker before posting", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const [start] = dueMilestones(await builder.view());
    if (start === undefined) throw new Error("expected start milestone");
    await builder.append("issue_delivery_intended", {
      deliveryId: start.deliveryId,
      kind: start.kind,
      laneId: start.laneId,
      payloadHash: canonicalPayloadHash(start.payload),
    });
    const tracker = new FakeIssueTracker();

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(summary.deliveries).toEqual([
      {
        deliveryId: "run-reconcile:3:start",
        kind: "start",
        outcome: "posted",
      },
    ]);
    expect(
      (await builder.view()).deliveries["run-reconcile:3:start"],
    ).toMatchObject({
      state: "delivered",
      intents: 1,
    });
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(1);
  });

  test("backfills a remote comment after confirmation was lost", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const [start] = dueMilestones(await builder.view());
    if (start === undefined) throw new Error("expected start milestone");
    await builder.append("issue_delivery_intended", {
      deliveryId: start.deliveryId,
      kind: start.kind,
      laneId: start.laneId,
      payloadHash: canonicalPayloadHash(start.payload),
    });
    const tracker = new FakeIssueTracker({
      markerHit: {
        body: `${marker(start.deliveryId)}\n\nexisting delivery`,
        comment: {
          commentId: 88,
          commentUrl: "https://example.invalid/comment/88",
        },
      },
      labels: ["ready-for-agent"],
    });

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(summary.deliveries).toEqual([
      {
        deliveryId: start.deliveryId,
        kind: "start",
        outcome: "backfilled",
      },
    ]);
    expect((await builder.view()).deliveries[start.deliveryId]).toMatchObject({
      state: "delivered",
      intents: 1,
      commentId: 88,
      commentUrl: "https://example.invalid/comment/88",
      labelTransition: "not-applicable",
    });
    expect(
      tracker.calls.map((call) => call.operation),
    ).toEqual(["resolveIssue", "findCommentByMarker", "readCurrentLabels"]);
  });

  test.each([
    [["needs-info"], "applied"],
    [["ready-for-human"], "skipped"],
  ] as const)(
    "backfills a blocked delivery with label transition %s",
    async (labels, expectedTransition) => {
      const builder = await RunBuilder.create();
      await builder.registerAndDispatch();
      await builder.settleStart();
      await builder.blockLane();
      const [blocked] = dueMilestones(await builder.view());
      if (blocked === undefined || blocked.kind !== "blocked") {
        throw new Error("expected blocked milestone");
      }
      const tracker = new FakeIssueTracker({
        markerHit: {
          body: `${marker(blocked.deliveryId)}\n\nexisting delivery`,
          comment: {
            commentId: 89,
            commentUrl: "https://example.invalid/comment/89",
          },
        },
        labels,
      });

      await reconcileIssueSync({
        loadRun: () => builder.view(),
        appendEvent: (event) => builder.appendIssueEvent(event),
        tracker,
      });

      expect(
        (await builder.view()).deliveries[blocked.deliveryId],
      ).toMatchObject({
        state: "delivered",
        commentId: 89,
        labelTransition: expectedTransition,
      });
    },
  );

  test.each([true, false])(
    "records resolve failure with retryable=%s and never throws",
    async (retryable) => {
      const builder = await RunBuilder.create();
      await builder.registerAndDispatch();
      const tracker = new FakeIssueTracker({
        failure: { operation: "resolveIssue", retryable },
      });

      const summary = await reconcileIssueSync({
        loadRun: () => builder.view(),
        appendEvent: (event) => builder.appendIssueEvent(event),
        tracker,
      });

      const delivery =
        (await builder.view()).deliveries["run-reconcile:3:start"];
      expect(summary.deliveries).toEqual([
        {
          deliveryId: "run-reconcile:3:start",
          kind: "start",
          outcome: "failed",
          reason: "fake issue tracker resolveIssue failure",
          retryable,
        },
      ]);
      expect(delivery).toMatchObject({
        state: "failed",
        lastFailure: {
          reason: "fake issue tracker resolveIssue failure",
          retryable,
        },
      });
      expect(
        dueMilestones(await builder.view()).some(
          (milestone) =>
            milestone.deliveryId === "run-reconcile:3:start",
        ),
      ).toBe(retryable);
    },
  );

  test("fails a payload hash conflict closed and names both hashes", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const [start] = dueMilestones(await builder.view());
    if (start === undefined) throw new Error("expected start milestone");
    const currentHash = canonicalPayloadHash(start.payload);
    const recordedHash = "a".repeat(64);
    await builder.append("issue_delivery_intended", {
      deliveryId: start.deliveryId,
      kind: start.kind,
      laneId: start.laneId,
      payloadHash: recordedHash,
    });
    const tracker = new FakeIssueTracker();

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    const delivery = (await builder.view()).deliveries[start.deliveryId];
    expect(summary.deliveries).toEqual([
      {
        deliveryId: start.deliveryId,
        kind: "start",
        outcome: "failed",
        reason: `payload hash conflict for delivery "${start.deliveryId}": recorded ${recordedHash}, computed ${currentHash}`,
        retryable: false,
      },
    ]);
    expect(delivery).toMatchObject({
      state: "failed",
      lastFailure: {
        retryable: false,
      },
    });
    expect(delivery?.lastFailure?.reason).toContain(recordedHash);
    expect(delivery?.lastFailure?.reason).toContain(currentHash);
    expect(tracker.calls).toEqual([]);
    expect(
      dueMilestones(await builder.view()).some(
        (milestone) => milestone.deliveryId === start.deliveryId,
      ),
    ).toBe(false);
  });

  test("closes a retryable failed delivery when its payload hash conflicts", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const [start] = dueMilestones(await builder.view());
    if (start === undefined) throw new Error("expected start milestone");
    const currentHash = canonicalPayloadHash(start.payload);
    const recordedHash = "b".repeat(64);
    await builder.append("issue_delivery_intended", {
      deliveryId: start.deliveryId,
      kind: start.kind,
      laneId: start.laneId,
      payloadHash: recordedHash,
    });
    await builder.append("issue_delivery_failed", {
      deliveryId: start.deliveryId,
      reason: "temporary outage",
      retryable: true,
    });
    const tracker = new FakeIssueTracker();

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    const delivery = (await builder.view()).deliveries[start.deliveryId];
    expect(summary.deliveries).toEqual([
      {
        deliveryId: start.deliveryId,
        kind: "start",
        outcome: "failed",
        reason: `payload hash conflict for delivery "${start.deliveryId}": recorded ${recordedHash}, computed ${currentHash}`,
        retryable: false,
      },
    ]);
    expect(delivery).toMatchObject({
      state: "failed",
      intents: 2,
      lastFailure: {
        retryable: false,
      },
    });
    expect(tracker.calls).toEqual([]);
    expect(
      dueMilestones(await builder.view()).some(
        (milestone) => milestone.deliveryId === start.deliveryId,
      ),
    ).toBe(false);
  });

  test("contains an unusable complete artifact pointer before any delivery attempt", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.append(
      "lane_exited",
      { exitCode: 0 },
      { laneId: "review" },
    );
    await builder.append("run_finished", {
      status: "clean",
      breakdown: {
        exitedZero: 1,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    });
    await builder.append(
      "lane_contract_evaluated",
      {
        contractState: "satisfied",
        resultFile: "/outside/run/result.txt",
        errors: [],
      },
      { laneId: "review", actor: "validator" },
    );
    await builder.append(
      "lane_verification_recorded",
      {
        verificationState: "verified",
        evidenceFile: "/outside/run/evidence.json",
      },
      { laneId: "review", actor: "runner" },
    );
    const tracker = new FakeIssueTracker();

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(summary).toEqual({
      deliveries: [],
      planningFailure: {
        reason: 'resultPointer for lane "review" is outside the run directory',
      },
    });
    expect(tracker.calls).toEqual([]);
    expect((await builder.view()).deliveryOrder).toEqual([]);
  });

  test("backfills after a retryable timeout that applied the remote comment", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const tracker = new TimeoutAfterAppliedTracker();
    const deps = {
      loadRun: () => builder.view(),
      appendEvent: (event: ReconcileEvent) =>
        builder.appendIssueEvent(event),
      tracker,
    };

    const first = await reconcileIssueSync(deps);
    const second = await reconcileIssueSync(deps);
    const third = await reconcileIssueSync(deps);

    expect(first.deliveries[0]).toMatchObject({
      outcome: "failed",
      reason: "timeout after remote apply",
      retryable: true,
    });
    expect(second.deliveries[0]).toMatchObject({
      outcome: "backfilled",
    });
    expect(third.deliveries).toEqual([]);
    expect(
      (await builder.view()).deliveries["run-reconcile:3:start"],
    ).toMatchObject({
      state: "delivered",
      intents: 2,
      commentId: 1,
    });
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(1);
  });

  test("records a duplicate marker condition as terminal and never posts", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const tracker = new DuplicateMarkerTracker();

    const first = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });
    const second = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(first.deliveries[0]).toMatchObject({
      outcome: "failed",
      reason: "duplicate marker condition",
      retryable: false,
    });
    expect(second.deliveries).toEqual([]);
    expect(
      (await builder.view()).deliveries["run-reconcile:3:start"],
    ).toMatchObject({
      state: "failed",
      lastFailure: { retryable: false },
    });
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(0);
  });

  test("recovers when the blocked label applied before comment creation failed", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.settleStart();
    await builder.blockLane();
    const tracker = new FailCommentOnceTracker({
      labels: ["ready-for-agent"],
    });
    const deps = {
      loadRun: () => builder.view(),
      appendEvent: (event: ReconcileEvent) =>
        builder.appendIssueEvent(event),
      tracker,
    };

    const first = await reconcileIssueSync(deps);
    expect(first.deliveries[0]).toMatchObject({
      kind: "blocked",
      outcome: "failed",
      retryable: true,
    });
    expect(await tracker.readCurrentLabels(issue)).toEqual(["needs-info"]);

    const second = await reconcileIssueSync(deps);
    const blockedId = (await builder.view()).deliveryOrder.at(-1)!;
    expect(second.deliveries[0]).toMatchObject({
      deliveryId: blockedId,
      kind: "blocked",
      outcome: "posted",
    });
    expect((await builder.view()).deliveries[blockedId]).toMatchObject({
      state: "delivered",
      intents: 2,
      labelTransition: "skipped",
    });
    expect(tracker.successfulComments).toBe(1);
    expect(await tracker.readCurrentLabels(issue)).toEqual(["needs-info"]);
  });

  test("records a label-read failure on the marker backfill path", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    const [start] = dueMilestones(await builder.view());
    if (start === undefined) throw new Error("expected start milestone");
    const tracker = new FakeIssueTracker({
      markerHit: {
        body: `${marker(start.deliveryId)}\n\nexisting`,
        comment: {
          commentId: 77,
          commentUrl: "https://example.invalid/comment/77",
        },
      },
      failure: {
        operation: "readCurrentLabels",
        retryable: true,
      },
    });

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(summary.deliveries[0]).toMatchObject({
      outcome: "failed",
      reason: "fake issue tracker readCurrentLabels failure",
      retryable: true,
    });
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(0);
  });

  test("records a blocked label compare-and-set failure without posting", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.settleStart();
    await builder.blockLane();
    const tracker = new FakeIssueTracker({
      labels: ["ready-for-agent"],
      failure: {
        operation: "compareAndSetTriageLabel",
        retryable: false,
      },
    });

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(summary.deliveries[0]).toMatchObject({
      kind: "blocked",
      outcome: "failed",
      reason:
        "fake issue tracker compareAndSetTriageLabel failure",
      retryable: false,
    });
    expect(
      tracker.calls.filter((call) => call.operation === "createComment"),
    ).toHaveLength(0);
  });

  test("a failure attempts each due delivery once and continues to the next", async () => {
    const builder = await RunBuilder.create();
    await builder.registerAndDispatch();
    await builder.blockLane();
    const tracker = new FakeIssueTracker({
      failure: { operation: "resolveIssue", retryable: true },
    });

    const summary = await reconcileIssueSync({
      loadRun: () => builder.view(),
      appendEvent: (event) => builder.appendIssueEvent(event),
      tracker,
    });

    expect(summary.deliveries).toHaveLength(2);
    expect(
      summary.deliveries.map((delivery) => delivery.outcome),
    ).toEqual(["failed", "failed"]);
    expect(
      tracker.calls.filter((call) => call.operation === "resolveIssue"),
    ).toHaveLength(2);
    expect(
      Object.values((await builder.view()).deliveries).map(
        (delivery) => delivery.intents,
      ),
    ).toEqual([1, 1]);
  });
});
