import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
import type { Ledger } from "../runtime/ledger.ts";
import { projectRunState, type RunView } from "../runtime/reducer.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import { stat } from "node:fs/promises";

const USAGE =
  "usage: flow status | flow inspect <runId> | flow resume <runId> | flow takeover <runId> <laneId> | flow release <runId> <laneId>";
const DEFAULT_LANE_TIMEOUT_MS = 300_000;

interface TextSink {
  write(text: string): unknown;
}

export interface FlowCliOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeFactory?: (ledger: Ledger) => WorkflowRuntime;
}

function value(input: string | number | null): string {
  return input === null ? "null" : String(input);
}

function renderRun(run: RunView, stdout: TextSink): void {
  stdout.write(
    `runId=${run.runId} workflow=${run.workflow} state=${projectRunState(run)} finishStatus=${value(run.finishStatus)} updatedAt=${run.updatedAt}\n`,
  );
  stdout.write(`fixedPoint=${JSON.stringify(run.fixedPoint)}\n`);
  for (const laneId of run.laneOrder) {
    const lane = run.lanes[laneId]!;
    stdout.write(`lane=${laneId}\n`);
    stdout.write(
      `  runtimeState=${lane.runtimeState} semanticState=${lane.semanticState} contractState=${lane.contractState} verificationState=${lane.verificationState}\n`,
    );
    stdout.write(
      `  controlMode=${lane.controlMode} exitCode=${value(lane.exitCode)}\n`,
    );
    stdout.write(
      `  registeredAt=${lane.registeredAt} dispatchIntentAt=${value(lane.dispatchIntentAt)} dispatchedAt=${value(lane.dispatchedAt)} liveAt=${value(lane.liveAt)} completedAt=${value(lane.completedAt)} checkpointAt=${value(lane.checkpointAt)} contractEvaluatedAt=${value(lane.contractEvaluatedAt)} verificationRecordedAt=${value(lane.verificationRecordedAt)}\n`,
    );
    stdout.write(
      `  artifacts stdout=${lane.logFile} stderr=${lane.stderrFile} checkpoint=${value(lane.checkpointFile)} result=${value(lane.resultFile)} evidence=${value(lane.evidenceFile)}\n`,
    );
  }
}

function laneTimeout(environment: NodeJS.ProcessEnv): number {
  const configured = environment.FLOW_LANE_TIMEOUT_MS;
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_LANE_TIMEOUT_MS;
  }
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("FLOW_LANE_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

function createRealRuntime(ledger: Ledger): WorkflowRuntime {
  return new WorkflowRuntime({
    adapter: new RealHerdrAdapter(),
    ledger,
    clock: () => Date.now(),
    idgen: () =>
      `flow-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    readResultFile: (path) => Bun.file(path).text(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

async function requireLedgerRoot(root: string): Promise<void> {
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`ledger root "${root}" does not exist`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`ledger root "${root}" is not a directory`);
  }
}

export async function runFlowCli(
  args: readonly string[],
  stdout: TextSink = process.stdout,
  stderr: TextSink = process.stderr,
  options: FlowCliOptions = {},
): Promise<number> {
  const [command, runId, laneId, ...extra] = args;
  if (
    (command !== "status" &&
      command !== "inspect" &&
      command !== "resume" &&
      command !== "takeover" &&
      command !== "release") ||
    (command === "status" &&
      (runId !== undefined || laneId !== undefined || extra.length > 0)) ||
    ((command === "inspect" || command === "resume") &&
      (runId === undefined || laneId !== undefined || extra.length > 0)) ||
    ((command === "takeover" || command === "release") &&
      (runId === undefined || laneId === undefined || extra.length > 0))
  ) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const environment = options.environment ?? process.env;
    const root = resolveLedgerRoot(environment);
    await requireLedgerRoot(root);
    const ledger = new FsLedger(root);
    if (command === "status") {
      for (const { runId: listedRunId } of await ledger.list()) {
        const run = await ledger.load(listedRunId);
        if (!run) continue;
        stdout.write(
          `${run.runId} workflow=${run.workflow} state=${projectRunState(run)} finishStatus=${value(run.finishStatus)} lanes=${run.laneOrder.length} updatedAt=${run.updatedAt}\n`,
        );
      }
      return 0;
    }

    if (command === "resume") {
      const runtime = (options.runtimeFactory ?? createRealRuntime)(ledger);
      await runtime.resumeWorkflow(runId!, laneTimeout(environment));
    } else if (command === "takeover") {
      const runtime = (options.runtimeFactory ?? createRealRuntime)(ledger);
      await runtime.takeoverLane(runId!, laneId!);
    } else if (command === "release") {
      const runtime = (options.runtimeFactory ?? createRealRuntime)(ledger);
      await runtime.releaseLane(runId!, laneId!);
    }
    const run = await ledger.load(runId!);
    if (!run) {
      stderr.write(`run "${runId}" not found\n`);
      return 1;
    }
    renderRun(run, stdout);
    return 0;
  } catch (error) {
    stderr.write(
      `flow: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runFlowCli(process.argv.slice(2));
}
