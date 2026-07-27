import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveIssueTarget,
  runFlowCli,
} from "../src/cli/flow.ts";
import {
  createClock,
  FakeHerdrAdapter,
} from "../src/herdr/fake-adapter.ts";
import { FakeIssueTracker } from "../src/testing.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type {
  IssueRef,
  RunEvent,
  RunEventActor,
  RunEventDataByType,
  RunEventType,
  RunnerEvidence,
} from "../src/runtime/events.ts";
import type { LeaseHandle, Ledger } from "../src/runtime/ledger.ts";
import type { RunView } from "../src/runtime/reducer.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-cli-"));
  roots.push(root);
  return root;
}

async function seedFinishedRun(
  root: string,
  options: { finished?: boolean } = {},
): Promise<void> {
  const ledger = new FsLedger(root);
  const base = {
    schemaVersion: 1 as const,
    runId: "run-cli",
    controllerEpoch: 0,
  };
  const events: RunEvent[] = [
    {
      ...base,
      eventId: "run-cli#1",
      sequence: 1,
      type: "run_started",
      at: 100,
      actor: "runtime",
      data: {
        workflow: "cross-review",
        workspace: "w1",
        cwd: "/tmp/cli-run",
        splitDirection: "down",
        tabId: "w1:t1",
        controllerPaneId: "w1:p1",
        fixedPoint: {
          repoRoot: "/repo",
          baseCommit: "base123",
          headCommit: "head456",
          diffHash: "sha256:diff",
          dirtyStatePolicy: "reject",
          capturedAt: 99,
        },
        issue: null,
      },
    },
    {
      ...base,
      eventId: "run-cli#2",
      laneId: "lane-1",
      sequence: 2,
      type: "lane_registered",
      at: 110,
      actor: "runtime",
      data: {
        laneId: "lane-1",
        paneId: "w1:p2",
        logFile: "/tmp/cli-run/lane.log",
        stderrFile: "/tmp/cli-run/lane.stderr.log",
        sentinelToken: "FLOW_run-cli_LANE_lane-1_EXIT",
        steps: 1,
        stepDelaySeconds: 0,
      },
    },
    {
      ...base,
      eventId: "run-cli#3",
      laneId: "lane-1",
      sequence: 3,
      type: "lane_dispatch_intent",
      at: 115,
      actor: "runtime",
      data: {},
    },
    {
      ...base,
      eventId: "run-cli#4",
      laneId: "lane-1",
      sequence: 4,
      type: "lane_dispatched",
      at: 120,
      actor: "runtime",
      data: { command: "actual command" },
    },
    {
      ...base,
      eventId: "run-cli#5",
      laneId: "lane-1",
      sequence: 5,
      type: "lane_live",
      at: 130,
      actor: "runtime",
      data: {},
    },
    {
      ...base,
      eventId: "run-cli#6",
      laneId: "lane-1",
      sequence: 6,
      type: "lane_exited",
      at: 140,
      actor: "runtime",
      data: { exitCode: 0, waitMatched: true },
    },
    {
      ...base,
      eventId: "run-cli#7",
      laneId: "lane-1",
      sequence: 7,
      type: "lane_checkpoint",
      at: 150,
      actor: "agent",
      data: { semanticState: "complete", checkpointFile: "/tmp/cli-run/checkpoint.md" },
    },
    {
      ...base,
      eventId: "run-cli#8",
      laneId: "lane-1",
      sequence: 8,
      type: "lane_contract_evaluated",
      at: 160,
      actor: "validator",
      data: {
        contractState: "satisfied",
        resultFile: "/tmp/cli-run/result.txt",
        errors: [],
      },
    },
    {
      ...base,
      eventId: "run-cli#9",
      laneId: "lane-1",
      sequence: 9,
      type: "lane_verification_recorded",
      at: 170,
      actor: "runner",
      data: { verificationState: "verified", evidenceFile: "/tmp/cli-run/evidence.json" },
    },
    {
      ...base,
      eventId: "run-cli#10",
      sequence: 10,
      type: "run_finished",
      at: 180,
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
    },
  ];
  for (const event of events) {
    if (options.finished === false && event.type === "run_finished") continue;
    await ledger.commit(event);
  }
}

async function appendCliEvent<T extends RunEventType>(
  ledger: Ledger,
  runId: string,
  type: T,
  data: RunEventDataByType[T],
  options: {
    readonly laneId?: string;
    readonly actor?: RunEventActor;
    readonly at?: number;
  } = {},
): Promise<void> {
  const run = await ledger.load(runId);
  const sequence = (run?.lastAppliedSequence ?? 0) + 1;
  await ledger.commit({
    schemaVersion: 1,
    eventId: `${runId}#${sequence}`,
    runId,
    sequence,
    type,
    at: options.at ?? sequence * 10,
    actor: options.actor ?? "runtime",
    controllerEpoch: run?.controllerEpoch ?? 0,
    data,
    ...(options.laneId === undefined
      ? {}
      : { laneId: options.laneId }),
  } as RunEvent);
}

const synchronizationIssue: IssueRef = {
  owner: "netfishx",
  repo: "agent-flow",
  number: 30,
};

