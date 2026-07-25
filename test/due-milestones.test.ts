import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  canonicalPayloadHash,
  dueMilestones,
  InMemoryLedger,
  type IssueRef,
  type RunEvent,
  type RunEventActor,
  type RunEventDataByType,
  type RunEventType,
  type RunView,
} from "../src/index.ts";

const runId = "run-due";
const cwd = "/tmp/agent-flow-public";
const runDirectory = join(cwd, runId);
const issue: IssueRef = {
  owner: "netfishx",
  repo: "agent-flow",
  number: 25,
};

class RunBuilder {
  readonly ledger = new InMemoryLedger();
  #sequence = 0;

  private constructor() {}

  static async create(bound = true): Promise<RunBuilder> {
    const builder = new RunBuilder();
    await builder.append("run_started", {
      workflow: "cross-review",
      workspace: "private-workspace",
      cwd,
      splitDirection: "down",
      tabId: "secret-tab",
      controllerPaneId: "secret-controller-pane",
      fixedPoint: {
        repoRoot: "/secret/repository",
        baseCommit: "base",
        headCommit: "head",
        diffHash: "diff",
        dirtyStatePolicy: "reject",
        capturedAt: 123_456,
      },
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

  async register(laneId: string, role?: string): Promise<void> {
    await this.append(
      "lane_registered",
      {
        laneId,
        paneId: `secret-tab:${laneId}`,
        logFile: `/secret/${laneId}.log`,
        stderrFile: `/secret/${laneId}.stderr`,
        sentinelToken: `FLOW_secret_${laneId}`,
        steps: 1,
        stepDelaySeconds: 0,
        ...(role === undefined ? {} : { role }),
      },
      { laneId },
    );
  }

  async view(): Promise<RunView> {
    const view = await this.ledger.load(runId);
    if (view === null) throw new Error("expected reconstructed run");
    return view;
  }
}

async function appendBlockedLane(
  builder: RunBuilder,
  laneId = "lane-1",
  pointer = join(runDirectory, "checkpoints", `${laneId}.md`),
): Promise<void> {
  await builder.register(laneId, "reviewer");
  await builder.append("lane_dispatch_intent", {}, { laneId });
  await builder.append(
    "lane_checkpoint",
    {
      semanticState: "blocked",
      checkpointFile: pointer,
      blockers: ["owner decision required"],
      next: ["record the decision"],
      gaps: ["verification pending"],
    },
    { laneId, actor: "agent" },
  );
}

async function settleDelivery(
  builder: RunBuilder,
  deliveryId: string,
  state: "pending" | "delivered" | "retryable-failure" | "terminal-failure",
  kind: "start" | "blocked" = "blocked",
): Promise<void> {
  await builder.append("issue_delivery_intended", {
    deliveryId,
    kind,
    laneId: kind === "blocked" ? "lane-1" : null,
    payloadHash: "recorded-hash",
  });
  if (state === "pending") return;
  if (state === "delivered") {
    await builder.append("issue_delivery_confirmed", {
      deliveryId,
      commentId: 25,
      commentUrl: "https://example.invalid/comment",
      labelTransition: "applied",
    });
    return;
  }
  await builder.append("issue_delivery_failed", {
    deliveryId,
    reason: "tracker unavailable",
    retryable: state === "retryable-failure",
  });
}

describe("dueMilestones", () => {
  test("an unbound run is silent and start becomes due only at the first dispatch intent", async () => {
    const unbound = await RunBuilder.create(false);
    await unbound.register("lane-1");
    await unbound.append("lane_dispatch_intent", {}, { laneId: "lane-1" });
    expect(dueMilestones(await unbound.view())).toEqual([]);

    const bound = await RunBuilder.create();
    await bound.register("lane-1");
    expect(dueMilestones(await bound.view())).toEqual([]);

    await bound.append("lane_dispatch_intent", {}, { laneId: "lane-1" });
    expect(dueMilestones(await bound.view())).toEqual([
      {
        kind: "start",
        deliveryId: "run-due:3:start",
        laneId: null,
        payload: {
          hashVersion: 1,
          runId,
          workflow: "cross-review",
          lanes: [{ laneId: "lane-1", role: null }],
          fixedPoint: {
            baseCommit: "base",
            headCommit: "head",
            diffHash: "diff",
            dirtyStatePolicy: "reject",
          },
        },
      },
    ]);
  });

  test.each([
    ["absent", null, true],
    ["pending", "pending", true],
    ["delivered", "delivered", false],
    ["failed and retryable", "retryable-failure", true],
    ["failed and non-retryable", "terminal-failure", false],
  ] as const)(
    "a blocked delivery that is %s obeys the due gate",
    async (_name, deliveryState, expectedDue) => {
      const builder = await RunBuilder.create();
      await appendBlockedLane(builder);
      const blockedId = "run-due:4:blocked:lane-1";
      if (deliveryState !== null) {
        await settleDelivery(builder, blockedId, deliveryState);
      }

      expect(
        dueMilestones(await builder.view()).some(
          (milestone) => milestone.deliveryId === blockedId,
        ),
      ).toBe(expectedDue);
    },
  );

  test("a lane has one blocked milestone anchored to its first blocked checkpoint", async () => {
    const builder = await RunBuilder.create();
    await appendBlockedLane(builder);
    await builder.append(
      "lane_checkpoint",
      {
        semanticState: "working",
        checkpointFile: join(runDirectory, "checkpoints", "working.md"),
      },
      { laneId: "lane-1", actor: "agent" },
    );
    await builder.append(
      "lane_checkpoint",
      {
        semanticState: "blocked",
        checkpointFile: join(runDirectory, "checkpoints", "later.md"),
        blockers: ["different blocker"],
      },
      { laneId: "lane-1", actor: "agent" },
    );

    const blocked = dueMilestones(await builder.view()).filter(
      (milestone) => milestone.kind === "blocked",
    );
    expect(blocked).toEqual([
      {
        kind: "blocked",
        deliveryId: "run-due:4:blocked:lane-1",
        laneId: "lane-1",
        payload: {
          hashVersion: 1,
          runId,
          laneId: "lane-1",
          role: "reviewer",
          blockers: ["owner decision required"],
          next: ["record the decision"],
          gaps: ["verification pending"],
          checkpointPointer: "checkpoints/lane-1.md",
        },
      },
    ]);
  });

  test("payload identity retains true text while publication redaction stays downstream", async () => {
    const blockedPayloadFor = async (blocker: string) => {
      const builder = await RunBuilder.create();
      await builder.register("lane-1", "reviewer");
      await builder.append("lane_dispatch_intent", {}, { laneId: "lane-1" });
      await builder.append(
        "lane_checkpoint",
        {
          semanticState: "blocked",
          checkpointFile: join(
            runDirectory,
            "checkpoints",
            "lane-1.md",
          ),
          blockers: [blocker],
          next: ["inspect /Users/owner/next.txt"],
          gaps: ["missing /Users/owner/gap.txt"],
        },
        { laneId: "lane-1", actor: "agent" },
      );
      const milestone = dueMilestones(await builder.view()).find(
        (candidate) => candidate.kind === "blocked",
      );
      if (milestone?.kind !== "blocked") {
        throw new Error("expected blocked milestone");
      }
      return milestone.payload;
    };

    const alice = await blockedPayloadFor(
      "cannot read /Users/alice/one.txt",
    );
    const bob = await blockedPayloadFor("cannot read /Users/bob/two.txt");

    expect(alice.blockers).toEqual(["cannot read /Users/alice/one.txt"]);
    expect(alice.next).toEqual(["inspect /Users/owner/next.txt"]);
    expect(alice.gaps).toEqual(["missing /Users/owner/gap.txt"]);
    expect(canonicalPayloadHash(alice)).not.toBe(canonicalPayloadHash(bob));
  });

  test("orders start, blocked lanes by laneOrder, complete, then decisions by anchor", async () => {
    const builder = await RunBuilder.create();
    await builder.register("alpha", "standards");
    await builder.register("beta");
    await builder.append("lane_dispatch_intent", {}, { laneId: "beta" });
    await builder.append("lane_dispatch_intent", {}, { laneId: "alpha" });
    await builder.append(
      "lane_checkpoint",
      {
        semanticState: "blocked",
        checkpointFile: join(runDirectory, "checkpoints", "beta.md"),
      },
      { laneId: "beta", actor: "agent" },
    );
    await builder.append(
      "lane_checkpoint",
      {
        semanticState: "blocked",
        checkpointFile: join(runDirectory, "checkpoints", "alpha.md"),
      },
      { laneId: "alpha", actor: "agent" },
    );
    await builder.append(
      "owner_decision_recorded",
      {
        decision: "rejected",
        note: "First decision.",
        resultingIssueState: "ready-for-agent",
      },
      { actor: "human" },
    );
    for (const laneId of ["alpha", "beta"]) {
      await builder.append(
        "lane_checkpoint",
        {
          semanticState: "complete",
          checkpointFile: join(runDirectory, "checkpoints", `${laneId}.md`),
        },
        { laneId, actor: "agent" },
      );
      await builder.append(
        "lane_exited",
        { exitCode: 0, waitMatched: true },
        { laneId },
      );
    }
    await builder.append("run_finished", {
      status: "clean",
      breakdown: {
        exitedZero: 2,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    });
    for (const laneId of ["alpha", "beta"]) {
      await builder.append(
        "lane_contract_evaluated",
        {
          contractState: "satisfied",
          resultFile: join(runDirectory, "results", `${laneId}.txt`),
          errors: [],
        },
        { laneId, actor: "validator" },
      );
      await builder.append(
        "lane_verification_recorded",
        {
          verificationState: "verified",
          evidenceFile: join(runDirectory, "evidence", `${laneId}.json`),
        },
        { laneId, actor: "runner" },
      );
    }
    await builder.append(
      "owner_decision_recorded",
      {
        decision: "accepted",
        note: "Second decision.",
        resultingIssueState: "ready-for-human",
      },
      { actor: "human" },
    );

    expect(
      dueMilestones(await builder.view()).map(
        ({ kind, laneId, deliveryId }) => ({ kind, laneId, deliveryId }),
      ),
    ).toEqual([
      { kind: "start", laneId: null, deliveryId: "run-due:4:start" },
      {
        kind: "blocked",
        laneId: "alpha",
        deliveryId: "run-due:7:blocked:alpha",
      },
      {
        kind: "blocked",
        laneId: "beta",
        deliveryId: "run-due:6:blocked:beta",
      },
      { kind: "complete", laneId: null, deliveryId: "run-due:13:complete" },
      { kind: "decision", laneId: null, deliveryId: "run-due:8:decision" },
      { kind: "decision", laneId: null, deliveryId: "run-due:18:decision" },
    ]);
  });

  test("complete waits for all terminal facts and then remains hash-stable", async () => {
    const builder = await RunBuilder.create();
    await builder.register("lane-1", "reviewer");
    await builder.append("lane_dispatch_intent", {}, { laneId: "lane-1" });
    await builder.append(
      "lane_checkpoint",
      {
        semanticState: "complete",
        checkpointFile: join(runDirectory, "checkpoints", "lane-1.md"),
      },
      { laneId: "lane-1", actor: "agent" },
    );
    await builder.append(
      "lane_exited",
      { exitCode: 0, waitMatched: true },
      { laneId: "lane-1" },
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
    expect(
      dueMilestones(await builder.view()).some(({ kind }) => kind === "complete"),
    ).toBeFalse();

    await builder.append(
      "lane_contract_evaluated",
      {
        contractState: "satisfied",
        resultFile: join(runDirectory, "results", "lane-1.txt"),
        errors: [],
      },
      { laneId: "lane-1", actor: "validator" },
    );
    expect(
      dueMilestones(await builder.view()).some(({ kind }) => kind === "complete"),
    ).toBeFalse();

    await builder.append(
      "lane_verification_recorded",
      {
        verificationState: "verified",
        evidenceFile: join(runDirectory, "evidence", "lane-1.json"),
      },
      { laneId: "lane-1", actor: "runner" },
    );
    const first = dueMilestones(await builder.view()).find(
      (milestone) => milestone.kind === "complete",
    );
    expect(first).toBeDefined();
    expect(first!.payload.lanes[0]!.gaps).toEqual([]);
    const firstHash = canonicalPayloadHash(first!.payload);

    await builder.append(
      "controller_attached",
      { controllerId: "private-controller", epoch: 1, pid: 123 },
      { actor: "runtime" },
    );
    await builder.append("issue_binding_resolved", {
      issueNodeId: "I_private_node",
    });
    await builder.append(
      "owner_decision_recorded",
      {
        decision: "accepted",
        note: "Accept after verification.",
        resultingIssueState: "ready-for-human",
      },
      { actor: "human" },
    );
    const later = dueMilestones(await builder.view()).find(
      (milestone) => milestone.kind === "complete",
    );

    expect(later?.payload).toEqual(first!.payload);
    expect(canonicalPayloadHash(later!.payload)).toBe(firstHash);
  });

  test("routine lifecycle and non-blocked checkpoints add no milestone", async () => {
    const builder = await RunBuilder.create();
    await builder.register("lane-1");
    expect(dueMilestones(await builder.view())).toEqual([]);

    await builder.append("lane_dispatch_intent", {}, { laneId: "lane-1" });
    const onlyStart = async () =>
      expect(
        dueMilestones(await builder.view()).map(({ kind }) => kind),
      ).toEqual(["start"]);
    await onlyStart();

    await builder.append(
      "lane_dispatched",
      { command: "private command" },
      { laneId: "lane-1" },
    );
    await onlyStart();
    await builder.append("lane_live", {}, { laneId: "lane-1" });
    await onlyStart();
    for (const semanticState of ["working", "complete", "partial"] as const) {
      await builder.append(
        "lane_checkpoint",
        {
          semanticState,
          checkpointFile: join(
            runDirectory,
            "checkpoints",
            `${semanticState}.md`,
          ),
        },
        { laneId: "lane-1", actor: "agent" },
      );
      await onlyStart();
    }
    await builder.append("checkpoint_announced", {});
    await onlyStart();
    await builder.append(
      "human_interrupt",
      { laneId: "lane-1" },
      { laneId: "lane-1", actor: "human" },
    );
    await onlyStart();
    await builder.append("lane_takeover", {}, { laneId: "lane-1", actor: "human" });
    await onlyStart();
    await builder.append("lane_release", {}, { laneId: "lane-1", actor: "human" });
    await onlyStart();
    await builder.append(
      "controller_attached",
      { controllerId: "private", epoch: 1, pid: 123 },
    );
    await onlyStart();
    await builder.append(
      "lane_exited",
      { exitCode: 0, waitMatched: true },
      { laneId: "lane-1" },
    );
    await onlyStart();
  });

  test("does not mutate the reconstructed run", async () => {
    const builder = await RunBuilder.create();
    await appendBlockedLane(builder);
    const run = await builder.view();
    const before = structuredClone(run);

    dueMilestones(run);

    expect(run).toEqual(before);
  });

  test("a pointer outside the run directory fails closed without leaking it", async () => {
    const offendingPath = "/private/owner/checkpoint.md";
    const builder = await RunBuilder.create();
    await appendBlockedLane(builder, "lane-1", offendingPath);
    const run = await builder.view();

    expect(() => dueMilestones(run)).toThrow(
      'checkpointPointer for lane "lane-1"',
    );
    try {
      dueMilestones(run);
    } catch (error) {
      expect(String(error)).not.toContain(offendingPath);
    }
  });
});
