import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import { issueApiPath } from "../issue/gh-argv.ts";
import { GitReviewIsolation } from "../review/isolation.ts";
import { verificationPassed } from "../review/verification.ts";
import { projectSynchronization } from "../issue/milestones.ts";
import { RealIssueTracker } from "../issue/real-tracker.ts";
import { sameIssueTarget } from "../issue/target.ts";
import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
import { RealHerdrAgentControl } from "../herdr/real-agent-control.ts";
import { attemptDisposition } from "../interactive/attempts.ts";
import {
  InteractiveLaneController,
  pendingRetries,
} from "../interactive/control-plane.ts";
import type {
  IssueRef,
  OwnerDecision,
} from "../runtime/events.ts";
import type { Ledger } from "../runtime/ledger.ts";
import { projectRunState, type RunView } from "../runtime/reducer.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import type { RuntimeDeps } from "../runtime/types.ts";
import { stat } from "node:fs/promises";

const USAGE =
  "usage: flow status | flow inspect <runId> | flow resume <runId> | flow takeover <runId> <laneId> | flow release <runId> <laneId> | flow decide <runId> --decision <accepted|rejected|changes-requested> --note <text> [--issue-state <text>]";

/**
 * The interactive write lane's human controls, parsed separately because every
 * one of them is a HUMAN act: no runtime path issues a steer, a cancel, an
 * abort, or a retry, so the CLI is where the authorization enters the ledger.
 */
const INTERACTIVE_USAGE = [
  "usage: flow open-lane --workflow <name> --workspace <ws> --cwd <dir> --lane <id> --kind <claude|codex|grok> --model <m> --effort <e> --worktree <path>",
  "       flow start-attempt <runId> <laneId> --brief-file <path> --note <text> [--parent <attemptId>]",
  "       flow steer <runId> <laneId> <text>",
  "       flow cancel-turn <runId> <laneId>",
  "       flow abort-session <runId> <laneId>",
  "       flow authorize-retry <runId> <laneId> <attemptId> --note <text>",
  "       flow reconcile <runId> <laneId> <attemptId>",
].join("\n");

export const INTERACTIVE_COMMANDS = [
  "open-lane",
  "start-attempt",
  "steer",
  "cancel-turn",
  "abort-session",
  "authorize-retry",
  "reconcile",
] as const;

export type InteractiveCommand = (typeof INTERACTIVE_COMMANDS)[number];

export interface InteractiveInvocation {
  readonly command: InteractiveCommand;
  readonly runId: string | null;
  readonly laneId: string | null;
  readonly attemptId: string | null;
  readonly text: string | null;
  readonly flags: Readonly<Record<string, string>>;
}

const AGENT_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "grok"]);

/** Parse `--flag value` pairs; null on a repeat, a stray, or a missing value. */
function parseFlags(
  args: readonly string[],
  allowed: readonly string[],
): Readonly<Record<string, string>> | null {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !allowed.includes(flag) ||
      flag in values ||
      value.startsWith("--")
    ) {
      return null;
    }
    values[flag] = value;
  }
  return values;
}

const OPEN_LANE_FLAGS = [
  "--workflow",
  "--workspace",
  "--cwd",
  "--lane",
  "--kind",
  "--model",
  "--effort",
  "--worktree",
] as const;

