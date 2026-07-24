// Unattended real-stack human-ownership recovery smoke.
//
// The first controller is killed only after a takeover lands during a real
// awaitLane wait slice and the managed sibling finishes. A fresh CLI resume
// preserves both owned lanes, inspect collects a self-terminated lane, and a
// second tracked controller proves release restores a real managed wait/exit.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import type { PaneRef, WaitOutcome } from "../herdr/types.ts";
import type { RunnerEvidence } from "../runtime/events.ts";
import {
  FsLedger,
  realPidIsAlive,
  resolveLedgerRoot,
} from "../runtime/fs-ledger.ts";
import type { LeaseHandle, Ledger } from "../runtime/ledger.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import type { LaneSpec, RuntimeDeps } from "../runtime/types.ts";
import {
  summarizeInSliceAbort,
  summarizeInspectCollection,
  summarizePostReleaseDrive,
} from "./takeover-report.ts";

const env = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? fallback : value;
};

const num = (key: string, fallback: number): number => {
  const configured = process.env[key];
  if (configured === undefined || configured.length === 0) return fallback;
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const line = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function config() {
  const evidenceDir = env(
    "FLOW_EVIDENCE_DIR",
    `/private/tmp/agent-flow-takeover-${process.pid}`,
  );
  return {
    workspace: env("FLOW_WORKSPACE", "w1"),
    runId: env(
      "FLOW_RUN_ID",
      `flow-takeover-${Date.now().toString(36)}-${process.pid.toString(36)}`,
    ),
    managedLaneCount: num("FLOW_MANAGED_LANES", 3),
    shortSteps: num("FLOW_SHORT_STEPS", 3),
    ownedLongSteps: num("FLOW_LONG_STEPS", 12),
    releaseLongSteps: num("FLOW_RELEASE_LONG_STEPS", 30),
    delay: num("FLOW_DELAY", 1),
    driveSliceMs: num("FLOW_DRIVE_SLICE_MS", 2_000),
    evidenceDir,
    driveWaitMarker: env(
      "FLOW_DRIVE_WAIT_MARKER",
      join(evidenceDir, "drive-wait-started.json"),
    ),
    driveResultFile: env(
      "FLOW_DRIVE_RESULT",
      join(evidenceDir, "drive-result.json"),
    ),
    releaseWaitMarker: env(
      "FLOW_RELEASE_WAIT_MARKER",
      join(evidenceDir, "release-wait-started.json"),
    ),
    releaseResultFile: env(
      "FLOW_RELEASE_RESULT",
      join(evidenceDir, "release-drive-result.json"),
    ),
    readyTimeoutMs: num("FLOW_CONTROLLER_READY_TIMEOUT_MS", 30_000),
    laneTimeoutMs: num("FLOW_LANE_TIMEOUT_MS", 90_000),
    ledgerRoot: resolveLedgerRoot(),
    ownedLaneId: "long-owned",
    releaseLaneId: "long-release",
  };
}

class LeaseFreeLedger implements Ledger {
  constructor(private readonly delegate: Ledger) {}

  commit(event: Parameters<Ledger["commit"]>[0]): Promise<void> {
    return this.delegate.commit(event);
  }

  load(runId: string) {
    return this.delegate.load(runId);
  }

  list() {
    return this.delegate.list();
  }

  async acquireLease(): Promise<LeaseHandle> {
    return { release: async () => {} };
  }
}

class TrackingRealHerdrAdapter extends RealHerdrAdapter {
  targetWaitCount = 0;
  private markerWritten = false;

  constructor(
    private readonly targetPaneId: string,
    private readonly waitMarker: string,
  ) {
    super();
  }

  override async waitForOutput(
    pane: PaneRef,
    regex: string,
    timeoutMs: number,
  ): Promise<WaitOutcome> {
    if (pane.id === this.targetPaneId) {
      this.targetWaitCount += 1;
      if (!this.markerWritten) {
        this.markerWritten = true;
        await Bun.write(
          this.waitMarker,
          `${JSON.stringify({
            paneId: pane.id,
            targetWaitCount: this.targetWaitCount,
            at: Date.now(),
          })}\n`,
        );
      }
    }
    return super.waitForOutput(pane, regex, timeoutMs);
  }
}

function makeDeps(
  ledger: Ledger,
  runId: string,
  adapter: RealHerdrAdapter,
  driveSliceMs: number,
): RuntimeDeps {
  return {
    adapter,
    ledger,
    clock: () => Date.now(),
    idgen: () => runId,
    readResultFile: (path) => Bun.file(path).text(),
    sleep,
    driveSliceMs,
  };
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DriveResult {
  readonly targetWaitCount: number;
  readonly controllerThrew: boolean;
  readonly statusState: string | null;
  readonly error: string | null;
}

async function flow(
  ledgerRoot: string,
  laneTimeoutMs: number,
  ...args: string[]
): Promise<CliResult> {
  const child = Bun.spawn(["bun", "run", "flow", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      FLOW_LEDGER_ROOT: ledgerRoot,
      FLOW_LANE_TIMEOUT_MS: String(laneTimeoutMs),
    },
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

async function waitForFile(
  path: string,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await Bun.file(path).exists()) return;
    if (Date.now() >= deadline) {
      throw new Error(`${description} did not appear within ${timeoutMs}ms`);
    }
    await sleep(100);
  }
}

async function waitForLaneGone(
  adapter: RealHerdrAdapter,
  paneId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await adapter.processInfo({ id: paneId });
    if (info.foregroundProcessGroupId === info.shellPid) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `human-owned lane did not self-terminate within ${timeoutMs}ms`,
      );
    }
    await sleep(100);
  }
}

