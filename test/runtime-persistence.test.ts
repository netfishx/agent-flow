import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeHerdrAdapter, createClock } from "../src/herdr/fake-adapter.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { FixedPoint, RunEvent } from "../src/runtime/events.ts";
import type { LeaseHandle, Ledger } from "../src/runtime/ledger.ts";
import type { RunView } from "../src/runtime/reducer.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
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

class InspectableWorkflowRuntime extends WorkflowRuntime {
  currentView(runId: string): RunView {
    return this.runView(runId);
  }
}

describe("persisted terminal lane facts", () => {
  test("a fresh ledger loads fixed point and all four dimensions with distinct artifacts", async () => {
    const { ledgerRoot, cwd } = await directories();
    const clock = createClock(1_000);
    const adapter = new FakeHerdrAdapter({
      clock,
      lanes: [{ laneId: "lane-1", exitCode: 0 }],
    });
    const runtime = new InspectableWorkflowRuntime({
      adapter,
      ledger: new FsLedger(ledgerRoot),
      clock: clock.now,
      idgen: () => "run-persist",
      readResultFile: adapter.readResultFile,
      sleep: async () => {},
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
    expect(lane.checkpointFile).toBe(join(cwd, "checkpoints", "lane-1.md"));
    expect(lane.resultFile).toBe(join(cwd, "results", "lane-1-result.txt"));
    expect(lane.evidenceFile).toBe(join(cwd, "evidence", "lane-1-evidence.json"));
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

    expect((await ledger.load(handle.runId))!.lanes["lane-1"]).toMatchObject({
      runtimeState: "exited",
      semanticState: "partial",
      contractState: "satisfied",
      verificationState: "verified",
      exitCode: 130,
    });
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
    ).toMatchObject({ termination: "crashed", exitCode: null });
    expect(
      JSON.parse(await readFile(loaded!.lanes.lost!.evidenceFile!, "utf8")),
    ).toMatchObject({ termination: "lost", exitCode: null });
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

  test("a failed fact append is retried before run_finished", async () => {
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
    expect((await durable.load(handle.runId))!.finishStatus).toBeNull();

    await expect(runtime.awaitLane(handle.runId, "lane-1", 1_000)).resolves.toMatchObject({
      state: "complete",
      exitCode: 0,
    });
    expect((await durable.load(handle.runId))!.finishStatus).toBe("clean");
  });
});
