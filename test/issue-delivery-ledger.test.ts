import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../src/runtime/events.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import { InMemoryLedger, type Ledger } from "../src/runtime/ledger.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function ledgerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-issue-delivery-"));
  roots.push(root);
  return join(root, "ledger");
}

const events: readonly RunEvent[] = [
  {
    schemaVersion: 1,
    eventId: "run-delivery#1",
    runId: "run-delivery",
    sequence: 1,
    type: "run_started",
    at: 100,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      workflow: "cross-review",
      workspace: "agent-flow",
      cwd: "/tmp/run-delivery",
      splitDirection: "down",
      tabId: "agent-flow:t1",
      controllerPaneId: "agent-flow:p1",
      fixedPoint: null,
      issue: { owner: "netfishx", repo: "agent-flow", number: 24 },
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#2",
    runId: "run-delivery",
    laneId: "lane-1",
    sequence: 2,
    type: "lane_registered",
    at: 200,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      laneId: "lane-1",
      paneId: "agent-flow:p2",
      logFile: "/tmp/lane-1.log",
      stderrFile: "/tmp/lane-1.stderr.log",
      sentinelToken: "FLOW_run-delivery_LANE_lane-1_EXIT",
      steps: 1,
      stepDelaySeconds: 0,
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#3",
    runId: "run-delivery",
    laneId: "lane-1",
    sequence: 3,
    type: "lane_dispatch_intent",
    at: 300,
    actor: "runtime",
    controllerEpoch: 0,
    data: {},
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#4",
    runId: "run-delivery",
    laneId: "lane-1",
    sequence: 4,
    type: "lane_checkpoint",
    at: 400,
    actor: "agent",
    controllerEpoch: 0,
    data: {
      semanticState: "blocked",
      checkpointFile: "/tmp/checkpoint-blocked.md",
      blockers: ["missing owner decision"],
      next: ["ask the owner"],
      gaps: ["delivery not attempted"],
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#5",
    runId: "run-delivery",
    sequence: 5,
    type: "issue_binding_resolved",
    at: 500,
    actor: "runtime",
    controllerEpoch: 0,
    data: { issueNodeId: "I_kwDOIssue24" },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#6",
    runId: "run-delivery",
    sequence: 6,
    type: "issue_delivery_intended",
    at: 600,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      deliveryId: "start:run-delivery",
      kind: "start",
      laneId: null,
      payloadHash: "sha256:start",
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#7",
    runId: "run-delivery",
    sequence: 7,
    type: "issue_delivery_confirmed",
    at: 700,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      deliveryId: "start:run-delivery",
      commentId: 201,
      commentUrl:
        "https://github.com/netfishx/agent-flow/issues/24#issuecomment-201",
      labelTransition: "applied",
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#8",
    runId: "run-delivery",
    sequence: 8,
    type: "issue_delivery_intended",
    at: 800,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      deliveryId: "blocked:lane-1",
      kind: "blocked",
      laneId: "lane-1",
      payloadHash: "sha256:blocked",
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#9",
    runId: "run-delivery",
    sequence: 9,
    type: "owner_decision_recorded",
    at: 900,
    actor: "human",
    controllerEpoch: 0,
    data: {
      decision: "accepted",
      note: "Retry after recording the blocker.",
      resultingIssueState: "ready-for-agent",
    },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#10",
    runId: "run-delivery",
    laneId: "lane-1",
    sequence: 10,
    type: "lane_exited",
    at: 1_000,
    actor: "runtime",
    controllerEpoch: 0,
    data: { exitCode: 0 },
  },
  {
    schemaVersion: 1,
    eventId: "run-delivery#11",
    runId: "run-delivery",
    sequence: 11,
    type: "run_finished",
    at: 1_100,
    actor: "runtime",
    controllerEpoch: 0,
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
  },
];

async function commitAll(ledger: Ledger): Promise<void> {
  for (const item of events) await ledger.commit(item);
}

function expectReconstructed(
  view: NonNullable<Awaited<ReturnType<Ledger["load"]>>>,
): void {
  expect(view.issue).toEqual({
    owner: "netfishx",
    repo: "agent-flow",
    number: 24,
  });
  expect(view.issueNodeId).toBe("I_kwDOIssue24");
  expect(view.deliveryOrder).toEqual([
    "start:run-delivery",
    "blocked:lane-1",
  ]);
  expect(view.deliveries["start:run-delivery"]).toMatchObject({
    state: "delivered",
    commentId: 201,
    labelTransition: "applied",
  });
  expect(view.deliveries["blocked:lane-1"]).toMatchObject({
    state: "pending",
    intendedAt: 800,
    // Replay must reconstruct the unsettled label outcome as the explicit
    // "not-applicable" the published contract specifies, never as null.
    labelTransition: "not-applicable",
  });
  expect(view.decisions).toEqual([
    {
      sequence: 9,
      at: 900,
      actor: "human",
      decision: "accepted",
      note: "Retry after recording the blocker.",
      resultingIssueState: "ready-for-agent",
    },
  ]);
  expect(view.startAnchorSequence).toBe(3);
  expect(view.finishedSequence).toBe(11);
  expect(view.lanes["lane-1"]!.blockedAnchor).toEqual({
    sequence: 4,
    checkpointFile: "/tmp/checkpoint-blocked.md",
    blockers: ["missing owner decision"],
    next: ["ask the owner"],
    gaps: ["delivery not attempted"],
  });
}

describe("issue delivery ledger replay", () => {
  test("load fails closed when run_started omits its required issue field", async () => {
    const root = await ledgerRoot();
    const started = events[0]! as Extract<
      RunEvent,
      { readonly type: "run_started" }
    >;
    const { issue: omitted, ...data } = started.data;
    void omitted;
    const runDir = join(root, "runs", started.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ ...started, data })}\n`,
      "utf8",
    );

    await expect(new FsLedger(root).load(started.runId)).rejects.toThrow(
      /corrupt event stream.*run_started.*missing required "issue"/,
    );
  });

  test("a null issue remains a valid unbound replay", async () => {
    const ledger = new InMemoryLedger();
    const started = events[0]! as Extract<
      RunEvent,
      { readonly type: "run_started" }
    >;
    const unbound: RunEvent = {
      ...started,
      eventId: "run-unbound#1",
      runId: "run-unbound",
      data: { ...started.data, issue: null },
    };

    await ledger.commit(unbound);

    expect((await ledger.load("run-unbound"))!.issue).toBeNull();
  });

  test("an in-memory load reconstructs every issue delivery fact", async () => {
    const ledger = new InMemoryLedger();
    await commitAll(ledger);

    expectReconstructed((await ledger.load("run-delivery"))!);
  });

  test("a fresh filesystem ledger durably replays new payloads and deduplicates their event ids", async () => {
    const root = await ledgerRoot();
    const writer = new FsLedger(root);
    await commitAll(writer);
    const intended = events[7]! as Extract<
      RunEvent,
      { readonly type: "issue_delivery_intended" }
    >;

    await expect(writer.commit(intended)).resolves.toBeUndefined();
    await expect(
      writer.commit({
        ...intended,
        data: {
          deliveryId: "blocked:lane-1",
          kind: "blocked",
          laneId: "lane-1",
          payloadHash: "sha256:conflict",
        },
      }),
    ).rejects.toThrow(/different payload/);

    expectReconstructed((await new FsLedger(root).load("run-delivery"))!);
  });
});
