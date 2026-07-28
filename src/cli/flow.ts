import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import { issueApiPath } from "../issue/gh-argv.ts";
import { projectSynchronization } from "../issue/milestones.ts";
import { RealIssueTracker } from "../issue/real-tracker.ts";
import { sameIssueTarget } from "../issue/target.ts";
import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
import type {
  IssueRef,
  OwnerDecision,
} from "../runtime/events.ts";
import type { Ledger } from "../runtime/ledger.ts";
import { projectRunState, type RunView } from "../runtime/reducer.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import { stat } from "node:fs/promises";

const USAGE =
  "usage: flow status | flow inspect <runId> | flow resume <runId> | flow takeover <runId> <laneId> | flow release <runId> <laneId> | flow decide <runId> --decision <accepted|rejected|changes-requested> --note <text> [--issue-state <text>]";
const DEFAULT_LANE_TIMEOUT_MS = 300_000;

interface TextSink {
  write(text: string): unknown;
}

export interface FlowCliOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeFactory?: (ledger: Ledger) => WorkflowRuntime;
}

interface DecideInput {
  readonly runId: string;
  readonly decision: OwnerDecision;
  readonly note: string;
  readonly resultingIssueState: string | null;
}

const OWNER_DECISIONS: ReadonlySet<OwnerDecision> = new Set([
  "accepted",
  "rejected",
  "changes-requested",
]);

function isOwnerDecision(value: string): value is OwnerDecision {
  for (const decision of OWNER_DECISIONS) {
    if (decision === value) return true;
  }
  return false;
}

function parseDecideArgs(args: readonly string[]): DecideInput | null {
  const [runId, ...flagArgs] = args;
  if (runId === undefined || runId.startsWith("--")) return null;

  const values = new Map<string, string>();
  for (let index = 0; index < flagArgs.length; index += 2) {
    const flag = flagArgs[index];
    const flagValue = flagArgs[index + 1];
    if (
      flag === undefined ||
      flagValue === undefined ||
      (flag !== "--decision" &&
        flag !== "--note" &&
        flag !== "--issue-state") ||
      values.has(flag)
    ) {
      return null;
    }
    values.set(flag, flagValue);
  }

  const decision = values.get("--decision");
  const note = values.get("--note");
  if (
    decision === undefined ||
    !isOwnerDecision(decision) ||
    note === undefined
  ) {
    return null;
  }
  return {
    runId,
    decision,
    note,
    resultingIssueState: values.get("--issue-state") ?? null,
  };
}

function value(input: string | number | boolean | null): string {
  return input === null ? "null" : String(input);
}

function quotedValue(input: string | null): string {
  return input === null ? "null" : JSON.stringify(input);
}

function renderSynchronization(run: RunView, stdout: TextSink): void {
  const synchronization = projectSynchronization(run);
  const binding =
    run.issue === null
      ? "unbound"
      : `${run.issue.owner}/${run.issue.repo}#${run.issue.number}`;
  stdout.write(
    `issue=${binding} issueNodeId=${run.issueNodeId ?? "unresolved"}\n`,
  );
  stdout.write(
    `issueSync=${synchronization.state} reason=${quotedValue(synchronization.reason)}\n`,
  );
  for (const deliveryId of run.deliveryOrder) {
    const delivery = run.deliveries[deliveryId]!;
    const retryable = delivery.lastFailure?.retryable ?? null;
    const retryDisposition =
      retryable === null
        ? "not-applicable"
        : retryable
          ? "will-retry"
          : "needs-operator";
    stdout.write(
      `delivery=${delivery.deliveryId} kind=${delivery.kind} state=${delivery.state} intents=${delivery.intents} labelTransition=${delivery.labelTransition} failureReason=${quotedValue(delivery.lastFailure?.reason ?? null)} retryable=${value(retryable)} retryDisposition=${retryDisposition} commentUrl=${value(delivery.commentUrl)}\n`,
    );
  }
}

