// Unattended real-stack human-ownership recovery smoke.
//
// A dispatch child starts short managed lanes plus one long lane and stays
// alive holding the durable controller lease. The parent takes over the long
// lane, kills the controller, reconciles without driving the human-owned lane,
// then releases it and proves a fresh resume can finish the run.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import type { RunEvent, RuntimeState } from "../runtime/events.ts";
import {
  FsLedger,
  realPidIsAlive,
  resolveLedgerRoot,
} from "../runtime/fs-ledger.ts";
import type { Ledger } from "../runtime/ledger.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import type { LaneSpec, RuntimeDeps } from "../runtime/types.ts";

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);

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
    longSteps: num("FLOW_LONG_STEPS", 30),
    delay: num("FLOW_DELAY", 1),
    evidenceDir,
    readyFile: env("FLOW_READY_FILE", join(evidenceDir, "controller-ready")),
    readyTimeoutMs: num("FLOW_CONTROLLER_READY_TIMEOUT_MS", 30_000),
    unobservedMs: num("FLOW_UNOBSERVED_MS", 5_000),
    laneTimeoutMs: num("FLOW_LANE_TIMEOUT_MS", 90_000),
    ledgerRoot: resolveLedgerRoot(),
    longLaneId: "long",
  };
}

function makeDeps(ledger: Ledger, runId: string): RuntimeDeps {
  return {
    adapter: new RealHerdrAdapter(),
    ledger,
    clock: () => Date.now(),
    idgen: () => runId,
    readResultFile: (path) => Bun.file(path).text(),
    sleep,
  };
}

async function dispatchPhase(): Promise<void> {
  const c = config();
  await mkdir(c.evidenceDir, { recursive: true });
  const runtime = new WorkflowRuntime(
    makeDeps(new FsLedger(c.ledgerRoot), c.runId),
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
    ...managedLanes,
    {
      laneId: c.longLaneId,
      role: "simulated",
      steps: c.longSteps,
      stepDelaySeconds: c.delay,
    },
  ];

  line(
    `[dispatch pid=${process.pid}] runId=${c.runId} workspace=${c.workspace} managed=${c.managedLaneCount} long=${c.longLaneId}`,
  );
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
  await Bun.write(c.readyFile, `${handle.runId}\n`);
  line("[dispatch] controller ready and holding lease");

  for (;;) await sleep(60_000);
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

async function waitForReady(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await Bun.file(path).exists()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `dispatch controller did not become ready within ${timeoutMs}ms`,
      );
    }
    await sleep(100);
  }
}

function laneStates(run: NonNullable<Awaited<ReturnType<FsLedger["load"]>>>) {
  return run.laneOrder.map((laneId) => ({
    laneId,
    controlMode: run.lanes[laneId]!.controlMode,
    runtimeState: run.lanes[laneId]!.runtimeState,
  }));
}

