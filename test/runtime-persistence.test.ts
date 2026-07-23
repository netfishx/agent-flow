import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import type { PaneRef } from "../src/herdr/types.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { FixedPoint, RunEvent } from "../src/runtime/events.ts";
import type { LeaseHandle, Ledger } from "../src/runtime/ledger.ts";
import type { RunView } from "../src/runtime/reducer.ts";
import { PartialDispatchError, WorkflowRuntime } from "../src/runtime/runtime.ts";
import { buildLaneCommand } from "../src/smoke/lane.ts";
import { SmokeRuntime } from "../src/smoke/smoke-runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function directories(): Promise<{ ledgerRoot: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-runtime-"));
  roots.push(root);
  return { ledgerRoot: join(root, "ledger"), cwd: join(root, "work") };
}

const fixedPoint: FixedPoint = {
  repoRoot: "/repo/with spaces",
  baseCommit: "base123",
  headCommit: "head456",
  diffHash: "sha256:abc",
  dirtyStatePolicy: "record-hash",
  capturedAt: 123_456,
};

class RejectFactOnceLedger implements Ledger {
  private rejected = false;

  constructor(private readonly delegate: FsLedger) {}

  commit(event: RunEvent): Promise<void> {
    if (!this.rejected && event.type === "lane_contract_evaluated") {
      this.rejected = true;
      return Promise.reject(new Error("injected contract append failure"));
    }
    return this.delegate.commit(event);
  }

  load(runId: string): Promise<RunView | null> {
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    return this.delegate.acquireLease(runId, controller);
  }
}

class RejectEventTypeLedger implements Ledger {
  constructor(
    private readonly delegate: FsLedger,
    private readonly rejectedType: RunEvent["type"],
  ) {}

  commit(event: RunEvent): Promise<void> {
    if (event.type === this.rejectedType) {
      return Promise.reject(new Error(`injected ${event.type} failure`));
    }
    return this.delegate.commit(event);
  }

  load(runId: string): Promise<RunView | null> {
    return this.delegate.load(runId);
  }

  list(): Promise<{ runId: string }[]> {
    return this.delegate.list();
  }

  acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    return this.delegate.acquireLease(runId, controller);
  }
}

class InspectableWorkflowRuntime extends WorkflowRuntime {
  currentView(runId: string): RunView {
    return this.runView(runId);
  }
}

class ShellExecutingFakeAdapter extends FakeHerdrAdapter {
  override async runInPane(pane: PaneRef, command: string): Promise<void> {
    const child = Bun.spawn(["bash", "-c", command], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`shell-backed lane exited ${exitCode}`);
    }
    await super.runInPane(pane, command);
  }
}