async function assertLaneLive(
  adapter: RealHerdrAdapter,
  paneId: string,
  message: string,
): Promise<void> {
  const info = await adapter.processInfo({ id: paneId });
  if (info.foregroundProcessGroupId === info.shellPid) {
    throw new Error(message);
  }
}

function laneStates(run: NonNullable<Awaited<ReturnType<FsLedger["load"]>>>) {
  return run.laneOrder.map((laneId) => ({
    laneId,
    controlMode: run.lanes[laneId]!.controlMode,
    runtimeState: run.lanes[laneId]!.runtimeState,
  }));
}

async function closeHerdrTab(tabId: string): Promise<void> {
  const child = Bun.spawn(["herdr", "tab", "close", tabId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `herdr tab close failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  }
}

async function setupRun(): Promise<string> {
  const c = config();
  await mkdir(c.evidenceDir, { recursive: true });
  const ledger = new FsLedger(c.ledgerRoot);
  const adapter = new RealHerdrAdapter();
  const runtime = new WorkflowRuntime(
    makeDeps(
      new LeaseFreeLedger(ledger),
      c.runId,
      adapter,
      c.driveSliceMs,
    ),
  );
  const managedLanes: LaneSpec[] = Array.from(
    { length: c.managedLaneCount },
    (_, index) => ({
      laneId: `short-${index + 1}`,
      role: "simulated",
      steps: c.shortSteps,
      stepDelaySeconds: c.delay,
    }),
  );
  const lanes: LaneSpec[] = [
    {
      laneId: c.ownedLaneId,
      role: "simulated",
      steps: c.ownedLongSteps,
      stepDelaySeconds: c.delay,
    },
    ...managedLanes,
    {
      laneId: c.releaseLaneId,
      role: "simulated",
      steps: c.releaseLongSteps,
      stepDelaySeconds: c.delay,
    },
  ];

  const handle = await runtime.startWorkflow({
    workflow: "flow-takeover-smoke",
    workspace: c.workspace,
    cwd: c.evidenceDir,
    lanes,
    splitDirection: "down",
    startupSettleMs: 1_000,
  });
  for (const laneId of handle.laneIds) {
    const live = await runtime.confirmLaneStarted(handle.runId, laneId);
    if (!live) throw new Error(`lane "${laneId}" did not become live`);
  }
  await runtime.takeoverLane(handle.runId, c.releaseLaneId);
  const loaded = await ledger.load(handle.runId);
  if (!loaded) throw new Error(`run "${handle.runId}" disappeared`);
  return loaded.tabId;
}

async function drivePhase(): Promise<void> {
  const c = config();
  const ledger = new FsLedger(c.ledgerRoot);
  const run = await ledger.load(c.runId);
  if (!run) throw new Error(`unknown runId "${c.runId}"`);
  const targetLaneId = env("FLOW_TRACK_LANE", c.ownedLaneId);
  const targetLane = run.lanes[targetLaneId];
  if (!targetLane) throw new Error(`unknown laneId "${targetLaneId}"`);
  const marker = env("FLOW_WAIT_MARKER", c.driveWaitMarker);
  const resultFile = env("FLOW_TRACK_RESULT", c.driveResultFile);
  const adapter = new TrackingRealHerdrAdapter(targetLane.paneId, marker);
  const runtime = new WorkflowRuntime(
    makeDeps(ledger, c.runId, adapter, c.driveSliceMs),
  );
  let result: DriveResult;
  try {
    const status = await runtime.resumeWorkflow(c.runId, c.laneTimeoutMs);
    result = {
      targetWaitCount: adapter.targetWaitCount,
      controllerThrew: false,
      statusState: status.state,
      error: null,
    };
  } catch (error) {
    result = {
      targetWaitCount: adapter.targetWaitCount,
      controllerThrew: true,
      statusState: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await Bun.write(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  if (result.controllerThrew) throw new Error(result.error ?? "drive failed");
  if (env("FLOW_HOLD_AFTER_DRIVE", "0") === "1") {
    for (;;) await sleep(60_000);
  }
}

function spawnTrackedController(options: {
  readonly c: ReturnType<typeof config>;
  readonly targetLaneId: string;
  readonly marker: string;
  readonly resultFile: string;
  readonly holdAfterDrive: boolean;
}) {
  return Bun.spawn(["bun", "run", import.meta.path, "__drive__"], {
    env: {
      ...process.env,
      FLOW_RUN_ID: options.c.runId,
      FLOW_EVIDENCE_DIR: options.c.evidenceDir,
      FLOW_LEDGER_ROOT: options.c.ledgerRoot,
      FLOW_WORKSPACE: options.c.workspace,
      FLOW_MANAGED_LANES: String(options.c.managedLaneCount),
      FLOW_SHORT_STEPS: String(options.c.shortSteps),
      FLOW_LONG_STEPS: String(options.c.ownedLongSteps),
      FLOW_RELEASE_LONG_STEPS: String(options.c.releaseLongSteps),
      FLOW_DELAY: String(options.c.delay),
      FLOW_DRIVE_SLICE_MS: String(options.c.driveSliceMs),
      FLOW_LANE_TIMEOUT_MS: String(options.c.laneTimeoutMs),
      FLOW_TRACK_LANE: options.targetLaneId,
      FLOW_WAIT_MARKER: options.marker,
      FLOW_TRACK_RESULT: options.resultFile,
      FLOW_HOLD_AFTER_DRIVE: options.holdAfterDrive ? "1" : "0",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function parentPhase(): Promise<void> {
  const c = config();
  // config() generates a fresh random runId when FLOW_RUN_ID is unset; pin it
  // so setupRun() and the drive children all resolve the SAME run.
  process.env.FLOW_RUN_ID = c.runId;
  await mkdir(c.evidenceDir, { recursive: true });
  line("== agent-flow live ownership smoke ==");
  line(`runId=${c.runId} evidence=${c.evidenceDir}`);

  let tabId: string | null = null;
  let tabClosed = false;
  let controller:
    | ReturnType<typeof spawnTrackedController>
    | null = null;
  let controllerReaped = false;
  try {
    tabId = await setupRun();
    controller = spawnTrackedController({
      c,
      targetLaneId: c.ownedLaneId,
      marker: c.driveWaitMarker,
      resultFile: c.driveResultFile,
      holdAfterDrive: true,
    });
    const controllerPid = controller.pid;

    await waitForFile(
      c.driveWaitMarker,
      c.readyTimeoutMs,
      "owned-lane wait marker",
    );
    const takeover = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "takeover",
      c.runId,
      c.ownedLaneId,
    );
    if (takeover.exitCode !== 0) {
      throw new Error(
        `takeover failed: exit=${takeover.exitCode} stderr=${takeover.stderr.trim()}`,
      );
    }
    await waitForFile(
      c.driveResultFile,
      c.laneTimeoutMs,
      "first controller result",
    );
    const driveResult = JSON.parse(
      await readFile(c.driveResultFile, "utf8"),
    ) as DriveResult;
    const afterTakeoverDrive = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!afterTakeoverDrive) throw new Error(`run "${c.runId}" disappeared`);
    const ownedAfterDrive = afterTakeoverDrive.lanes[c.ownedLaneId]!;
    const managedLaneIds = afterTakeoverDrive.laneOrder.filter((laneId) =>
      laneId.startsWith("short-"),
    );
    // A degraded sibling (crashed/lost/failed_to_start) must NOT count as
    // completion: the managed sibling has to finish clean while the owned lane
    // is taken over. (The in-slice proof is targetWaitCount===1 in
    // summarizeInSliceAbort -- a takeover landing before the wait yields 0 and
    // is rejected there, so the marker-before-block timing cannot false-pass.)
    const siblingComplete = managedLaneIds.every((laneId) => {
      const sibling = afterTakeoverDrive.lanes[laneId]!;
      return sibling.runtimeState === "exited" && sibling.exitCode === 0;
    });
    const inSliceAbort = summarizeInSliceAbort({
      waitStarted: await Bun.file(c.driveWaitMarker).exists(),
      targetWaitCount: driveResult.targetWaitCount,
      controllerThrew: driveResult.controllerThrew,
      ownedRuntimeState: ownedAfterDrive.runtimeState,
      ownedControlMode: ownedAfterDrive.controlMode,
      siblingComplete,
    });
    await assertLaneLive(
      new RealHerdrAdapter(),
      ownedAfterDrive.paneId,
      "owned lane was not left live after in-slice takeover",
    );
    line("takeover landed during a real wait; sibling managed lanes completed");

    controller.kill("SIGKILL");
    const controllerExitCode = await controller.exited;
    controllerReaped = true;
    await sleep(100);
    if (realPidIsAlive(controllerPid)) {
      throw new Error(`SIGKILLed controller pid ${controllerPid} is still alive`);
    }

    const resumeAfterLoss = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "resume",
      c.runId,
    );
    if (resumeAfterLoss.exitCode !== 0) {
      throw new Error(
        `resume after controller loss failed: exit=${resumeAfterLoss.exitCode} stderr=${resumeAfterLoss.stderr.trim()}`,
      );
    }
    const afterLossResume = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!afterLossResume) throw new Error(`run "${c.runId}" disappeared`);
    const ownedAfterLoss = afterLossResume.lanes[c.ownedLaneId]!;
    const releaseAfterLoss = afterLossResume.lanes[c.releaseLaneId]!;
    if (
      ownedAfterLoss.controlMode !== "human_owned" ||
      ownedAfterLoss.runtimeState !== "running" ||
      releaseAfterLoss.controlMode !== "human_owned" ||
      releaseAfterLoss.runtimeState !== "running"
    ) {
      throw new Error("resume after controller loss did not preserve ownership");
    }
    await assertLaneLive(
      new RealHerdrAdapter(),
      ownedAfterLoss.paneId,
      "fresh resume drove the human-owned lane",
    );
    line("fresh flow resume preserved and reconciled owned lanes without drive");

    const adapter = new RealHerdrAdapter();
    await waitForLaneGone(
      adapter,
      ownedAfterLoss.paneId,
      c.laneTimeoutMs,
    );
    await assertLaneLive(
      adapter,
      releaseAfterLoss.paneId,
      "release proof lane terminated before release",
    );

    const inspect = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "inspect",
      c.runId,
    );
    if (inspect.exitCode !== 0) {
      throw new Error(
        `inspect failed: exit=${inspect.exitCode} stderr=${inspect.stderr.trim()}`,
      );
    }
    const afterInspect = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!afterInspect) throw new Error(`run "${c.runId}" disappeared`);
    const ownedAfterInspect = afterInspect.lanes[c.ownedLaneId]!;
    const inspectEvidence =
      ownedAfterInspect.evidenceFile === null
        ? null
        : JSON.parse(
            await readFile(ownedAfterInspect.evidenceFile, "utf8"),
          ) as RunnerEvidence;
    const inspectCollected = summarizeInspectCollection({
      exitCode: inspect.exitCode,
      runId: c.runId,
      laneId: c.ownedLaneId,
      runtimeState: ownedAfterInspect.runtimeState,
      controlMode: ownedAfterInspect.controlMode,
      contractState: ownedAfterInspect.contractState,
      verificationState: ownedAfterInspect.verificationState,
      evidenceFile: ownedAfterInspect.evidenceFile,
      evidence: inspectEvidence,
    });
    line("flow inspect collected self-terminated owned-lane evidence");

    const releaseBeforeFlip = afterInspect.lanes[c.releaseLaneId]!;
    if (
      releaseBeforeFlip.runtimeState !== "running" ||
      releaseBeforeFlip.controlMode !== "human_owned"
    ) {
      throw new Error("release proof lane was not live and human_owned");
    }
    await assertLaneLive(
      adapter,
      releaseBeforeFlip.paneId,
      "release proof lane was not running before release",
    );
    const release = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "release",
      c.runId,
      c.releaseLaneId,
    );
    if (release.exitCode !== 0) {
      throw new Error(
        `release failed: exit=${release.exitCode} stderr=${release.stderr.trim()}`,
      );
    }

    const releaseController = spawnTrackedController({
      c,
      targetLaneId: c.releaseLaneId,
      marker: c.releaseWaitMarker,
      resultFile: c.releaseResultFile,
      holdAfterDrive: false,
    });
    await waitForFile(
      c.releaseWaitMarker,
      c.readyTimeoutMs,
      "post-release wait marker",
    );
    const releaseControllerExit = await releaseController.exited;
    await waitForFile(
      c.releaseResultFile,
      c.laneTimeoutMs,
      "post-release controller result",
    );
    const releaseDriveResult = JSON.parse(
      await readFile(c.releaseResultFile, "utf8"),
    ) as DriveResult;
    const finished = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!finished) throw new Error(`run "${c.runId}" disappeared`);
    const releasedLane = finished.lanes[c.releaseLaneId]!;
    const postReleaseDrive = summarizePostReleaseDrive({
      wasRunningBeforeRelease: releaseBeforeFlip.runtimeState === "running",
      waitStarted: await Bun.file(c.releaseWaitMarker).exists(),
      targetWaitCount: releaseDriveResult.targetWaitCount,
      controllerThrew:
        releaseDriveResult.controllerThrew || releaseControllerExit !== 0,
      runtimeState: releasedLane.runtimeState,
      exitCode: releasedLane.exitCode,
    });
    if (finished.finishStatus === null) {
      throw new Error("post-release drive did not finish the run");
    }
    line("release restored a real managed wait and exit");

    const reportPath = join(c.evidenceDir, "smoke-result.json");
    const report = {
      runId: c.runId,
      waitStarted: {
        marker: c.driveWaitMarker,
        observed: true,
      },
      takeover: {
        exitCode: takeover.exitCode,
        laneId: c.ownedLaneId,
      },
      inSliceAbort,
      siblingCompletion: {
        laneIds: managedLaneIds,
        complete: siblingComplete,
      },
      controller: {
        pid: controllerPid,
        killedWith: "SIGKILL",
        exitCode: controllerExitCode,
        reaped: controllerReaped,
      },
      resumeAfterControllerLoss: {
        exitCode: resumeAfterLoss.exitCode,
        ownedRuntimeState: ownedAfterLoss.runtimeState,
        ownedControlMode: ownedAfterLoss.controlMode,
        releaseRuntimeState: releaseAfterLoss.runtimeState,
        releaseControlMode: releaseAfterLoss.controlMode,
      },
      inspectEvidence: inspectCollected,
      release: {
        exitCode: release.exitCode,
        laneId: c.releaseLaneId,
      },
      postReleaseDrive,
      finishStatus: finished.finishStatus,
      lanes: {
        afterTakeoverDrive: laneStates(afterTakeoverDrive),
        afterControllerLossResume: laneStates(afterLossResume),
        afterInspect: laneStates(afterInspect),
        finished: laneStates(finished),
      },
      ok: true,
    };
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    await closeHerdrTab(tabId);
    tabClosed = true;
    line(`smoke-result path=${reportPath}`);
    line("FLOW_TAKEOVER_SMOKE_DONE=0");
  } finally {
    if (
      controller !== null &&
      !controllerReaped &&
      realPidIsAlive(controller.pid)
    ) {
      controller.kill("SIGKILL");
      await controller.exited;
    }
    if (tabId !== null && !tabClosed) {
      try {
        await closeHerdrTab(tabId);
      } catch (error) {
        line(
          `FLOW_TAKEOVER_SMOKE_CLEANUP_ERROR: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("__drive__")) {
    await drivePhase();
    return;
  }
  await parentPhase();
}

main().catch((error) => {
  line(
    `FLOW_TAKEOVER_SMOKE_ERROR: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 2;
});
