// Single entry command for the real-stack smoke.
//
// Controller-loss is proven for real: the entry process spawns a short-lived
// DISPATCH child that lays out the tab, dispatches the lanes, exports the run
// topology, and exits. That child is the controller — once it exits, a fresh
// controller (this process, a different pid, a new WorkflowRuntime) attaches to
// the run, confirms the lanes are still alive though their dispatcher is dead,
// runs one human checkpoint, waits for every lane, and collects a durable
// result. All of it flows through logical handles; a run performs zero model
// calls for dispatch.
//
// Run with HERDR_ENV=1. Configuration comes from the environment:
//
//   FLOW_WORKSPACE      Herdr workspace id (default w1)
//   FLOW_LANES          number of simulated lanes (default 4)
//   FLOW_STEPS          steps per lane (default 30)
//   FLOW_DELAY          seconds per step (default 2)
//   FLOW_EVIDENCE_DIR   durable evidence directory
//   FLOW_HANDOFF_FILE   run topology handoff path
//   FLOW_INTERRUPT_FILE control file; its contents (a laneId) choose the lane
//                       to interrupt at the checkpoint
//   FLOW_CHECKPOINT_TIMEOUT_MS  how long to wait for the checkpoint (default 300000)
//   FLOW_LANE_TIMEOUT_MS        per-lane wait timeout (default 300000)