function renderRun(run: RunView, stdout: TextSink): void {
  stdout.write(
    `runId=${run.runId} workflow=${run.workflow} state=${projectRunState(run)} finishStatus=${value(run.finishStatus)} updatedAt=${run.updatedAt}\n`,
  );
  stdout.write(`fixedPoint=${JSON.stringify(run.fixedPoint)}\n`);
  renderSynchronization(run, stdout);
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

export function resolveIssueTarget(
  environment: NodeJS.ProcessEnv = process.env,
): IssueRef | null {
  const configured = environment.FLOW_ISSUE_TARGET;
  if (configured === undefined) return null;
  const match = configured.match(
    /^([^/#]+)\/([^/#]+)#([1-9][0-9]*)$/,
  );
  const number = match?.[3] === undefined ? NaN : Number(match[3]);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    !Number.isSafeInteger(number)
  ) {
    throw new Error("FLOW_ISSUE_TARGET must be owner/repo#number");
  }
  const target = {
    owner: match[1],
    repo: match[2],
    number,
  };
  try {
    issueApiPath(target);
  } catch {
    throw new Error("FLOW_ISSUE_TARGET must be owner/repo#number");
  }
  return target;
}

function createRealRuntime(
  ledger: Ledger,
  authorizedTarget: IssueRef | null,
): WorkflowRuntime {
  return new WorkflowRuntime({
    adapter: new RealHerdrAdapter(),
    ledger,
    clock: () => Date.now(),
    idgen: () =>
      `flow-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    readResultFile: (path) => Bun.file(path).text(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...(authorizedTarget === null
      ? {}
      : {
          issueTracker: new RealIssueTracker({ authorizedTarget }),
        }),
  });
}

async function deliveryTargetFor(
  ledger: Ledger,
  runId: string,
  environment: NodeJS.ProcessEnv,
): Promise<IssueRef | null> {
  const run = await ledger.load(runId);
  if (!run) throw new Error(`run not found: "${runId}"`);
  if (run.issue === null) return null;
  const authorizedTarget = resolveIssueTarget(environment);
  if (authorizedTarget === null) {
    throw new Error("FLOW_ISSUE_TARGET is required for a bound run");
  }
  if (!sameIssueTarget(run.issue, authorizedTarget)) {
    throw new Error(
      "FLOW_ISSUE_TARGET does not match the run binding",
    );
  }
  return authorizedTarget;
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
  const decide =
    command === "decide" ? parseDecideArgs(args.slice(1)) : null;
  if (
    (command !== "status" &&
      command !== "inspect" &&
      command !== "resume" &&
      command !== "takeover" &&
      command !== "release" &&
      command !== "decide") ||
    (command === "status" &&
      (runId !== undefined || laneId !== undefined || extra.length > 0)) ||
    ((command === "inspect" || command === "resume") &&
      (runId === undefined || laneId !== undefined || extra.length > 0)) ||
    ((command === "takeover" || command === "release") &&
      (runId === undefined || laneId === undefined || extra.length > 0)) ||
    (command === "decide" && decide === null)
  ) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const environment = options.environment ?? process.env;
    const root = resolveLedgerRoot(environment);
    await requireLedgerRoot(root);
    const ledger = new FsLedger(root);
    const runtimeFor = (authorizedTarget: IssueRef | null) =>
      options.runtimeFactory?.(ledger) ??
      createRealRuntime(ledger, authorizedTarget);
    if (command === "status") {
      for (const { runId: listedRunId } of await ledger.list()) {
        const run = await ledger.load(listedRunId);
        if (!run) continue;
        const synchronization = projectSynchronization(run);
        stdout.write(
          `${run.runId} workflow=${run.workflow} state=${projectRunState(run)} finishStatus=${value(run.finishStatus)} lanes=${run.laneOrder.length} updatedAt=${run.updatedAt} issueSync=${synchronization.state}\n`,
        );
      }
      return 0;
    }

    if (command === "inspect") {
      const runtime = runtimeFor(null);
      await runtime.inspectWorkflow(runId!);
    } else if (command === "resume") {
      const authorizedTarget = await deliveryTargetFor(
        ledger,
        runId!,
        environment,
      );
      const runtime = runtimeFor(authorizedTarget);
      await runtime.resumeWorkflow(runId!, laneTimeout(environment));
    } else if (command === "takeover") {
      const runtime = runtimeFor(null);
      await runtime.takeoverLane(runId!, laneId!);
    } else if (command === "release") {
      const runtime = runtimeFor(null);
      await runtime.releaseLane(runId!, laneId!);
    } else if (command === "decide") {
      const authorizedTarget = await deliveryTargetFor(
        ledger,
        decide!.runId,
        environment,
      );
      const runtime = runtimeFor(authorizedTarget);
      await runtime.recordOwnerDecision(decide!.runId, {
        decision: decide!.decision,
        note: decide!.note,
        resultingIssueState: decide!.resultingIssueState,
      });
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
