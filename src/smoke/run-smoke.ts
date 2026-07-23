// Unattended real-stack controller-loss smoke.
//
// A dispatch child starts visible lanes and stays alive holding the durable
// controller lease. The parent proves a second resume is refused, SIGKILLs the
// controller, allows an unobserved window, then resumes through the real CLI.
// The ledger is the only run handoff; no event-history blob is exported.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import type { RunEvent, RuntimeState } from "../runtime/events.ts";
import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
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
    `/private/tmp/agent-flow-resume-${process.pid}`,
  );
  return {
    workspace: env("FLOW_WORKSPACE", "w1"),
    runId: env(
      "FLOW_RUN_ID",
      `flow-${Date.now().toString(36)}-${process.pid.toString(36)}`,
    ),
    laneCount: num("FLOW_LANES", 4),
    steps: num("FLOW_STEPS", 4),
    stepSkew: num("FLOW_STEP_SKEW", 4),
    delay: num("FLOW_DELAY", 1),
    evidenceDir,
    readyFile: env("FLOW_READY_FILE", join(evidenceDir, "controller-ready")),
    readyTimeoutMs: num("FLOW_CONTROLLER_READY_TIMEOUT_MS", 30_000),
    unobservedMs: num("FLOW_UNOBSERVED_MS", 6_000),
    laneTimeoutMs: num("FLOW_LANE_TIMEOUT_MS", 300_000),
    ledgerRoot: resolveLedgerRoot(),
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
  const lanes: LaneSpec[] = Array.from({ length: c.laneCount }, (_, index) => ({
    laneId: `lane-${index + 1}`,
    role: "simulated",
    steps: c.steps + index * c.stepSkew,
    stepDelaySeconds: c.delay,
  }));

  line(
    `[dispatch pid=${process.pid}] runId=${c.runId} workspace=${c.workspace} lanes=${c.laneCount}`,
  );
  const handle = await runtime.startWorkflow({
    workflow: "flow-resume-smoke",
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
  line(`[dispatch] controller ready and holding lease`);

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
      throw new Error(`dispatch controller did not become ready within ${timeoutMs}ms`);
    }
    await sleep(100);
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function parentPhase(): Promise<void> {
  const c = config();
  await mkdir(c.evidenceDir, { recursive: true });
  line("== agent-flow resume-after-controller-loss smoke ==");
  line(`runId=${c.runId} evidence=${c.evidenceDir}`);

  const controller = Bun.spawn(["bun", "run", import.meta.path, "__dispatch__"], {
    env: {
      ...process.env,
      FLOW_RUN_ID: c.runId,
      FLOW_EVIDENCE_DIR: c.evidenceDir,
      FLOW_READY_FILE: c.readyFile,
      FLOW_LEDGER_ROOT: c.ledgerRoot,
      FLOW_WORKSPACE: c.workspace,
      FLOW_LANES: String(c.laneCount),
      FLOW_STEPS: String(c.steps),
      FLOW_STEP_SKEW: String(c.stepSkew),
      FLOW_DELAY: String(c.delay),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const controllerPid = controller.pid;
  let controllerReaped = false;
  try {
    await waitForReady(c.readyFile, c.readyTimeoutMs);

    const refused = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "resume",
      c.runId,
    );
    if (
      refused.exitCode === 0 ||
      !refused.stderr.includes("controller lease") ||
      !refused.stderr.includes("already held")
    ) {
      throw new Error(
        `live-controller resume was not refused: exit=${refused.exitCode} stderr=${refused.stderr.trim()}`,
      );
    }
    line(`live-holder refusal proven (exit=${refused.exitCode})`);

    controller.kill("SIGKILL");
    const controllerExit = await controller.exited;
    controllerReaped = true;
    await sleep(100);
    if (pidIsAlive(controllerPid)) {
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

    const resumed = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "resume",
      c.runId,
    );
    if (resumed.exitCode !== 0) {
      throw new Error(
        `fresh resume failed: exit=${resumed.exitCode} stderr=${resumed.stderr.trim()}`,
      );
    }
    const inspected = await flow(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "inspect",
      c.runId,
    );
    if (inspected.exitCode !== 0) {
      throw new Error(
        `inspect failed: exit=${inspected.exitCode} stderr=${inspected.stderr.trim()}`,
      );
    }
    if (
      !inspected.stdout.includes("runtimeState=") ||
      !inspected.stdout.includes("semanticState=") ||
      !inspected.stdout.includes("contractState=") ||
      !inspected.stdout.includes("verificationState=")
    ) {
      throw new Error("inspect did not render all four lane dimensions");
    }

    const reloaded = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!reloaded || reloaded.finishStatus === null) {
      throw new Error("fresh ledger reload did not contain run_finished");
    }
    if (
      reloaded.controller === null ||
      reloaded.controllerEpoch < 1 ||
      !reloaded.laneOrder.every((laneId) =>
        TERMINAL_RUNTIME.has(reloaded.lanes[laneId]!.runtimeState),
      )
    ) {
      throw new Error("fresh ledger reload failed controller/terminal integrity");
    }
    const eventFile = join(c.ledgerRoot, "runs", c.runId, "events.jsonl");
    const events = (await readFile(eventFile, "utf8"))
      .trim()
      .split("\n")
      .map((eventLine) => JSON.parse(eventLine) as RunEvent);
    if (!events.some((event) => event.type === "controller_attached")) {
      throw new Error("event history has no controller_attached");
    }
    const attachedIndex = events.findIndex(
      (event) => event.type === "controller_attached",
    );
    const finishedIndex = events.findIndex(
      (event) => event.type === "run_finished",
    );
    if (finishedIndex <= attachedIndex) {
      throw new Error("event history does not drive the resumed run to run_finished");
    }

    const report = {
      runId: c.runId,
      controller: {
        pid: controllerPid,
        killedWith: "SIGKILL",
        reaped: controllerReaped,
      },
      negativeResume: {
        exitCode: refused.exitCode,
        refusedByLease: true,
      },
      unobservedWindow: {
        exited: goneBeforeResume,
        live: aliveBeforeResume,
      },
      resumed: {
        exitCode: resumed.exitCode,
        controllerEpoch: reloaded.controllerEpoch,
        finishStatus: reloaded.finishStatus,
        breakdown: reloaded.breakdown,
      },
      inspect: inspected.stdout,
      laneRuntimeStates: reloaded.laneOrder.map((laneId) => ({
        laneId,
        runtimeState: reloaded.lanes[laneId]!.runtimeState,
        semanticState: reloaded.lanes[laneId]!.semanticState,
        contractState: reloaded.lanes[laneId]!.contractState,
        verificationState: reloaded.lanes[laneId]!.verificationState,
      })),
      ok: true,
    };
    await Bun.write(
      join(c.evidenceDir, "smoke-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    line(`FLOW_SMOKE_DONE=0`);
  } finally {
    if (!controllerReaped && pidIsAlive(controllerPid)) {
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
    `FLOW_SMOKE_ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
});