import { mkdir } from "node:fs/promises";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
import type { Ledger } from "../runtime/ledger.ts";
import type { LaneResult, LaneSpec, RuntimeDeps } from "../runtime/types.ts";
import { SmokeRuntime } from "./smoke-runtime.ts";

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
const line = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function makeDeps(ledger: Ledger): RuntimeDeps {
  return {
    adapter: new RealHerdrAdapter(),
    ledger,
    clock: () => Date.now(),
    idgen: () =>
      `flow-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    readResultFile: (path) => Bun.file(path).text(),
    sleep,
  };
}

function config() {
  const evidenceDir = env(
    "FLOW_EVIDENCE_DIR",
    `/private/tmp/agent-flow-tracer-${process.pid}`,
  );
  return {
    workspace: env("FLOW_WORKSPACE", "w1"),
    laneCount: num("FLOW_LANES", 4),
    steps: num("FLOW_STEPS", 30),
    delay: num("FLOW_DELAY", 2),
    evidenceDir,
    handoffFile: env("FLOW_HANDOFF_FILE", `${evidenceDir}/run-handoff.json`),
    interruptFile: env("FLOW_INTERRUPT_FILE", `${evidenceDir}/interrupt-request`),
    checkpointTimeout: num("FLOW_CHECKPOINT_TIMEOUT_MS", 300_000),
    laneTimeout: num("FLOW_LANE_TIMEOUT_MS", 300_000),
    ledgerRoot: resolveLedgerRoot(),
  };
}

// ── Dispatch child: the controller that will exit ───────────────────────────

async function dispatchPhase(): Promise<void> {
  const c = config();
  await mkdir(c.evidenceDir, { recursive: true });
  const runtime = new SmokeRuntime(makeDeps(new FsLedger(c.ledgerRoot)));
  const lanes: LaneSpec[] = Array.from({ length: c.laneCount }, (_, i) => ({
    laneId: `lane-${i + 1}`,
    role: "simulated",
    steps: c.steps,
    stepDelaySeconds: c.delay,
  }));

  line(`[dispatch pid=${process.pid}] workspace=${c.workspace} lanes=${c.laneCount} steps=${c.steps} delay=${c.delay}s`);
  const handle = await runtime.startWorkflow({
    workflow: "flow-tracer-smoke",
    workspace: c.workspace,
    cwd: c.evidenceDir,
    lanes,
    splitDirection: "down",
    startupSettleMs: 1000,
  });
  try {
    line(`[dispatch] runId=${handle.runId} lanes=${handle.laneIds.join(", ")}`);
    for (const laneId of handle.laneIds) {
      await runtime.confirmLaneStarted(handle.runId, laneId);
    }
    await Bun.write(c.handoffFile, await runtime.exportRun(handle.runId));
    line(`[dispatch] handoff written; dispatcher exiting -> controller is now gone`);
  } finally {
    await runtime.releaseForHandoff(handle.runId);
  }
}

// ── Collect: a fresh controller after the dispatcher has exited ──────────────

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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function collectPhase(): Promise<void> {
  const c = config();
  await mkdir(c.evidenceDir, { recursive: true });
  line("== agent-flow visible-run tracer smoke ==");
  line(`evidence=${c.evidenceDir}`);

  // 1. Spawn the dispatch child and let it exit — the controller dies.
  const child = Bun.spawn(["bun", "run", import.meta.path, "__dispatch__"], {
    env: {
      ...process.env,
      FLOW_EVIDENCE_DIR: c.evidenceDir,
      FLOW_HANDOFF_FILE: c.handoffFile,
      FLOW_WORKSPACE: c.workspace,
      FLOW_LANES: String(c.laneCount),
      FLOW_STEPS: String(c.steps),
      FLOW_DELAY: String(c.delay),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const dispatcherPid = child.pid;
  const dispatcherExit = await child.exited;
  await sleep(200); // let the OS reap the pid
  const dispatcherDead = !isAlive(dispatcherPid);
  line(`dispatcher pid=${dispatcherPid} exit=${dispatcherExit} dead=${dispatcherDead}`);

  // 2. Fresh controller (new pid, new runtime) attaches to the orphaned run.
  const handoff = await Bun.file(c.handoffFile).text();
  const runtime = new SmokeRuntime(makeDeps(new FsLedger(c.ledgerRoot)));
  const handle = await runtime.attachRun(handoff);
  line(`attached runId=${handle.runId} lanes=${handle.laneIds.join(", ")}`);

  // 3. Controller-loss proof: the dispatcher is dead, yet the lanes are alive.
  const afterLoss = await runtime.inspectWorkflow(handle.runId);
  const aliveLanes = afterLoss.lanes.filter((l) => l.state === "running").length;
  line(`controller-loss: dispatcherDead=${dispatcherDead} lanesAlive=${aliveLanes}/${handle.laneIds.length}`);

  const focusLaneId = handle.laneIds[0]!;
  await runtime.focusLane(handle.runId, focusLaneId);
  line(`focused ${focusLaneId}`);

  // 4. One human checkpoint.
  runtime.markCheckpoint(handle.runId);
  line("");
  line("HUMAN CHECKPOINT READY");
  line(`  observe: the dedicated tab; ${handle.laneIds.length} lanes streaming STEP lines in separate panes.`);
  line(`  operate: choose ONE logical lane to interrupt — one of ${handle.laneIds.join(", ")}.`);
  line(`           the runtime runs interruptLane(runId, <lane>) — a real SIGINT, no pane id, no send-keys.`);
  line(`  success: the chosen lane ends exit 130 (interrupted); every other lane ends exit 0.`);
  line(`  waiting for lane choice via ${c.interruptFile} ...`);

  const choice = await pollInterruptChoice(
    c.interruptFile,
    handle.laneIds,
    c.checkpointTimeout,
  );
  let interruptedLane: string | null = null;
  if (choice) {
    const outcome = await runtime.interruptLane(handle.runId, choice);
    interruptedLane = choice;
    line(`interrupted ${outcome.laneId}: signal=${outcome.signal} delivered=${outcome.delivered}`);
  } else {
    line("no lane choice received before timeout — the human checkpoint was NOT satisfied");
  }

  // 5. Wait for every lane and collect durable results.
  const results: LaneResult[] = [];
  for (const laneId of handle.laneIds) {
    results.push(await runtime.awaitLane(handle.runId, laneId, c.laneTimeout));
  }
  const status = await runtime.inspectWorkflow(handle.runId);

  const controllerLossProven = dispatcherDead && aliveLanes === handle.laneIds.length;
  const allDone = results.every(
    (r) => r.state === "complete" || r.state === "interrupted",
  );
  const interruptOk =
    interruptedLane !== null &&
    results.find((r) => r.laneId === interruptedLane)?.exitCode === 130;
  const othersOk = results
    .filter((r) => r.laneId !== interruptedLane)
    .every((r) => r.exitCode === 0);
  const ok = controllerLossProven && allDone && interruptOk && othersOk;

  const report = {
    runId: handle.runId,
    workflow: "flow-tracer-smoke",
    laneIds: handle.laneIds,
    controllerLoss: {
      dispatcherPid,
      dispatcherExit,
      dispatcherDead,
      lanesAliveAfterDispatcherExit: aliveLanes,
      proven: controllerLossProven,
    },
    focused: focusLaneId,
    interruptedLane,
    humanCheckpointSatisfied: interruptedLane !== null,
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
    ok,
  };
  await Bun.write(
    `${c.evidenceDir}/smoke-result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  line("");
  line(`result written: ${c.evidenceDir}/smoke-result.json`);
  for (const r of results) {
    line(`  ${r.laneId}: state=${r.state} exit=${r.exitCode} waitMatched=${r.waitMatched}`);
  }
  line(`FLOW_SMOKE_DONE=${ok ? 0 : 1}`);
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes("__dispatch__")) {
    await dispatchPhase();
    return;
  }
  await collectPhase();
}

main().catch((error) => {
  line(`FLOW_SMOKE_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