async function parentPhase(): Promise<void> {
  const c = config();
  await mkdir(c.evidenceDir, { recursive: true });
  line("== agent-flow preserve-human-ownership smoke ==");
  line(`runId=${c.runId} evidence=${c.evidenceDir}`);

  const controller = Bun.spawn(["bun", "run", import.meta.path, "__dispatch__"], {
    env: {
      ...process.env,
      FLOW_RUN_ID: c.runId,
      FLOW_EVIDENCE_DIR: c.evidenceDir,
      FLOW_READY_FILE: c.readyFile,
      FLOW_LEDGER_ROOT: c.ledgerRoot,
      FLOW_WORKSPACE: c.workspace,
      FLOW_MANAGED_LANES: String(c.managedLaneCount),
      FLOW_SHORT_STEPS: String(c.shortSteps),
      FLOW_LONG_STEPS: String(c.longSteps),
      FLOW_DELAY: String(c.delay),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const controllerPid = controller.pid;
  let controllerReaped = false;
  try {
    await waitForReady(c.readyFile, c.readyTimeoutMs);

    const takeover = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "takeover",
      c.runId,
      c.longLaneId,
    );
    if (takeover.exitCode !== 0) {
      throw new Error(
        `takeover failed: exit=${takeover.exitCode} stderr=${takeover.stderr.trim()}`,
      );
    }
    const afterTakeover = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!afterTakeover) throw new Error(`run "${c.runId}" disappeared`);
    if (afterTakeover.lanes[c.longLaneId]!.controlMode !== "human_owned") {
      throw new Error("takeover was not durably reconstructed as human_owned");
    }
    line(`takeover proven (exit=${takeover.exitCode})`);

    controller.kill("SIGKILL");
    const controllerExit = await controller.exited;
    controllerReaped = true;
    await sleep(100);
    if (realPidIsAlive(controllerPid)) {
      throw new Error(`SIGKILLed controller pid ${controllerPid} is still alive`);
    }
    line(`controller SIGKILLed and reaped (exit=${controllerExit})`);

    await sleep(c.unobservedMs);
    const beforeResume = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!beforeResume) throw new Error(`run "${c.runId}" disappeared`);
    const adapter = new RealHerdrAdapter();
    let goneBeforeResume = 0;
    let aliveBeforeResume = 0;
    for (const laneId of beforeResume.laneOrder) {
      const lane = beforeResume.lanes[laneId]!;
      const info = await adapter.processInfo({ id: lane.paneId });
      if (info.foregroundProcessGroupId === info.shellPid) goneBeforeResume++;
      else aliveBeforeResume++;
    }
    if (goneBeforeResume === 0 || aliveBeforeResume === 0) {
      throw new Error(
        `unobserved window must contain both exited and live lanes; exited=${goneBeforeResume} live=${aliveBeforeResume}`,
      );
    }
    line(
      `unobserved window: exited=${goneBeforeResume} live=${aliveBeforeResume}`,
    );

    const firstResume = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "resume",
      c.runId,
    );
    if (firstResume.exitCode !== 0) {
      throw new Error(
        `human-owned resume failed: exit=${firstResume.exitCode} stderr=${firstResume.stderr.trim()}`,
      );
    }
    const afterFirstResume = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!afterFirstResume) throw new Error(`run "${c.runId}" disappeared`);
    const longAfterFirstResume = afterFirstResume.lanes[c.longLaneId]!;
    const managedLaneIds = afterFirstResume.laneOrder.filter(
      (laneId) => laneId !== c.longLaneId,
    );
    if (
      longAfterFirstResume.controlMode !== "human_owned" ||
      longAfterFirstResume.runtimeState !== "running" ||
      longAfterFirstResume.liveAt === null ||
      TERMINAL_RUNTIME.has(longAfterFirstResume.runtimeState) ||
      afterFirstResume.finishStatus !== null ||
      !managedLaneIds.every((laneId) =>
        TERMINAL_RUNTIME.has(afterFirstResume.lanes[laneId]!.runtimeState),
      ) ||
      afterFirstResume.controllerEpoch < 1
    ) {
      throw new Error(
        "first resume failed reconcile-without-auto-drive integrity",
      );
    }
    const eventFile = join(c.ledgerRoot, "runs", c.runId, "events.jsonl");
    const events = (await readFile(eventFile, "utf8"))
      .trim()
      .split("\n")
      .map((eventLine) => JSON.parse(eventLine) as RunEvent);
    if (!events.some((event) => event.type === "controller_attached")) {
      throw new Error("event history has no controller_attached");
    }
    line("first resume reconciled managed lanes and left human-owned lane live");

    const release = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "release",
      c.runId,
      c.longLaneId,
    );
    if (release.exitCode !== 0) {
      throw new Error(
        `release failed: exit=${release.exitCode} stderr=${release.stderr.trim()}`,
      );
    }
    const afterRelease = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!afterRelease) throw new Error(`run "${c.runId}" disappeared`);
    if (afterRelease.lanes[c.longLaneId]!.controlMode !== "managed") {
      throw new Error("release was not durably reconstructed as managed");
    }
    line(`release proven (exit=${release.exitCode})`);

    const secondResume = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "resume",
      c.runId,
    );
    if (secondResume.exitCode !== 0) {
      throw new Error(
        `managed resume failed: exit=${secondResume.exitCode} stderr=${secondResume.stderr.trim()}`,
      );
    }
    const finished = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!finished) throw new Error(`run "${c.runId}" disappeared`);
    if (
      finished.finishStatus === null ||
      !TERMINAL_RUNTIME.has(finished.lanes[c.longLaneId]!.runtimeState)
    ) {
      throw new Error("release did not restore managed drive to run_finished");
    }

    const report = {
      runId: c.runId,
      controller: {
        pid: controllerPid,
        killedWith: "SIGKILL",
        reaped: controllerReaped,
      },
      takeover: { exitCode: takeover.exitCode },
      release: { exitCode: release.exitCode },
      unobservedWindow: {
        exited: goneBeforeResume,
        live: aliveBeforeResume,
      },
      notFinishedAfterFirstResume: {
        exitCode: firstResume.exitCode,
        controllerEpoch: afterFirstResume.controllerEpoch,
        longLane: {
          laneId: c.longLaneId,
          runtimeState: longAfterFirstResume.runtimeState,
          liveAt: longAfterFirstResume.liveAt,
        },
        finishStatus: afterFirstResume.finishStatus,
      },
      finishedAfterRelease: {
        exitCode: secondResume.exitCode,
        finishStatus: finished.finishStatus,
        breakdown: finished.breakdown,
      },
      lanes: {
        afterFirstResume: laneStates(afterFirstResume),
        afterRelease: laneStates(afterRelease),
        finished: laneStates(finished),
      },
      ok: true,
    };
    await Bun.write(
      join(c.evidenceDir, "smoke-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    line("FLOW_TAKEOVER_SMOKE_DONE=0");
  } finally {
    if (!controllerReaped && realPidIsAlive(controllerPid)) {
      controller.kill("SIGKILL");
      await controller.exited;
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("__dispatch__")) {
    await dispatchPhase();
    return;
  }
  await parentPhase();
}

main().catch((error) => {
  line(
    `FLOW_TAKEOVER_SMOKE_ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
});
