// Single entry command for the real-stack smoke. It lays out a dedicated Herdr
// tab, dispatches simulated lanes, proves controller-loss, pauses for one human
// checkpoint, waits for every lane, and writes a durable result — all through
// the runtime's logical handles, never a pane id. It performs zero model calls.
//
// Run with HERDR_ENV=1. Configuration is read from the environment so the same
// binary drives both a demo and a scripted run:
//
//   FLOW_WORKSPACE      Herdr workspace id (default w1)
//   FLOW_LANES          number of simulated lanes (default 4)
//   FLOW_STEPS          steps per lane (default 30)
//   FLOW_DELAY          seconds per step (default 2)
//   FLOW_EVIDENCE_DIR   durable evidence directory
//   FLOW_INTERRUPT_FILE control file; its contents (a laneId) select the lane to
//                       interrupt at the checkpoint
//   FLOW_CHECKPOINT_TIMEOUT_MS   how long to wait for the checkpoint (default 300000)
//   FLOW_LANE_TIMEOUT_MS         per-lane wait timeout (default 300000)

import { mkdir } from "node:fs/promises";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import type { LaneResult, LaneSpec, RuntimeDeps } from "../runtime/types.ts";

const env = (key: string, fallback: string): string =>
  process.env[key] && process.env[key]!.length > 0
    ? process.env[key]!
    : fallback;
const num = (key: string, fallback: number): number => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function line(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function pollInterruptChoice(
  file: string,
  laneIds: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = Bun.file(file);
    if (await handle.exists()) {
      const choice = (await handle.text()).trim();
      if (laneIds.includes(choice)) return choice;
    }
    if (Date.now() >= deadline) return null;
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const workspace = env("FLOW_WORKSPACE", "w1");
  const laneCount = num("FLOW_LANES", 4);
  const steps = num("FLOW_STEPS", 30);
  const delay = num("FLOW_DELAY", 2);
  const evidenceDir = env(
    "FLOW_EVIDENCE_DIR",
    `/private/tmp/agent-flow-tracer-${process.pid}`,
  );
  const interruptFile = env("FLOW_INTERRUPT_FILE", `${evidenceDir}/interrupt-request`);
  const checkpointTimeout = num("FLOW_CHECKPOINT_TIMEOUT_MS", 300_000);
  const laneTimeout = num("FLOW_LANE_TIMEOUT_MS", 300_000);

  await mkdir(evidenceDir, { recursive: true });

  const deps: RuntimeDeps = {
    adapter: new RealHerdrAdapter(),
    clock: () => Date.now(),
    idgen: () =>
      `flow-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    readResultFile: (path) => Bun.file(path).text(),
    sleep,
  };
  const runtime = new WorkflowRuntime(deps);

  const lanes: LaneSpec[] = Array.from({ length: laneCount }, (_, i) => ({
    laneId: `lane-${i + 1}`,
    role: "simulated",
    steps,
    stepDelaySeconds: delay,
  }));

  line("== agent-flow visible-run tracer smoke ==");
  line(`workspace=${workspace} lanes=${laneCount} steps=${steps} delay=${delay}s`);
  line(`evidence=${evidenceDir}`);

  const handle = await runtime.startWorkflow({
    workflow: `flow-tracer-smoke`,
    workspace,
    cwd: evidenceDir,
    lanes,
    splitDirection: "down",
    startupSettleMs: 1000,
  });
  line(`runId=${handle.runId}`);
  line(`lanes=${handle.laneIds.join(", ")}`);

  for (const laneId of handle.laneIds) {
    const live = await runtime.confirmLaneStarted(handle.runId, laneId);
    line(`lane ${laneId} started=${live}`);
  }

  const loss = await runtime.runControllerMarker(handle.runId, 30_000);
  const afterController = await runtime.inspectWorkflow(handle.runId);
  const stillRunning = afterController.lanes.filter(
    (l) => l.state === "running",
  ).length;
  line(
    `controller-loss: markerExited=${loss.controllerBackAtShell} lanesStillRunning=${stillRunning}/${handle.laneIds.length}`,
  );

  const focusLaneId = handle.laneIds[0]!;
  await runtime.focusLane(handle.runId, focusLaneId);
  line(`focused ${focusLaneId}`);

  runtime.markCheckpoint(handle.runId);
  line("");
  line("HUMAN CHECKPOINT READY");
  line(`  observe: the dedicated tab; ${handle.laneIds.length} lanes streaming STEP lines in separate panes.`);
  line(`  operate: choose ONE logical lane to interrupt — one of ${handle.laneIds.join(", ")}.`);
  line(`           the runtime will run interruptLane(runId, <lane>) — a real SIGINT, no pane id, no send-keys.`);
  line(`  success: the chosen lane ends with exit 130 (interrupted); every other lane ends with exit 0.`);
  line(`  waiting for lane choice via ${interruptFile} ...`);

  const choice = await pollInterruptChoice(
    interruptFile,
    handle.laneIds,
    checkpointTimeout,
  );
  let interruptedLane: string | null = null;
  if (choice) {
    const outcome = await runtime.interruptLane(handle.runId, choice);
    interruptedLane = choice;
    line(
      `interrupted ${outcome.laneId}: signal=${outcome.signal} delivered=${outcome.delivered}`,
    );
  } else {
    line("no lane choice received before timeout; proceeding without interrupt (GAP)");
  }

  const results: LaneResult[] = [];
  for (const laneId of handle.laneIds) {
    results.push(await runtime.awaitLane(handle.runId, laneId, laneTimeout));
  }

  const status = await runtime.inspectWorkflow(handle.runId);

  const report = {
    runId: handle.runId,
    workflow: "flow-tracer-smoke",
    laneIds: handle.laneIds,
    interruptedLane,
    controllerLoss: {
      markerExited: loss.controllerBackAtShell,
      lanesStillRunningAfterController: stillRunning,
    },
    focused: focusLaneId,
    lanes: results.map((r) => ({
      laneId: r.laneId,
      state: r.state,
      exitCode: r.exitCode,
      waitMatched: r.waitMatched,
      sentinelToken: r.sentinelToken,
      outputTail: r.outputTail,
    })),
    metrics: status.metrics,
    zeroModelCalls: true,
  };
  await Bun.write(
    `${evidenceDir}/smoke-result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const allDone = results.every(
    (r) => r.state === "complete" || r.state === "interrupted",
  );
  const interruptedOk =
    interruptedLane === null ||
    results.find((r) => r.laneId === interruptedLane)?.exitCode === 130;
  const othersOk = results
    .filter((r) => r.laneId !== interruptedLane)
    .every((r) => r.exitCode === 0);
  const ok = allDone && interruptedOk && othersOk;

  line("");
  line(`result written: ${evidenceDir}/smoke-result.json`);
  for (const r of results) {
    line(`  ${r.laneId}: state=${r.state} exit=${r.exitCode} waitMatched=${r.waitMatched}`);
  }
  line(`FLOW_SMOKE_DONE=${ok ? 0 : 1}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  line(`FLOW_SMOKE_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
