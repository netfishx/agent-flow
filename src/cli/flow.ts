import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
import { projectRunState } from "../runtime/reducer.ts";
import { stat } from "node:fs/promises";

const USAGE = "usage: flow status | flow inspect <runId>";

interface TextSink {
  write(text: string): unknown;
}

function value(input: string | number | null): string {
  return input === null ? "null" : String(input);
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
): Promise<number> {
  const [command, runId, ...extra] = args;
  if (
    (command !== "status" && command !== "inspect") ||
    (command === "status" && (runId !== undefined || extra.length > 0)) ||
    (command === "inspect" && (runId === undefined || extra.length > 0))
  ) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const root = resolveLedgerRoot();
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

    const run = await ledger.load(runId!);
    if (!run) {
      stderr.write(`run "${runId}" not found\n`);
      return 1;
    }
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
        `  registeredAt=${lane.registeredAt} dispatchedAt=${value(lane.dispatchedAt)} liveAt=${value(lane.liveAt)} completedAt=${value(lane.completedAt)} checkpointAt=${value(lane.checkpointAt)} contractEvaluatedAt=${value(lane.contractEvaluatedAt)} verificationRecordedAt=${value(lane.verificationRecordedAt)}\n`,
      );
      stdout.write(
        `  artifacts stdout=${lane.logFile} stderr=${lane.stderrFile} checkpoint=${value(lane.checkpointFile)} result=${value(lane.resultFile)} evidence=${value(lane.evidenceFile)}\n`,
      );
    }
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