describe("persisted terminal lane facts", () => {
  test("run_started commit failure releases the pre-dispatch controller lease", async () => {
    const { ledgerRoot, cwd } = await directories();
    const durable = new FsLedger(ledgerRoot);
    const adapter = new FakeHerdrAdapter({
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger: new RejectEventTypeLedger(durable, "run_started"),
      clock: () => 10_000,
      idgen: () => "run-start-rejected",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });

    await expect(
      runtime.startWorkflow({
        workflow: "cross-review",
        workspace: "w1",
        cwd,
        lanes: [{ laneId: "lane-1", steps: 1 }],
      }),
    ).rejects.toThrow(/run_started failure/);
    expect(adapter.dispatched).toHaveLength(0);
    expect(await durable.load("run-start-rejected")).toBeNull();
    const reacquired = await new FsLedger(ledgerRoot).acquireLease(
      "run-start-rejected",
      { controllerId: "after-start-failure", pid: 10_001 },
    );
    await reacquired.release();
  });

  test("lane_registered commit failure is structured and releases its lease", async () => {
    const { ledgerRoot, cwd } = await directories();
    const durable = new FsLedger(ledgerRoot);
    const adapter = new FakeHerdrAdapter({
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger: new RejectEventTypeLedger(durable, "lane_registered"),
      clock: () => 11_000,
      idgen: () => "run-register-rejected",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    let failure: unknown;

    try {
      await runtime.startWorkflow({
        workflow: "cross-review",
        workspace: "w1",
        cwd,
        lanes: [{ laneId: "lane-1", steps: 1 }],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PartialDispatchError);
    expect(failure).toMatchObject({
      runId: "run-register-rejected",
      startedLaneIds: [],
    });
    expect(adapter.dispatched).toHaveLength(0);
    expect((await durable.load("run-register-rejected"))!.workflow).toBe(
      "cross-review",
    );
    const reacquired = await new FsLedger(ledgerRoot).acquireLease(
      "run-register-rejected",
      { controllerId: "after-register-failure", pid: 11_001 },
    );
    await reacquired.release();
  });

  test("a fresh ledger loads fixed point and all four dimensions with distinct artifacts", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(1_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    let commandBuilds = 0;
    const runtime = new InspectableWorkflowRuntime({
      adapter,
      ledger: new FsLedger(ledgerRoot),
      clock: clock.now,
      idgen: () => "run-persist",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
      laneCommandBuilder: (input) =>
        `${buildLaneCommand(input)} command-build=${++commandBuilds}`,
    });

    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      fixedPoint,
      lanes: [{ laneId: "lane-1", role: "reviewer", steps: 1 }],
    });
    await expect(
      new FsLedger(ledgerRoot).acquireLease(handle.runId, {
        controllerId: "other-controller",
        pid: 999,
      }),
    ).rejects.toThrow(/already held/);
    await runtime.confirmLaneStarted(handle.runId, "lane-1");
    await runtime.awaitLane(handle.runId, "lane-1", 1_000);

    const loaded = await new FsLedger(ledgerRoot).load(handle.runId);
    const eventLines = (
      await readFile(join(ledgerRoot, "runs", handle.runId, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(loaded!.lastAppliedSequence).toBe(eventLines.length);
    expect(commandBuilds).toBe(1);
    expect(loaded).toEqual(runtime.currentView(handle.runId));
    expect(loaded!.fixedPoint).toEqual(fixedPoint);
    expect(loaded!.lanes["lane-1"]).toMatchObject({
      runtimeState: "exited",
      semanticState: "complete",
      contractState: "satisfied",
      verificationState: "verified",
      controlMode: "managed",
      exitCode: 0,
    });
    const lane = loaded!.lanes["lane-1"]!;
    expect(lane.checkpointFile).toBe(
      join(cwd, "run-persist", "checkpoints", "lane-1.md"),
    );
    expect(lane.resultFile).toBe(
      join(cwd, "run-persist", "results", "lane-1-result.txt"),
    );
    expect(lane.evidenceFile).toBe(
      join(cwd, "run-persist", "evidence", "lane-1-evidence.json"),
    );
    expect(lane.logFile).toBe(
      join(cwd, "run-persist", "logs", "lane-1.log"),
    );
    expect(lane.logFile).not.toBe(lane.checkpointFile);
    expect(lane.checkpointFile).not.toBe(lane.resultFile);
    expect(lane.resultFile).not.toBe(lane.evidenceFile);
    expect(await readFile(lane.checkpointFile!, "utf8")).toContain(
      "STATUS: complete",
    );
    expect(await readFile(lane.resultFile!, "utf8")).toMatch(
      /^RESULT: ok steps=\d+\n$/,
    );
    expect(JSON.parse(await readFile(lane.evidenceFile!, "utf8"))).toMatchObject({
      runId: handle.runId,
      laneId: "lane-1",
      command: adapter.dispatched[0]!.command,
      logFile: lane.logFile,
      dispatchedAt: 1_000,
      liveAt: 1_000,
      completedAt: 1_000,
      exitCode: 0,
      termination: "sentinel-exit",
      signal: null,
      failure: null,
      environmentFailure: null,
    });
    const reacquired = await new FsLedger(ledgerRoot).acquireLease(handle.runId, {
      controllerId: "next-controller",
      pid: 1_001,
    });
    await reacquired.release();
  });

  test("an interrupted lane records partial semantics without collapsing dimensions", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(2_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const ledger = new FsLedger(ledgerRoot);
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-interrupt",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "lane-1", steps: 5 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");
    await runtime.interruptLane(handle.runId, "lane-1");
    await runtime.awaitLane(handle.runId, "lane-1", 1_000);

    const loaded = await ledger.load(handle.runId);
    expect(loaded!.lanes["lane-1"]).toMatchObject({
      runtimeState: "exited",
      semanticState: "partial",
      contractState: "satisfied",
      verificationState: "verified",
      exitCode: 130,
    });
    expect(
      JSON.parse(
        await readFile(loaded!.lanes["lane-1"]!.evidenceFile!, "utf8"),
      ),
    ).toMatchObject({
      signal: "SIGINT",
      failure: null,
      environmentFailure: null,
    });
  });

  test("foreign stderr is durable execution evidence and fails verification", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(2_500);
    const adapter = new ShellExecutingFakeAdapter({
      clock,
      lanes: [{ laneId: "stderr-lane", exitCode: 0 }],
    });
    const ledger = new FsLedger(ledgerRoot);
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-stderr",
      readResultFile: (path) => readFile(path, "utf8"),
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        {
          laneId: "stderr-lane",
          steps: 1,
          stepDelaySeconds: -1,
        },
      ],
    });
    await runtime.confirmLaneStarted(handle.runId, "stderr-lane");
    await runtime.awaitLane(handle.runId, "stderr-lane", 1_000);

    const loaded = await ledger.load(handle.runId);
    const lane = loaded!.lanes["stderr-lane"]!;
    const durableLog = await readFile(lane.logFile, "utf8");
    const evidence = JSON.parse(
      await readFile(lane.evidenceFile!, "utf8"),
    ) as Record<string, unknown>;
    const events = (
      await readFile(
        join(ledgerRoot, "runs", handle.runId, "events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent);
    const dispatched = events.find((event) => event.type === "lane_dispatched");

    expect(durableLog).toContain("sleep");
    expect(evidence.environmentFailure).toBeString();
    expect(String(evidence.environmentFailure)).toContain("sleep");
    expect(durableLog).toContain(String(evidence.environmentFailure));
    expect(evidence).toMatchObject({
      command: adapter.dispatched[0]!.command,
      exitCode: 0,
      termination: "sentinel-exit",
      signal: null,
      failure: null,
    });
    expect(dispatched?.data).toEqual({
      command: adapter.dispatched[0]!.command,
    });
    expect(lane.verificationState).toBe("failed");
  });

  test("crashed and lost lanes skip checkpoints but still record failed facts", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(3_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        {
          laneId: "crashed",
          exitCode: 1,
          emitSentinel: false,
          waitMatches: true,
          extraOutput: ["process started"],
        },
        {
          laneId: "lost",
          exitCode: 1,
          emitSentinel: false,
          waitMatches: true,
        },
      ],
    });
    const ledger = new FsLedger(ledgerRoot);
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-failures",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "crashed", steps: 1 },
        { laneId: "lost", steps: 1 },
      ],
    });
    await runtime.confirmLaneStarted(handle.runId, "crashed");
    await expect(runtime.awaitLane(handle.runId, "crashed", 1_000)).rejects.toThrow(
      /produced no sentinel/,
    );
    await expect(runtime.awaitLane(handle.runId, "lost", 1_000)).rejects.toThrow(
      /was lost/,
    );

    const loaded = await ledger.load(handle.runId);
    expect(loaded!.lanes.crashed).toMatchObject({
      runtimeState: "crashed",
      semanticState: "unknown",
      checkpointFile: null,
      contractState: "violated",
      verificationState: "failed",
    });
    expect(loaded!.lanes.lost).toMatchObject({
      runtimeState: "lost",
      semanticState: "unknown",
      checkpointFile: null,
      contractState: "violated",
      verificationState: "failed",
    });
    expect(loaded!.lanes.crashed!.contractErrors).toContain(
      "completion sentinel missing",
    );
    expect(
      JSON.parse(
        await readFile(loaded!.lanes.crashed!.evidenceFile!, "utf8"),
      ),
    ).toMatchObject({
      termination: "crashed",
      exitCode: null,
      signal: null,
      failure: null,
      environmentFailure: "process started",
    });
    expect(
      JSON.parse(await readFile(loaded!.lanes.lost!.evidenceFile!, "utf8")),
    ).toMatchObject({
      termination: "lost",
      exitCode: null,
      signal: null,
      failure: "dispatch-outcome-unknown",
      environmentFailure: null,
    });
  });

  test("concurrent awaitLane calls emit each terminal fact exactly once", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(4_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new WorkflowRuntime({
      adapter,
      ledger: new FsLedger(ledgerRoot),
      clock: clock.now,
      idgen: () => "run-concurrent",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");
    await Promise.all([
      runtime.awaitLane(handle.runId, "lane-1", 1_000),
      runtime.awaitLane(handle.runId, "lane-1", 1_000),
    ]);

    const lines = (
      await readFile(
        join(ledgerRoot, "runs", handle.runId, "events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    for (const type of [
      "lane_checkpoint",
      "lane_contract_evaluated",
      "lane_verification_recorded",
    ]) {
      expect(lines.filter((event) => event.type === type)).toHaveLength(1);
    }
    expect(
      lines
        .filter((event) =>
          [
            "lane_checkpoint",
            "lane_contract_evaluated",
            "lane_verification_recorded",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      "lane_checkpoint",
      "lane_contract_evaluated",
      "lane_verification_recorded",
    ]);
  });

  test("smoke handoff replays into the same durable ledger as an idempotent no-op", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(5_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const deps = () => ({
      adapter,
      ledger: new FsLedger(ledgerRoot),
      clock: clock.now,
      idgen: () => "run-handoff",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const dispatch = new SmokeRuntime(deps());
    const handle = await dispatch.startWorkflow({
      workflow: "smoke",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await dispatch.confirmLaneStarted(handle.runId, "lane-1");
    const handoff = await dispatch.exportRun(handle.runId);
    const eventFile = join(ledgerRoot, "runs", handle.runId, "events.jsonl");
    const before = await readFile(eventFile, "utf8");
    await dispatch.releaseForHandoff(handle.runId);

    const collect = new SmokeRuntime(deps());
    expect(await collect.attachRun(handoff)).toEqual(handle);
    expect(await readFile(eventFile, "utf8")).toBe(before);
    await collect.awaitLane(handle.runId, "lane-1", 1_000);
    expect((await new FsLedger(ledgerRoot).load(handle.runId))!.finishStatus).toBe(
      "clean",
    );
  });

  test("a failed fact append does not block run_finished and holds the lease until retry", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(6_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const durable = new FsLedger(ledgerRoot);
    const runtime = new WorkflowRuntime({
      adapter,
      ledger: new RejectFactOnceLedger(durable),
      clock: clock.now,
      idgen: () => "run-retry-fact",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "lane-1", steps: 1 }],
    });
    await runtime.confirmLaneStarted(handle.runId, "lane-1");

    await expect(runtime.awaitLane(handle.runId, "lane-1", 1_000)).rejects.toThrow(
      /contract append failure/,
    );
    const finishedWithoutFacts = await durable.load(handle.runId);
    expect(finishedWithoutFacts!.finishStatus).toBe("clean");
    expect(finishedWithoutFacts!.lanes["lane-1"]).toMatchObject({
      contractState: "unknown",
      verificationState: "unverified",
    });
    await expect(
      new FsLedger(ledgerRoot).acquireLease(handle.runId, {
        controllerId: "too-early",
        pid: 6_001,
      }),
    ).rejects.toThrow(/already held/);

    await expect(runtime.awaitLane(handle.runId, "lane-1", 1_000)).resolves.toMatchObject({
      state: "complete",
      exitCode: 0,
    });
    const completed = await durable.load(handle.runId);
    expect(completed!.finishStatus).toBe("clean");
    expect(completed!.lanes["lane-1"]).toMatchObject({
      contractState: "satisfied",
      verificationState: "verified",
    });
    const eventFile = join(ledgerRoot, "runs", handle.runId, "events.jsonl");
    const types = (await readFile(eventFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as RunEvent).type);
    expect(types.indexOf("run_finished")).toBeLessThan(
      types.indexOf("lane_contract_evaluated"),
    );
    const reacquired = await new FsLedger(ledgerRoot).acquireLease(handle.runId, {
      controllerId: "after-facts",
      pid: 6_002,
    });
    await reacquired.release();
  });

  test("runtime-terminal siblings finish even while one lane lacks durable facts", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(7_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "missing-fact", exitCode: 0 },
        { laneId: "complete", exitCode: 0 },
      ],
    });
    const durable = new FsLedger(ledgerRoot);
    const runtime = new InspectableWorkflowRuntime({
      adapter,
      ledger: new RejectFactOnceLedger(durable),
      clock: clock.now,
      idgen: () => "run-fact-gate",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const handle = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [
        { laneId: "missing-fact", steps: 1 },
        { laneId: "complete", steps: 1 },
      ],
    });
    for (const laneId of handle.laneIds) {
      await runtime.confirmLaneStarted(handle.runId, laneId);
    }

    await expect(
      runtime.awaitLane(handle.runId, "missing-fact", 1_000),
    ).rejects.toThrow(/contract append failure/);
    await runtime.awaitLane(handle.runId, "complete", 1_000);

    const eventFile = join(ledgerRoot, "runs", handle.runId, "events.jsonl");
    const committedTypes = (await readFile(eventFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as RunEvent).type);
    expect(committedTypes).toContain("run_finished");
    expect((await durable.load(handle.runId))!.finishStatus).toBe("clean");
    expect(runtime.currentView(handle.runId).finishStatus).toBe("clean");

    await runtime.awaitLane(handle.runId, "missing-fact", 1_000);

    const completedTypes = (await readFile(eventFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as RunEvent).type);
    expect(completedTypes.filter((type) => type === "run_finished")).toHaveLength(1);
    expect((await durable.load(handle.runId))!.finishStatus).toBe("clean");
    expect(completedTypes.lastIndexOf("lane_verification_recorded")).toBeGreaterThan(
      completedTypes.indexOf("run_finished"),
    );
  });

  test("inspect records failed-to-start facts after a partial dispatch", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(8_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      failRunInPaneAfter: 1,
      lanes: [
        { laneId: "started", exitCode: 0 },
        { laneId: "rejected", exitCode: 0 },
      ],
    });
    const ledger = new FsLedger(ledgerRoot);
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => "run-partial-facts",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    let dispatchError: PartialDispatchError | null = null;
    try {
      await runtime.startWorkflow({
        workflow: "cross-review",
        workspace: "w1",
        cwd,
        lanes: [
          { laneId: "started", steps: 1 },
          { laneId: "rejected", steps: 1 },
        ],
      });
    } catch (error) {
      dispatchError = error as PartialDispatchError;
    }
    expect(dispatchError).toBeInstanceOf(PartialDispatchError);
    expect(dispatchError!.startedLaneIds).toEqual(["started"]);
    expect((await ledger.load(dispatchError!.runId))!.finishStatus).toBeNull();

    await runtime.awaitLane(dispatchError!.runId, "started", 1_000);
    const status = await runtime.inspectWorkflow(dispatchError!.runId);

    expect(status.state).toBe("partial");
    const loaded = await ledger.load(dispatchError!.runId);
    expect(loaded!.finishStatus).toBe("degraded");
    expect(loaded!.lanes.rejected).toMatchObject({
      runtimeState: "failed_to_start",
      semanticState: "unknown",
      checkpointFile: null,
      contractState: "violated",
      verificationState: "failed",
    });
    expect(loaded!.lanes.rejected!.contractErrors).toContain("lane never started");
    expect(
      JSON.parse(
        await readFile(loaded!.lanes.rejected!.evidenceFile!, "utf8"),
      ),
    ).toMatchObject({
      command: adapter.dispatched[1]!.command,
      termination: "failed_to_start",
      signal: null,
      failure: "fake: runInPane failed",
      environmentFailure: null,
      exitCode: null,
    });
    const events = (
      await readFile(
        join(ledgerRoot, "runs", dispatchError!.runId, "events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent);
    expect(
      events.some(
        (event) =>
          event.type === "lane_checkpoint" && event.laneId === "rejected",
      ),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "lane_contract_evaluated" &&
          event.laneId === "rejected",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "lane_verification_recorded" &&
          event.laneId === "rejected",
      ),
    ).toBe(true);
    const runFinishedIndex = events.findIndex(
      (event) => event.type === "run_finished",
    );
    expect(runFinishedIndex).toBeGreaterThan(-1);
    expect(
      events.findIndex(
        (event) =>
          event.type === "lane_contract_evaluated" &&
          event.laneId === "rejected",
      ),
    ).toBeGreaterThan(runFinishedIndex);
  });

  test("run and lane path segments prevent hyphen-boundary artifact collisions", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(9_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [
        { laneId: "c", exitCode: 0 },
        { laneId: "b-c", exitCode: 0 },
      ],
    });
    const runIds = ["a-b", "a"];
    const ledger = new FsLedger(ledgerRoot);
    const runtime = new WorkflowRuntime({
      adapter,
      ledger,
      clock: clock.now,
      idgen: () => runIds.shift()!,
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
    });
    const first = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "c", steps: 1 }],
    });
    await runtime.confirmLaneStarted(first.runId, "c");
    await runtime.awaitLane(first.runId, "c", 1_000);
    const second = await runtime.startWorkflow({
      workflow: "cross-review",
      workspace: "w1",
      cwd,
      lanes: [{ laneId: "b-c", steps: 1 }],
    });
    await runtime.confirmLaneStarted(second.runId, "b-c");
    await runtime.awaitLane(second.runId, "b-c", 1_000);

    const firstLane = (await ledger.load(first.runId))!.lanes.c!;
    const secondLane = (await ledger.load(second.runId))!.lanes["b-c"]!;
    expect(firstLane).toMatchObject({
      logFile: join(cwd, "a-b", "logs", "c.log"),
      checkpointFile: join(cwd, "a-b", "checkpoints", "c.md"),
      resultFile: join(cwd, "a-b", "results", "c-result.txt"),
      evidenceFile: join(cwd, "a-b", "evidence", "c-evidence.json"),
    });
    expect(secondLane).toMatchObject({
      logFile: join(cwd, "a", "logs", "b-c.log"),
      checkpointFile: join(cwd, "a", "checkpoints", "b-c.md"),
      resultFile: join(cwd, "a", "results", "b-c-result.txt"),
      evidenceFile: join(cwd, "a", "evidence", "b-c-evidence.json"),
    });
    for (const field of [
      "logFile",
      "checkpointFile",
      "resultFile",
      "evidenceFile",
    ] as const) {
      expect(firstLane[field]).not.toBe(secondLane[field]);
    }
  });
});