/** Parse an interactive invocation, or null when it is malformed. */
export function parseInteractiveArgs(
  args: readonly string[],
): InteractiveInvocation | null {
  const [command, ...rest] = args;
  if (
    command === undefined ||
    !(INTERACTIVE_COMMANDS as readonly string[]).includes(command)
  ) {
    return null;
  }

  if (command === "open-lane") {
    const flags = parseFlags(rest, OPEN_LANE_FLAGS);
    if (flags === null) return null;
    for (const flag of OPEN_LANE_FLAGS) {
      if (flags[flag] === undefined) return null;
    }
    if (!AGENT_KINDS.has(flags["--kind"]!)) return null;
    return {
      command,
      runId: null,
      laneId: null,
      attemptId: null,
      text: null,
      flags,
    };
  }

  const [runId, laneId, third, ...tail] = rest;
  if (
    runId === undefined ||
    laneId === undefined ||
    runId.startsWith("--") ||
    laneId.startsWith("--")
  ) {
    return null;
  }
  const base = {
    command: command as InteractiveCommand,
    runId,
    laneId,
    flags: {},
  } as const;

  if (command === "start-attempt") {
    const flags = parseFlags(
      third === undefined ? [] : [third, ...tail],
      ["--brief-file", "--note", "--parent"],
    );
    if (
      flags === null ||
      flags["--brief-file"] === undefined ||
      flags["--note"] === undefined
    ) {
      return null;
    }
    return {
      ...base,
      attemptId: flags["--parent"] ?? null,
      text: null,
      flags,
    };
  }
  if (command === "steer") {
    if (third === undefined || tail.length > 0) return null;
    return { ...base, attemptId: null, text: third };
  }
  if (command === "cancel-turn" || command === "abort-session") {
    if (third !== undefined) return null;
    return { ...base, attemptId: null, text: null };
  }
  if (command === "reconcile") {
    if (third === undefined || third.startsWith("--") || tail.length > 0) {
      return null;
    }
    return { ...base, attemptId: third, text: null };
  }
  // authorize-retry <attemptId> --note <text>
  if (
    third === undefined ||
    third.startsWith("--") ||
    tail.length !== 2 ||
    tail[0] !== "--note" ||
    tail[1] === undefined
  ) {
    return null;
  }
  return { ...base, attemptId: third, text: tail[1] };
}

const DEFAULT_LANE_TIMEOUT_MS = 300_000;

interface TextSink {
  write(text: string): unknown;
}

export interface FlowCliOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeFactory?: (ledger: Ledger) => WorkflowRuntime;
  readonly interactiveFactory?: (ledger: Ledger) => InteractiveLaneController;
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

/**
 * Interactive attempts, rendered so the advisory channel and the objective
 * facts stay visibly apart. `disposition` is computed from the objective facts
 * alone; the advisory line beside it is labelled as what it is.
 */
