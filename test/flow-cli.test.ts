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
import { runFlowCli } from "../src/cli/flow.ts";
import {
  createClock,
  FakeHerdrAdapter,
} from "../src/herdr/fake-adapter.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { RunEvent } from "../src/runtime/events.ts";
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
    },
  };
}

describe("flow CLI external behavior", () => {
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

  test("usage errors are non-zero", async () => {
    const root = await tempRoot();
    expect((await flow(root, "inspect")).exitCode).not.toBe(0);
    expect((await flow(root, "unknown")).exitCode).not.toBe(0);
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