async function seedSynchronizationRun(
  ledger: Ledger,
  runId: string,
  cwd: string,
  issue: IssueRef | null,
): Promise<void> {
  await appendCliEvent(ledger, runId, "run_started", {
    workflow: "cross-review",
    workspace: "w1",
    cwd,
    splitDirection: "down",
    tabId: `${runId}:tab`,
    controllerPaneId: `${runId}:controller`,
    fixedPoint: null,
    issue,
  });
  await appendCliEvent(
    ledger,
    runId,
    "lane_registered",
    {
      laneId: "lane-1",
      paneId: `${runId}:lane-1`,
      logFile: join(cwd, runId, "logs", "lane-1.log"),
      stderrFile: join(cwd, runId, "logs", "lane-1.stderr.log"),
      sentinelToken: `FLOW_${runId}_LANE_lane-1_EXIT`,
      steps: 1,
      stepDelaySeconds: 0,
    },
    { laneId: "lane-1" },
  );
}

async function flow(root: string, ...args: string[]) {
  const child = Bun.spawn(["bun", "run", "flow", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FLOW_LEDGER_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

class AmbiguousCommitLedger extends FsLedger {
  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    throw new Error("injected append failure");
  }

  protected override async rollbackAppend(): Promise<void> {
    throw new Error("injected rollback failure");
  }
}

class DurableEventsWithoutLease implements Ledger {
  constructor(private readonly delegate: FsLedger) {}

  commit(event: RunEvent): Promise<void> {
    return this.delegate.commit(event);
  }

  load(runId: string): Promise<RunView | null> {
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  async acquireLease(): Promise<LeaseHandle> {
    return { release: async () => {} };
  }
}

class RejectLeaseLedger implements Ledger {
  constructor(private readonly delegate: Ledger) {}

  commit(event: RunEvent): Promise<void> {
    return this.delegate.commit(event);
  }

  load(runId: string): Promise<RunView | null> {
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  async acquireLease(): Promise<LeaseHandle> {
    throw new Error("inspect must not acquire a controller lease");
  }
}

function sink() {
  let text = "";
  return {
    output: { write: (chunk: string) => (text += chunk) },
    text: () => text,
  };
}

function ambiguousRunStarted(): RunEvent {
  return {
    schemaVersion: 1,
    eventId: "run-poisoned#1",
    runId: "run-poisoned",
    sequence: 1,
    type: "run_started",
    at: 100,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      workflow: "cross-review",
      workspace: "w1",
      cwd: "/tmp/poisoned",
      splitDirection: "down",
      tabId: "w1:t1",
      controllerPaneId: "w1:p1",
      fixedPoint: null,
      issue: null,
    },
  };
}

describe("flow CLI external behavior", () => {
  test.each([
    [
      "configured",
      { FLOW_ISSUE_TARGET: "netfishx/agent-flow#30" },
      { owner: "netfishx", repo: "agent-flow", number: 30 },
    ],
    ["unconfigured", {}, null],
  ] as const)(
    "resolves the issue target when %s",
    (_name, environment, expected) => {
      expect(resolveIssueTarget(environment)).toEqual(expected);
    },
  );

  test.each([
    "",
    "netfishx/agent-flow",
    "netfishx/agent-flow#0",
    "netfishx/agent-flow#30/extra",
    "netfishx//agent-flow#30",
    "netfishx/agent-flow#9007199254740992",
  ])("rejects malformed FLOW_ISSUE_TARGET %p", (configured) => {
    expect(() =>
      resolveIssueTarget({ FLOW_ISSUE_TARGET: configured }),
    ).toThrow("FLOW_ISSUE_TARGET must be owner/repo#number");
  });

  test("default CLI validates delivery targets while read-only commands ignore them", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);
    const clock = createClock(250);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const source = new WorkflowRuntime({
      adapter,
      ledger: new FsLedger(root),
      clock: clock.now,
      idgen: () => "run-cli-real-tracker-wiring",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: new FakeIssueTracker(),
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd: join(root, "work"),
      lanes: [{ laneId: "review", steps: 1 }],
      issue: synchronizationIssue,
    });
    await source.confirmLaneStarted(handle.runId, "review");
    await source.awaitLane(handle.runId, "review", 1_000);
    const configuredStdout = sink();
    const configuredStderr = sink();

    const configuredExit = await runFlowCli(
      ["resume", handle.runId],
      configuredStdout.output,
      configuredStderr.output,
      {
        environment: {
          FLOW_LEDGER_ROOT: root,
          FLOW_ISSUE_TARGET: "netfishx/agent-flow#30",
        },
      },
    );
    const malformedStdout = sink();
    const malformedStderr = sink();
    const malformedExit = await runFlowCli(
      ["resume", handle.runId],
      malformedStdout.output,
      malformedStderr.output,
      {
        environment: {
          FLOW_LEDGER_ROOT: root,
          FLOW_ISSUE_TARGET: "netfishx/agent-flow",
        },
      },
    );
    const missingStdout = sink();
    const missingStderr = sink();
    const missingExit = await runFlowCli(
      ["resume", handle.runId],
      missingStdout.output,
      missingStderr.output,
      {
        environment: { FLOW_LEDGER_ROOT: root },
      },
    );
    const inspectStdout = sink();
    const inspectStderr = sink();
    const inspectExit = await runFlowCli(
      ["inspect", "run-cli"],
      inspectStdout.output,
      inspectStderr.output,
      {
        environment: {
          FLOW_LEDGER_ROOT: root,
          FLOW_ISSUE_TARGET: "not a target",
        },
      },
    );
    const statusStdout = sink();
    const statusStderr = sink();
    const statusExit = await runFlowCli(
      ["status"],
      statusStdout.output,
      statusStderr.output,
      {
        environment: {
          FLOW_LEDGER_ROOT: root,
          FLOW_ISSUE_TARGET: "not a target",
        },
      },
    );

    expect(configuredExit).toBe(0);
    expect(configuredStderr.text()).toBe("");
    expect(configuredStdout.text()).toContain(
      `runId=${handle.runId}`,
    );
    expect(malformedExit).toBe(1);
    expect(malformedStdout.text()).toBe("");
    expect(malformedStderr.text()).toContain(
      "FLOW_ISSUE_TARGET must be owner/repo#number",
    );
    expect(missingExit).toBe(1);
    expect(missingStdout.text()).toBe("");
    expect(missingStderr.text()).toContain(
      "FLOW_ISSUE_TARGET is required for a bound run",
    );
    expect(inspectExit).toBe(0);
    expect(inspectStderr.text()).toBe("");
    expect(inspectStdout.text()).toContain("runId=run-cli");
    expect(statusExit).toBe(0);
    expect(statusStderr.text()).toBe("");
    expect(statusStdout.text()).toContain("run-cli");
  });

  test("an unbound resume ignores malformed tracker configuration", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);
    const before = await new FsLedger(root).load("run-cli");
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["resume", "run-cli"],
      stdout.output,
      stderr.output,
      {
        environment: {
          FLOW_LEDGER_ROOT: root,
          FLOW_ISSUE_TARGET: "not a target",
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("runId=run-cli");
    expect(await new FsLedger(root).load("run-cli")).toEqual(before);
  });

  test("mismatched delivery target refuses without changing the ledger", async () => {
    const root = await tempRoot();
    const clock = createClock(400);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const ledger = new FsLedger(root);
    const source = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-cli-target-mismatch",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: new FakeIssueTracker({
        failure: { operation: "resolveIssue", retryable: true },
      }),
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd: join(root, "work"),
      lanes: [{ laneId: "review", steps: 1 }],
      issue: synchronizationIssue,
    });
    await source.confirmLaneStarted(handle.runId, "review");
    await source.awaitLane(handle.runId, "review", 1_000);
    const before = await ledger.load(handle.runId);
    expect(
      before?.deliveryOrder.map(
        (deliveryId) =>
          before.deliveries[deliveryId]?.lastFailure?.retryable,
      ),
    ).toEqual([true, true]);
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["resume", handle.runId],
      stdout.output,
      stderr.output,
      {
        environment: {
          FLOW_LEDGER_ROOT: root,
          FLOW_ISSUE_TARGET: "netfishx/agent-flow#31",
        },
      },
    );
    const after = await ledger.load(handle.runId);

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain(
      "FLOW_ISSUE_TARGET does not match the run binding",
    );
    expect(after).toEqual(before);
  });

  test("status lists a run from the durable ledger", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);

    const result = await flow(root, "status");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("run-cli");
    expect(result.stdout).toContain("workflow=cross-review");
    expect(result.stdout).toContain("state=complete");
    expect(result.stdout).toContain("finishStatus=clean");
    expect(result.stdout).toContain("lanes=1");
    expect(result.stdout).toContain("updatedAt=180");
  });

  test("status reports all four synchronization states", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    const cwd = join(root, "work");
    await seedSynchronizationRun(
      ledger,
      "run-sync-none",
      cwd,
      null,
    );
    await seedSynchronizationRun(
      ledger,
      "run-sync-ok",
      cwd,
      synchronizationIssue,
    );
    await seedSynchronizationRun(
      ledger,
      "run-sync-pending",
      cwd,
      synchronizationIssue,
    );
    await appendCliEvent(
      ledger,
      "run-sync-pending",
      "lane_dispatch_intent",
      {},
      { laneId: "lane-1" },
    );
    await seedSynchronizationRun(
      ledger,
      "run-sync-degraded",
      cwd,
      synchronizationIssue,
    );
    await appendCliEvent(
      ledger,
      "run-sync-degraded",
      "lane_dispatch_intent",
      {},
      { laneId: "lane-1" },
    );
    await appendCliEvent(
      ledger,
      "run-sync-degraded",
      "issue_delivery_intended",
      {
        deliveryId: "run-sync-degraded:3:start",
        kind: "start",
        laneId: null,
        payloadHash: "payload",
      },
    );
    await appendCliEvent(
      ledger,
      "run-sync-degraded",
      "issue_delivery_failed",
      {
        deliveryId: "run-sync-degraded:3:start",
        reason: "tracker unavailable",
        retryable: true,
      },
    );

    const result = await flow(root, "status");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /run-sync-none .*issueSync=none/,
    );
    expect(result.stdout).toMatch(
      /run-sync-ok .*issueSync=ok/,
    );
    expect(result.stdout).toMatch(
      /run-sync-pending .*issueSync=pending/,
    );
    expect(result.stdout).toMatch(
      /run-sync-degraded .*issueSync=degraded/,
    );
  });

  test("inspect keeps four dimensions side by side with fixed point and artifacts", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);

    const result = await flow(root, "inspect", "run-cli");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('fixedPoint={"repoRoot":"/repo"');
    expect(result.stdout).toContain(
      "runtimeState=exited semanticState=complete contractState=satisfied verificationState=verified",
    );
    expect(result.stdout).toContain("controlMode=managed exitCode=0");
    expect(result.stdout).toContain("dispatchedAt=120 liveAt=130 completedAt=140");
    expect(result.stdout).toContain("stdout=/tmp/cli-run/lane.log");
    expect(result.stdout).toContain("stderr=/tmp/cli-run/lane.stderr.log");
    expect(result.stdout).toContain("checkpoint=/tmp/cli-run/checkpoint.md");
    expect(result.stdout).toContain("result=/tmp/cli-run/result.txt");
    expect(result.stdout).toContain("evidence=/tmp/cli-run/evidence.json");
  });

  test("inspect reports issue and every delivery field with retry disposition", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    const runId = "run-sync-inspect";
    const cwd = join(root, "work");
    const runDirectory = join(cwd, runId);
    await seedSynchronizationRun(
      ledger,
      runId,
      cwd,
      synchronizationIssue,
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_dispatch_intent",
      {},
      { laneId: "lane-1" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_exited",
      { exitCode: 0, waitMatched: true },
      { laneId: "lane-1" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_checkpoint",
      {
        semanticState: "complete",
        checkpointFile: join(
          runDirectory,
          "checkpoints",
          "lane-1.md",
        ),
      },
      { laneId: "lane-1", actor: "agent" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_contract_evaluated",
      {
        contractState: "satisfied",
        resultFile: join(runDirectory, "results", "lane-1.txt"),
        errors: [],
      },
      { laneId: "lane-1", actor: "validator" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_verification_recorded",
      {
        verificationState: "verified",
        evidenceFile: join(
          runDirectory,
          "evidence",
          "lane-1.json",
        ),
      },
      { laneId: "lane-1", actor: "runner" },
    );
    await appendCliEvent(ledger, runId, "run_finished", {
      status: "clean",
      breakdown: {
        exitedZero: 1,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    });
    await appendCliEvent(ledger, runId, "issue_binding_resolved", {
      issueNodeId: "I_kwDO30",
    });
    await appendCliEvent(
      ledger,
      runId,
      "issue_delivery_intended",
      {
        deliveryId: `${runId}:3:start`,
        kind: "start",
        laneId: null,
        payloadHash: "start-payload",
      },
    );
    await appendCliEvent(
      ledger,
      runId,
      "issue_delivery_failed",
      {
        deliveryId: `${runId}:3:start`,
        reason: "temporary tracker outage",
        retryable: true,
      },
    );
    await appendCliEvent(
      ledger,
      runId,
      "issue_delivery_intended",
      {
        deliveryId: `${runId}:8:complete`,
        kind: "complete",
        laneId: null,
        payloadHash: "complete-payload",
      },
    );
    await appendCliEvent(
      ledger,
      runId,
      "issue_delivery_failed",
      {
        deliveryId: `${runId}:8:complete`,
        reason: "authorization refused",
        retryable: false,
      },
    );
    await appendCliEvent(
      ledger,
      runId,
      "owner_decision_recorded",
      {
        decision: "accepted",
        note: "ship it",
        resultingIssueState: null,
      },
      { actor: "human" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "issue_delivery_intended",
      {
        deliveryId: `${runId}:14:decision`,
        kind: "decision",
        laneId: null,
        payloadHash: "decision-payload",
      },
    );
    await appendCliEvent(
      ledger,
      runId,
      "issue_delivery_confirmed",
      {
        deliveryId: `${runId}:14:decision`,
        commentId: 300,
        commentUrl:
          "https://github.com/netfishx/agent-flow/issues/30#issuecomment-300",
        labelTransition: "not-applicable",
      },
    );
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["inspect", runId],
      stdout.output,
      stderr.output,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        runtimeFactory: (runtimeLedger) =>
          new WorkflowRuntime({
            adapter: new FakeHerdrAdapter({ lanes: [] }),
            ledger: runtimeLedger,
            clock: () => 1_000,
            idgen: () => "unused",
            readResultFile: async () => "",
            sleep: async () => {},
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain(
      "issue=netfishx/agent-flow#30 issueNodeId=I_kwDO30",
    );
    expect(stdout.text()).toContain(
      'issueSync=degraded reason="temporary tracker outage"',
    );
    expect(stdout.text()).toMatch(
      /delivery=run-sync-inspect:3:start kind=start state=failed intents=1 labelTransition=not-applicable failureReason="temporary tracker outage" retryable=true retryDisposition=will-retry commentUrl=null/,
    );
    expect(stdout.text()).toMatch(
      /delivery=run-sync-inspect:8:complete kind=complete state=failed intents=1 labelTransition=not-applicable failureReason="authorization refused" retryable=false retryDisposition=needs-operator commentUrl=null/,
    );
    expect(stdout.text()).toMatch(
      /delivery=run-sync-inspect:14:decision kind=decision state=delivered intents=1 labelTransition=not-applicable failureReason=null retryable=null retryDisposition=not-applicable commentUrl=https:\/\/github.com\/netfishx\/agent-flow\/issues\/30#issuecomment-300/,
    );
  });

  test("inspect surfaces a due-list planning failure instead of reporting healthy", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    const runId = "run-sync-planning-failure";
    const cwd = join(root, "work");
    const runDirectory = join(cwd, runId);
    await seedSynchronizationRun(
      ledger,
      runId,
      cwd,
      synchronizationIssue,
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_dispatch_intent",
      {},
      { laneId: "lane-1" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_checkpoint",
      {
        semanticState: "blocked",
        checkpointFile: join(cwd, "outside-run", "lane-1.md"),
      },
      { laneId: "lane-1", actor: "agent" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_exited",
      { exitCode: 0, waitMatched: true },
      { laneId: "lane-1" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_contract_evaluated",
      {
        contractState: "satisfied",
        resultFile: join(runDirectory, "results", "lane-1.txt"),
        errors: [],
      },
      { laneId: "lane-1", actor: "validator" },
    );
    await appendCliEvent(
      ledger,
      runId,
      "lane_verification_recorded",
      {
        verificationState: "verified",
        evidenceFile: join(
          runDirectory,
          "evidence",
          "lane-1.json",
        ),
      },
      { laneId: "lane-1", actor: "runner" },
    );
    await appendCliEvent(ledger, runId, "run_finished", {
      status: "clean",
      breakdown: {
        exitedZero: 1,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    });
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["inspect", runId],
      stdout.output,
      stderr.output,
      {
        environment: { FLOW_LEDGER_ROOT: root },
        runtimeFactory: (runtimeLedger) =>
          new WorkflowRuntime({
            adapter: new FakeHerdrAdapter({ lanes: [] }),
            ledger: runtimeLedger,
            clock: () => 1_000,
            idgen: () => "unused",
            readResultFile: async () => "",
            sleep: async () => {},
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain(
      "issue=netfishx/agent-flow#30 issueNodeId=unresolved",
    );
    expect(stdout.text()).toContain("issueSync=degraded");
    expect(stdout.text()).not.toContain("issueSync=ok");
    expect(stdout.text()).toContain(
      'reason="checkpointPointer for lane \\"lane-1\\" is outside the run directory"',
    );
  });

  test("fresh inspect reconciles and collects a self-terminated human-owned lane without driving it", async () => {
    const root = await tempRoot();
    const ledgerRoot = join(root, "ledger");
    const cwd = join(root, "work");
    const ledger = new FsLedger(ledgerRoot);
    const clock = createClock(500);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "owned", exitCode: 0 }],
    });
    const source = new WorkflowRuntime({
      adapter,
      ledger: new DurableEventsWithoutLease(ledger),
      clock: clock.now,
      idgen: () => "run-inspect-owned",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "owned", steps: 1 }],
    });
    await source.confirmLaneStarted(handle.runId, "owned");
    await source.takeoverLane(handle.runId, "owned");
    adapter.finishLane("owned");
    const ownedPaneId = adapter.paneIdForLane("owned")!;
    const processInfoBefore = adapter.processInfoPaneIds.length;
    const waitsBefore = adapter.waitedPaneIds.length;
    const interruptsBefore = adapter.interruptedPaneIds.length;
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["inspect", handle.runId],
      stdout.output,
      stderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: ledgerRoot },
        runtimeFactory: (runtimeLedger) =>
          new WorkflowRuntime({
            adapter,
            ledger: new RejectLeaseLedger(runtimeLedger),
            clock: clock.now,
            idgen: () => "unused",
            readResultFile: adapter.readResultFile,
            sleep: async () => {},
          }),
      },
    );
    const loaded = await ledger.load(handle.runId);
    const owned = loaded!.lanes["owned"]!;

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("controlMode=human_owned exitCode=0");
    expect(owned).toMatchObject({
      runtimeState: "exited",
      controlMode: "human_owned",
      exitCode: 0,
      semanticState: "complete",
      contractState: "satisfied",
      verificationState: "verified",
    });
    expect(adapter.processInfoPaneIds.slice(processInfoBefore)).toContain(
      ownedPaneId,
    );
    expect(adapter.waitedPaneIds.slice(waitsBefore)).toEqual([]);
    expect(adapter.interruptedPaneIds.slice(interruptsBefore)).toEqual([]);
    expect(owned.evidenceFile).not.toBeNull();
    expect(
      JSON.parse(await readFile(owned.evidenceFile!, "utf8")),
    ).toMatchObject({
      runId: handle.runId,
      laneId: "owned",
      exitCode: 0,
      termination: "sentinel-exit",
    });
  });

  test("inspect renders a crashed human-owned lane and still reconciles following lanes", async () => {
    const root = await tempRoot();
    const ledgerRoot = join(root, "ledger");
    const cwd = join(root, "work");
    const ledger = new FsLedger(ledgerRoot);
    const clock = createClock(750);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "owned-crashed",
          exitCode: 1,
          emitSentinel: false,
        },
        { laneId: "following", exitCode: 0 },
      ],
    });
    const source = new WorkflowRuntime({
      adapter,
      ledger: new DurableEventsWithoutLease(ledger),
      clock: clock.now,
      idgen: () => "run-inspect-crashed",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "owned-crashed", steps: 1 },
        { laneId: "following", steps: 1 },
      ],
    });
    for (const laneId of handle.laneIds) {
      await source.confirmLaneStarted(handle.runId, laneId);
      adapter.finishLane(laneId);
    }
    await source.takeoverLane(handle.runId, "owned-crashed");
    const crashedPaneId = adapter.paneIdForLane("owned-crashed")!;
    const followingPaneId = adapter.paneIdForLane("following")!;
    const processInfoBefore = adapter.processInfoPaneIds.length;
    const waitsBefore = adapter.waitedPaneIds.length;
    const interruptsBefore = adapter.interruptedPaneIds.length;
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["inspect", handle.runId],
      stdout.output,
      stderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: ledgerRoot },
        runtimeFactory: (runtimeLedger) =>
          new WorkflowRuntime({
            adapter,
            ledger: new RejectLeaseLedger(runtimeLedger),
            clock: clock.now,
            idgen: () => "unused",
            readResultFile: adapter.readResultFile,
            sleep: async () => {},
          }),
      },
    );
    const loaded = await ledger.load(handle.runId);
    const crashed = loaded!.lanes["owned-crashed"]!;
    const following = loaded!.lanes["following"]!;

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("runtimeState=crashed");
    expect(crashed).toMatchObject({
      runtimeState: "crashed",
      controlMode: "human_owned",
      contractState: "violated",
      verificationState: "failed",
    });
    expect(following).toMatchObject({
      runtimeState: "exited",
      contractState: "satisfied",
      verificationState: "verified",
      exitCode: 0,
    });
    expect(adapter.processInfoPaneIds.slice(processInfoBefore)).toEqual([
      crashedPaneId,
      followingPaneId,
    ]);
    expect(adapter.waitedPaneIds.slice(waitsBefore)).toEqual([]);
    expect(adapter.interruptedPaneIds.slice(interruptsBefore)).toEqual([]);
    expect(
      JSON.parse(await readFile(crashed.evidenceFile!, "utf8")),
    ).toMatchObject({
      runId: handle.runId,
      laneId: "owned-crashed",
      termination: "crashed",
    });
    expect(
      JSON.parse(await readFile(following.evidenceFile!, "utf8")),
    ).toMatchObject({
      runId: handle.runId,
      laneId: "following",
      termination: "sentinel-exit",
    });
  });

  test("inspect fails closed on evidence-write failure and completes facts on retry", async () => {
    const root = await tempRoot();
    const ledgerRoot = join(root, "ledger");
    const cwd = join(root, "work");
    const ledger = new FsLedger(ledgerRoot);
    const clock = createClock(900);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "owned-crashed", exitCode: 1, emitSentinel: false }],
    });
    const source = new WorkflowRuntime({
      adapter,
      ledger: new DurableEventsWithoutLease(ledger),
      clock: clock.now,
      idgen: () => "run-inspect-evidence-failure",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "owned-crashed", steps: 1 }],
    });
    await source.confirmLaneStarted(handle.runId, "owned-crashed");
    await source.takeoverLane(handle.runId, "owned-crashed");
    adapter.finishLane("owned-crashed");
    let failuresRemaining = 2;

    class FailingEvidenceRuntime extends WorkflowRuntime {
      protected override async writeRunnerEvidenceFile(
        path: string,
        evidence: RunnerEvidence,
      ): Promise<void> {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("injected evidence write failure");
        }
        await super.writeRunnerEvidenceFile(path, evidence);
      }
    }

    const createFailingRuntime = (runtimeLedger: Ledger) =>
      new FailingEvidenceRuntime({
        adapter,
        ledger: new RejectLeaseLedger(runtimeLedger),
        clock: clock.now,
        idgen: () => "unused",
        readResultFile: adapter.readResultFile,
        sleep: async () => {},
      });
    await expect(
      createFailingRuntime(ledger).inspectWorkflow(handle.runId),
    ).rejects.toThrow("injected evidence write failure");

    const failedStdout = sink();
    const failedStderr = sink();
    const failedExitCode = await runFlowCli(
      ["inspect", handle.runId],
      failedStdout.output,
      failedStderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: ledgerRoot },
        runtimeFactory: createFailingRuntime,
      },
    );
    const incomplete = await ledger.load(handle.runId);

    expect(failedExitCode).not.toBe(0);
    expect(failedStdout.text()).toBe("");
    expect(failedStderr.text()).toContain("injected evidence write failure");
    expect(incomplete!.lanes["owned-crashed"]).toMatchObject({
      runtimeState: "crashed",
      verificationRecordedAt: null,
      verificationState: "unverified",
      evidenceFile: null,
    });

    const recoveredStdout = sink();
    const recoveredStderr = sink();
    const recoveredExitCode = await runFlowCli(
      ["inspect", handle.runId],
      recoveredStdout.output,
      recoveredStderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: ledgerRoot },
        runtimeFactory: (runtimeLedger) =>
          new WorkflowRuntime({
            adapter,
            ledger: new RejectLeaseLedger(runtimeLedger),
            clock: clock.now,
            idgen: () => "unused",
            readResultFile: adapter.readResultFile,
            sleep: async () => {},
          }),
      },
    );
    const recovered = await ledger.load(handle.runId);

    expect(recoveredExitCode).toBe(0);
    expect(recoveredStderr.text()).toBe("");
    expect(recoveredStdout.text()).toContain("runtimeState=crashed");
    expect(recovered!.lanes["owned-crashed"]).toMatchObject({
      runtimeState: "crashed",
      contractState: "violated",
      verificationState: "failed",
    });
    expect(
      JSON.parse(
        await readFile(
          recovered!.lanes["owned-crashed"]!.evidenceFile!,
          "utf8",
        ),
      ),
    ).toMatchObject({
      runId: handle.runId,
      laneId: "owned-crashed",
      termination: "crashed",
    });
  });

  test("takeover and release durably flip and render lane control mode", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root, { finished: false });

    const takeover = await flow(root, "takeover", "run-cli", "lane-1");
    const takenOver = await new FsLedger(root).load("run-cli");
    const release = await flow(root, "release", "run-cli", "lane-1");
    const released = await new FsLedger(root).load("run-cli");
    await flow(root, "takeover", "run-cli", "lane-1");
    const inspect = await flow(root, "inspect", "run-cli");

    expect(takeover.exitCode).toBe(0);
    expect(takeover.stdout).toContain("controlMode=human_owned");
    expect(takenOver!.lanes["lane-1"]!.controlMode).toBe("human_owned");
    expect(release.exitCode).toBe(0);
    expect(release.stdout).toContain("controlMode=managed");
    expect(released!.lanes["lane-1"]!.controlMode).toBe("managed");
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain("controlMode=human_owned");
  });

  test("resume reports an already-finished run without changing its event history", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);
    const eventFile = join(root, "runs", "run-cli", "events.jsonl");
    const before = await readFile(eventFile, "utf8");

    const result = await flow(root, "resume", "run-cli");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state=complete");
    expect(result.stdout).toContain(
      "runtimeState=exited semanticState=complete contractState=satisfied verificationState=verified",
    );
    expect(await readFile(eventFile, "utf8")).toBe(before);
  });

  test("resume reconstructs, reconciles, reattaches, and renders the finished durable run", async () => {
    const root = await tempRoot();
    const ledgerRoot = join(root, "ledger");
    const cwd = join(root, "work");
    const clock = createClock(1_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "window-exit", exitCode: 0 },
        { laneId: "still-live", exitCode: 0 },
      ],
    });
    const sourceLedger = new DurableEventsWithoutLease(
      new FsLedger(ledgerRoot),
    );
    const source = new WorkflowRuntime({
      adapter,
      ledger: sourceLedger,
      clock: clock.now,
      idgen: () => "run-cli-resume",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "window-exit", steps: 1 },
        { laneId: "still-live", steps: 1 },
      ],
    });
    for (const laneId of handle.laneIds) {
      await source.confirmLaneStarted(handle.runId, laneId);
    }
    await adapter.waitForOutput(
      { id: adapter.paneIdForLane("window-exit")! },
      "ignored",
      1,
    );
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["resume", handle.runId],
      stdout.output,
      stderr.output,
      {
        environment: {
          ...process.env,
          FLOW_LEDGER_ROOT: ledgerRoot,
          FLOW_LANE_TIMEOUT_MS: "1000",
        },
        runtimeFactory: (ledger) =>
          new WorkflowRuntime({
            adapter,
            ledger,
            clock: clock.now,
            idgen: () => "unused",
            readResultFile: adapter.readResultFile,
            sleep: async () => {},
          }),
      },
    );
    const loaded = await new FsLedger(ledgerRoot).load(handle.runId);

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("state=complete finishStatus=clean");
    expect(stdout.text()).toContain(
      "runtimeState=exited semanticState=complete contractState=satisfied verificationState=verified",
    );
    expect(loaded).toMatchObject({
      controllerEpoch: 1,
      finishStatus: "clean",
      breakdown: {
        exitedZero: 2,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    });
  });

  test("resume exits non-zero while the durable controller holder is alive", async () => {
    const root = await tempRoot();
    const ledgerRoot = join(root, "ledger");
    const clock = createClock(2_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "live", exitCode: 0 }],
    });
    const sourceLedger = new FsLedger(ledgerRoot, () => true);
    const source = new WorkflowRuntime({
      adapter,
      ledger: sourceLedger,
      clock: clock.now,
      idgen: () => "run-cli-live",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    await source.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd: join(root, "work"),
      lanes: [{ laneId: "live", steps: 1 }],
    });
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      ["resume", "run-cli-live"],
      stdout.output,
      stderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: ledgerRoot },
        runtimeFactory: (ledger) =>
          new WorkflowRuntime({
            adapter,
            ledger,
            clock: clock.now,
            idgen: () => "unused",
            readResultFile: adapter.readResultFile,
            sleep: async () => {},
          }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain(
      'controller lease for run "run-cli-live" is already held',
    );
    expect((await sourceLedger.load("run-cli-live"))!.controllerEpoch).toBe(0);
    expect(adapter.dispatched).toHaveLength(1);
  });

  test("status stays pure while inspect finishes an all-terminal replay", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root, { finished: false });

    const status = await flow(root, "status");
    const inspect = await flow(root, "inspect", "run-cli");

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("state=incomplete");
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain("state=complete");
    expect(inspect.stdout).toContain("finishStatus=clean");
  });

  test("decide records every supplied value without rewriting free text", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(
      [
        "decide",
        "run-cli",
        "--note",
        " preserve this note verbatim ",
        "--issue-state",
        " ready-for-human ",
        "--decision",
        "accepted",
      ],
      stdout.output,
      stderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: root },
        runtimeFactory: (ledger) =>
          new WorkflowRuntime({
            adapter: new FakeHerdrAdapter({
              clock: createClock(1_000),
              lanes: [],
            }),
            ledger,
            clock: () => 2_000,
            idgen: () => "unused",
            readResultFile: async () => "",
            sleep: async () => {},
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("runId=run-cli");
    expect((await new FsLedger(root).load("run-cli"))?.decisions).toEqual([
      {
        sequence: 11,
        at: 2_000,
        actor: "human",
        decision: "accepted",
        note: " preserve this note verbatim ",
        resultingIssueState: " ready-for-human ",
      },
    ]);

    const emptyNoteStdout = sink();
    const emptyNoteStderr = sink();
    const emptyNoteExitCode = await runFlowCli(
      [
        "decide",
        "run-cli",
        "--decision",
        "rejected",
        "--note",
        "",
      ],
      emptyNoteStdout.output,
      emptyNoteStderr.output,
      {
        environment: { ...process.env, FLOW_LEDGER_ROOT: root },
        runtimeFactory: (ledger) =>
          new WorkflowRuntime({
            adapter: new FakeHerdrAdapter({
              clock: createClock(1_000),
              lanes: [],
            }),
            ledger,
            clock: () => 2_000,
            idgen: () => "unused",
            readResultFile: async () => "",
            sleep: async () => {},
          }),
      },
    );

    expect(emptyNoteExitCode).toBe(0);
    expect(emptyNoteStderr.text()).toBe("");
    expect(
      (await new FsLedger(root).load("run-cli"))?.decisions.at(-1),
    ).toMatchObject({
      actor: "human",
      decision: "rejected",
      note: "",
      resultingIssueState: null,
    });
  });

  test("decide delivers exactly one new decision marker per invocation", async () => {
    const root = await tempRoot();
    const clock = createClock(3_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "review", exitCode: 0 }],
    });
    const tracker = new FakeIssueTracker();
    const source = new WorkflowRuntime({
      adapter,
      ledger: new FsLedger(root),
      clock: clock.now,
      idgen: () => "run-cli-decide",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      issueTracker: tracker,
    });
    const handle = await source.startWorkflow({
      workflow: "cross-review",
      workspace: "agent-flow",
      cwd: join(root, "work"),
      lanes: [{ laneId: "review", role: "reviewer", steps: 1 }],
      issue: { owner: "netfishx", repo: "agent-flow", number: 29 },
    });
    await source.confirmLaneStarted(handle.runId, "review");
    await source.awaitLane(handle.runId, "review", 1_000);
    tracker.calls.splice(0);
    const invoke = async (decision: "accepted" | "rejected") => {
      const stdout = sink();
      const stderr = sink();
      const exitCode = await runFlowCli(
        [
          "decide",
          handle.runId,
          "--decision",
          decision,
          "--note",
          `${decision} through CLI`,
        ],
        stdout.output,
        stderr.output,
        {
          environment: {
            ...process.env,
            FLOW_LEDGER_ROOT: root,
            FLOW_ISSUE_TARGET: "netfishx/agent-flow#29",
          },
          runtimeFactory: (ledger) =>
            new WorkflowRuntime({
              adapter,
              ledger,
              clock: clock.now,
              idgen: () => "unused",
              readResultFile: adapter.readResultFile,
              sleep: async () => {},
              issueTracker: tracker,
            }),
        },
      );
      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      expect(stdout.text()).toContain("state=complete");
    };

    await invoke("accepted");
    expect(
      tracker.calls
        .filter((call) => call.operation === "createComment")
        .map((call) => call.arguments[1] as string)
        .filter((body) => body.split("\n")[0]!.includes(":decision -->")),
    ).toHaveLength(1);
    await invoke("rejected");
    const decisionBodies = tracker.calls
      .filter((call) => call.operation === "createComment")
      .map((call) => call.arguments[1] as string)
      .filter((body) => body.split("\n")[0]!.includes(":decision -->"));
    expect(decisionBodies).toHaveLength(2);
    expect(new Set(decisionBodies.map((body) => body.split("\n")[0])).size)
      .toBe(2);
  });

  test.each([
    ["unknown verb", ["unknown"]],
    ["missing run id", ["decide", "--decision", "accepted", "--note", "x"]],
    [
      "extra positional",
      ["decide", "run-cli", "extra", "--decision", "accepted", "--note", "x"],
    ],
    ["missing decision", ["decide", "run-cli", "--note", "x"]],
    ["missing note", ["decide", "run-cli", "--decision", "accepted"]],
    [
      "flag without value",
      ["decide", "run-cli", "--decision", "accepted", "--note"],
    ],
    [
      "repeated flag",
      [
        "decide",
        "run-cli",
        "--decision",
        "accepted",
        "--decision",
        "rejected",
        "--note",
        "x",
      ],
    ],
    [
      "unknown flag",
      [
        "decide",
        "run-cli",
        "--decision",
        "accepted",
        "--note",
        "x",
        "--author",
        "owner",
      ],
    ],
    [
      "invalid decision",
      ["decide", "run-cli", "--decision", "maybe", "--note", "x"],
    ],
  ] as const)("decide rejects %s with the usage error", async (_name, args) => {
    const stdout = sink();
    const stderr = sink();

    const exitCode = await runFlowCli(args, stdout.output, stderr.output);

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toStartWith("usage: flow status");
    expect(stderr.text()).toContain("flow decide <runId>");
  });

  test("existing verbs keep their usage errors", async () => {
    const root = await tempRoot();
    expect((await flow(root, "inspect")).exitCode).not.toBe(0);
    expect((await flow(root, "takeover", "run-cli")).exitCode).toBe(2);
    expect((await flow(root, "release")).exitCode).toBe(2);
  });

  test("an unusable ledger root fails loudly without an in-memory fallback", async () => {
    const root = await tempRoot();
    const unusable = join(root, "not-a-directory");
    await writeFile(unusable, "file", "utf8");

    const result = await flow(unusable, "status");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("a nonexistent ledger root fails loudly for status and inspect", async () => {
    const parent = await tempRoot();
    const missing = join(parent, "missing-ledger");

    for (const args of [["status"], ["inspect", "run-missing"]]) {
      const result = await flow(missing, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ledger root");
    }
  });

  test("an existing ledger root with an empty runs directory lists normally", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "runs"));

    const result = await flow(root, "status");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("flow:");
  });

  test("status and inspect fail closed for an ambiguous run", async () => {
    const root = await tempRoot();
    await expect(
      new AmbiguousCommitLedger(root).commit(ambiguousRunStarted()),
    ).rejects.toThrow(/append failure.*rollback failure/);

    const status = await flow(root, "status");
    const inspect = await flow(root, "inspect", "run-poisoned");

    expect(status.exitCode).not.toBe(0);
    expect(status.stderr).toContain('run "run-poisoned" has an ambiguous commit');
    expect(status.stdout).toBe("");
    expect(inspect.exitCode).not.toBe(0);
    expect(inspect.stderr).toContain('run "run-poisoned" has an ambiguous commit');
    expect(inspect.stdout).toBe("");
  });
});