function renderInteractiveAttempts(run: RunView, stdout: TextSink): void {
  for (const attemptId of run.interactiveAttemptOrder) {
    const attempt = run.interactiveAttempts[attemptId]!;
    const latestAdvisory = attempt.advisory.at(-1);
    stdout.write(
      `attempt=${attempt.attemptId} lane=${attempt.laneId} ordinal=${attempt.ordinal} parent=${value(attempt.parentAttemptId)}\n`,
    );
    const session =
      attempt.session.kind === "measured"
        ? `measured:${attempt.session.id}`
        : `unavailable(${quotedValue(attempt.session.reason)})`;
    stdout.write(
      `  disposition=${attemptDisposition(attempt)} endReason=${value(attempt.endReason)} endCause=${quotedValue(attempt.endCause)} exitCode=${value(attempt.exitCode)} supersededBy=${value(attempt.supersededBy)}\n`,
    );
    stdout.write(
      `  agentKind=${attempt.agentKind} pane=${attempt.paneId} name=${value(attempt.agentName)} session=${session} controlMode=${attempt.controlMode}\n`,
    );
    stdout.write(
      `  authorization actor=${attempt.authorization.actor} note=${quotedValue(attempt.authorization.note)} pendingRetries=${pendingRetries(run, attempt.attemptId)}\n`,
    );
    stdout.write(
      `  declared brief=${attempt.briefFile} checkpoint=${attempt.checkpointFile} result=${attempt.resultPointer}\n`,
    );
    stdout.write(
      `  checkpoint origin=${value(attempt.agentCheckpoint?.origin ?? null)} state=${value(attempt.agentCheckpoint?.semanticState ?? null)} runnerEvidence=${attempt.runnerEvidence.length}\n`,
    );
    for (const record of attempt.runnerEvidence) {
      stdout.write(
        `  runner=${record.evidenceId} pane=${record.paneId} exitCode=${value(record.exitCode)} log=${record.logFile}\n`,
      );
    }
    const delivery = attempt.lastControlDelivery;
    stdout.write(
      `  steer submitted=${attempt.steerSubmissions} observed=${attempt.steerObservations} cancelTurnRequestedAt=${value(attempt.lastCancelTurnAt)} abortRequestedAt=${value(attempt.lastAbortAt)}\n`,
    );
    stdout.write(
      `  lastDelivery control=${value(delivery?.control ?? null)} delivered=${value(delivery?.delivered ?? null)} detail=${quotedValue(delivery?.detail ?? null)}\n`,
    );
    stdout.write(
      `  reconciliation=${value(attempt.reconciliation?.outcome ?? null)} detail=${quotedValue(attempt.reconciliation?.detail ?? null)}\n`,
    );
    // ADVISORY. Never evidence, and never an input to `disposition` above.
    stdout.write(
      `  advisory(not evidence) count=${attempt.advisory.length} latest=${value(latestAdvisory?.status ?? null)} source=${value(latestAdvisory?.source ?? null)}\n`,
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
      `  artifacts stdout=${value(lane.logFile)} stderr=${value(lane.stderrFile)} checkpoint=${value(lane.checkpointFile)} result=${value(lane.resultFile)} evidence=${value(lane.evidenceFile)}\n`,
    );
    if (lane.kind === "agent") {
      const session =
        lane.sessionIdentity === null
          ? "unrecorded"
          : lane.sessionIdentity.kind === "measured"
            ? `measured:${lane.sessionIdentity.id}`
            : `unavailable(${JSON.stringify(lane.sessionIdentity.reason)})`;
      // The one shared pass predicate — never a third inline copy of it.
      const isolation = (view: typeof lane.isolationPre): string =>
        view === null
          ? "unrecorded"
          : verificationPassed(view)
            ? "pass"
            : `fail(${quotedValue(view.detail)})`;
      const worktree =
        lane.worktreeDisposition === null
          ? "unrecorded"
          : lane.worktreeDisposition.disposition === "removed"
            ? "removed"
            : `retained(${quotedValue(lane.worktreeDisposition.retainedReason)})`;
      stdout.write(
        `  agent axis=${value(lane.axis)} agentKind=${value(lane.agentKind)} model=${value(lane.model)} effort=${value(lane.effort)}\n`,
      );
      stdout.write(
        `  review raw=${value(lane.rawReportFile)} brief=${value(lane.promptFile)} bundleHash=${value(lane.bundleHash)}\n`,
      );
      stdout.write(
        `  isolation pre=${isolation(lane.isolationPre)} post=${isolation(lane.isolationPost)} session=${session}\n`,
      );
      stdout.write(
        `  artifacts rawReport=${value(lane.rawReportOutcome)} checkpointOrigin=${value(lane.checkpointOrigin)} worktree=${worktree}\n`,
      );
    }
  }
  renderInteractiveAttempts(run, stdout);
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

/**
 * The dependencies the real CLI hands the runtime. Exported so the wiring
 * itself is testable: a resuming controller that lacks the review-isolation
 * port fails post-flight closed and marks an otherwise good run invalid, and
 * that regression is invisible to every test that injects its own deps.
 */
export function realRuntimeDeps(
  ledger: Ledger,
  authorizedTarget: IssueRef | null,
): RuntimeDeps {
  return {
    adapter: new RealHerdrAdapter(),
    ledger,
    clock: () => Date.now(),
    idgen: () =>
      `flow-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    readResultFile: (path) => Bun.file(path).text(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // A resuming controller must be able to vouch for reviewer isolation;
    // without the port, post-flight fails closed and marks the run invalid.
    reviewIsolation: new GitReviewIsolation(),
    sessionIdgen: () => randomUUID(),
    ...(authorizedTarget === null
      ? {}
      : {
          issueTracker: new RealIssueTracker({ authorizedTarget }),
        }),
  };
}

function createRealRuntime(
  ledger: Ledger,
  authorizedTarget: IssueRef | null,
): WorkflowRuntime {
  return new WorkflowRuntime(realRuntimeDeps(ledger, authorizedTarget));
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

/**
 * The dependencies a real interactive controller gets. Split out so the wiring
 * is testable on its own — the same reason `realRuntimeDeps` is exported.
 */
export function realInteractiveController(
  ledger: Ledger,
  ledgerRoot: string,
): InteractiveLaneController {
  return new InteractiveLaneController({
    adapter: new RealHerdrAdapter(),
    agentControl: new RealHerdrAgentControl(),
    ledger,
    // Attempt artifacts share the ledger's lifetime, so a checkpoint the
    // ledger points at cannot outlive or predecease the record naming it.
    artifactRoot: join(ledgerRoot, "interactive"),
    clock: () => Date.now(),
    idgen: () =>
      `att-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    sessionIdgen: () => randomUUID(),
  });
}

async function runInteractiveCli(
  args: readonly string[],
  stdout: TextSink,
  stderr: TextSink,
  options: FlowCliOptions,
): Promise<number> {
  const invocation = parseInteractiveArgs(args);
  if (invocation === null) {
    stderr.write(`${INTERACTIVE_USAGE}\n`);
    return 2;
  }
  try {
    const environment = options.environment ?? process.env;
    const root = resolveLedgerRoot(environment);
    await requireLedgerRoot(root);
    const ledger = new FsLedger(root);
    const controller =
      options.interactiveFactory?.(ledger) ??
      realInteractiveController(ledger, root);
    const flags = invocation.flags;
    let runId = invocation.runId;
    const laneId = invocation.laneId!;
    switch (invocation.command) {
      case "open-lane": {
        const opened = await controller.openLane({
          workflow: flags["--workflow"]!,
          workspace: flags["--workspace"]!,
          cwd: flags["--cwd"]!,
          laneId: flags["--lane"]!,
          agentKind: flags["--kind"] as "claude" | "codex" | "grok",
          model: flags["--model"]!,
          effort: flags["--effort"]!,
          worktreePath: flags["--worktree"]!,
        });
        runId = opened.runId;
        stdout.write(`runId=${opened.runId} laneId=${opened.laneId}\n`);
        break;
      }
      case "start-attempt": {
        // The brief comes from a FILE, never from an argv fragment: it is the
        // lane's contract with the Agent, and it is the first prompt.
        const brief = await Bun.file(flags["--brief-file"]!).text();
        const outcome = await controller.startAttempt(runId!, laneId, {
          brief,
          authorization: { note: flags["--note"]! },
          ...(invocation.attemptId === null
            ? {}
            : { parentAttemptId: invocation.attemptId }),
        });
        stdout.write(
          `attempt=${outcome.attemptId} started=${outcome.started} startFailure=${quotedValue(outcome.startFailure)}\n`,
        );
        break;
      }
      case "steer":
        await controller.steer(runId!, laneId, invocation.text!);
        break;
      case "cancel-turn":
        await controller.cancelTurn(runId!, laneId);
        break;
      case "abort-session":
        await controller.abortSession(runId!, laneId);
        break;
      case "authorize-retry":
        await controller.authorizeRetry(
          runId!,
          laneId,
          invocation.attemptId!,
          invocation.text!,
        );
        break;
      case "reconcile":
        await controller.reconcileAttempt(
          runId!,
          laneId,
          invocation.attemptId!,
        );
        break;
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

export async function runFlowCli(
  args: readonly string[],
  stdout: TextSink = process.stdout,
  stderr: TextSink = process.stderr,
  options: FlowCliOptions = {},
): Promise<number> {
  const [command, runId, laneId, ...extra] = args;
  if (
    command !== undefined &&
    (INTERACTIVE_COMMANDS as readonly string[]).includes(command)
  ) {
    return runInteractiveCli(args, stdout, stderr, options);
  }
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
