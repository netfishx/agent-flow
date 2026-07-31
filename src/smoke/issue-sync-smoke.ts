// Explicitly authorized real-GitHub smoke for issue synchronization.
//
// This file is import-safe and is never a test. The gate must pass before any
// remote command is constructed or any tracker is allowed to run.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghArgvBuilders } from "../issue/gh-argv.ts";
import { parseIssueComments } from "../issue/gh-json.ts";
import { canonicalPayloadHash } from "../issue/hash.ts";
import {
  dueMilestones,
  marker,
  type DueMilestone,
} from "../issue/milestones.ts";
import {
  classifyGhFailure,
  RealIssueTracker,
} from "../issue/real-tracker.ts";
import { renderMilestone } from "../issue/render.ts";
import {
  type CommentRef,
  IssueTrackerError,
} from "../issue/tracker.ts";
import type {
  IssueRef,
  NewRunEvent,
  RunEvent,
} from "../runtime/events.ts";
import { FsLedger } from "../runtime/fs-ledger.ts";
import type { RunView } from "../runtime/reducer.ts";
import { resolveEvidenceRoot } from "./evidence-root.ts";
import { issueSyncGate } from "./issue-sync-gate.ts";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface CliResult extends CommandResult {
  readonly runId: string;
}

interface CliObservation {
  readonly runId: string;
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface MarkerObservation {
  readonly deliveryId: string;
  readonly commentId: number;
  readonly commentUrl: string;
  readonly parsedCommentCount: number;
}

interface CreatedComment {
  readonly deliveryId: string;
  readonly ref: CommentRef;
}

interface SmokeEvidence {
  ok: boolean;
  gate: {
    readonly target: string;
    readonly authorizationStatement: string;
  };
  tempLedgerRoot: string | null;
  scenarios: Record<string, unknown>;
  labels: Record<string, readonly string[]>;
  cli: CliObservation[];
  commentUrls: string[];
  parseFailClosedPremise: {
    readonly status: "not-run" | "observed";
    readonly commentCounts: readonly number[];
  };
  primaryRateLimit: {
    observed: boolean;
    detail: string | null;
  };
  retainedComments: {
    readonly disposition: "accepted-persistent-trace";
    commentUrls: string[];
  };
  redaction: Record<string, unknown> | null;
  restoration: Record<string, unknown>;
  cleanup: Record<string, unknown>;
  failure: Record<string, unknown> | null;
}

interface CannedRun {
  readonly ledger: FsLedger;
  readonly ledgerRoot: string;
  readonly runId: string;
  readonly paneIdentifiers: readonly string[];
  readonly sentinelIdentifiers: readonly string[];
}

interface VettedDirectGh {
  addLabel(label: string): Promise<void>;
  removeLabel(label: string): Promise<void>;
  readCommentBodies(): Promise<Map<number, string>>;
}

const TRIAGE_LABELS: ReadonlySet<string> = new Set([
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
]);

const line = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function targetText(target: IssueRef): string {
  return `${target.owner}/${target.repo}#${target.number}`;
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function errorObservation(error: unknown): Record<string, unknown> {
  if (error instanceof IssueTrackerError) {
    return {
      name: error.name,
      reason: error.reason,
      retryable: error.retryable,
    };
  }
  if (error instanceof DirectGhError) {
    return {
      name: error.name,
      operation: error.operation,
      exitCode: error.exitCode,
      httpStatus: error.httpStatus,
    };
  }
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function observePrimaryRateLimit(
  evidence: SmokeEvidence,
  error: unknown,
): void {
  if (
    error instanceof IssueTrackerError &&
    error.retryable === false &&
    error.reason.includes("(HTTP 403)")
  ) {
    evidence.primaryRateLimit = {
      observed: true,
      detail: error.reason,
    };
  }
}

async function spawnGh(
  argv: readonly string[],
  stdin: string | null,
): Promise<CommandResult> {
  const child = Bun.spawn(["gh", ...argv], {
    env: process.env,
    stdin: stdin === null ? "ignore" : new Blob([stdin]),
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

class ObservedGhRunner {
  readonly lookupCommentCounts: number[] = [];

  readonly run = async (
    argv: readonly string[],
    stdin: string | null,
  ): Promise<CommandResult> => {
    const result = await spawnGh(argv, stdin);
    if (
      result.exitCode === 0 &&
      argv[1]?.endsWith("/comments") === true &&
      argv.includes("--slurp")
    ) {
      this.lookupCommentCounts.push(
        parseIssueComments(result.stdout).length,
      );
    }
    return result;
  };
}

class DirectGhError extends Error {
  override readonly name = "DirectGhError";
  readonly httpStatus: number | null;

  constructor(
    readonly operation: string,
    readonly exitCode: number,
    stderr: string,
  ) {
    const match = stderr.match(/HTTP\s+([0-9]{3})/i);
    const status =
      match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
    super(
      `${operation} failed${status === null ? "" : ` (HTTP ${status})`}`,
    );
    this.httpStatus = status;
  }
}

async function directGh(
  operation: string,
  classificationOperation: Parameters<typeof classifyGhFailure>[0],
  argv: readonly string[],
  observeFailure: (error: IssueTrackerError) => void,
): Promise<string> {
  const result = await spawnGh(argv, null);
  if (result.exitCode !== 0) {
    observeFailure(
      classifyGhFailure(classificationOperation, result.stderr),
    );
    throw new DirectGhError(operation, result.exitCode, result.stderr);
  }
  return result.stdout;
}

function createVettedDirectGh(
  vettedTarget: IssueRef,
  observeFailure: (error: IssueTrackerError) => void,
): VettedDirectGh {
  const target = Object.freeze({ ...vettedTarget });
  return {
    async addLabel(label) {
      await directGh(
        `add label ${label}`,
        "add triage label",
        ghArgvBuilders.addLabel(target, label),
        observeFailure,
      );
    },
    async removeLabel(label) {
      await directGh(
        `remove label ${label}`,
        "remove triage label",
        ghArgvBuilders.removeLabel(target, label),
        observeFailure,
      );
    },
    async readCommentBodies() {
      const raw = await directGh(
        "read back comments",
        "find comment by marker",
        ghArgvBuilders.listComments(target),
        observeFailure,
      );
      return new Map(
        parseIssueComments(raw).map((comment) => [
          comment.ref.commentId,
          comment.body,
        ]),
      );
    },
  };
}

async function appendEvent(
  ledger: FsLedger,
  runId: string,
  input: NewRunEvent,
): Promise<void> {
  const current = await ledger.load(runId);
  const sequence = (current?.lastAppliedSequence ?? 0) + 1;
  await ledger.commit({
    schemaVersion: 1,
    eventId: `${runId}#${sequence}`,
    runId,
    sequence,
    at: Date.now() + sequence,
    controllerEpoch: current?.controllerEpoch ?? 0,
    ...input,
  } as RunEvent);
}

async function createCannedRun(options: {
  readonly tempRoot: string;
  readonly name: "a" | "b" | "c";
  readonly runId: string;
  readonly target: IssueRef;
  readonly includeStart: boolean;
  readonly includeBlocked: boolean;
  readonly includeVerification: boolean;
}): Promise<CannedRun> {
  const ledgerRoot = join(options.tempRoot, `ledger-${options.name}`);
  const cwd = join(options.tempRoot, `artifacts-${options.name}`);
  const runDirectory = join(cwd, options.runId);
  const laneId = `review-${options.name}`;
  const paneId = `issue-sync-smoke:p-${options.name}`;
  const controllerPaneId = `issue-sync-smoke:p-controller-${options.name}`;
  const sentinelToken =
    `FLOW_${options.runId}_LANE_${laneId}_EXIT`;
  const checkpointFile = join(
    runDirectory,
    "checkpoints",
    `${laneId}.md`,
  );
  const resultFile = join(
    runDirectory,
    "results",
    `${laneId}-result.txt`,
  );
  const evidenceFile = join(
    runDirectory,
    "evidence",
    `${laneId}-evidence.json`,
  );
  const logFile = join(runDirectory, "logs", `${laneId}.log`);
  const stderrFile = join(
    runDirectory,
    "logs",
    `${laneId}.stderr.log`,
  );
  await Promise.all([
    mkdir(join(runDirectory, "checkpoints"), { recursive: true }),
    mkdir(join(runDirectory, "results"), { recursive: true }),
    mkdir(join(runDirectory, "evidence"), { recursive: true }),
    mkdir(join(runDirectory, "logs"), { recursive: true }),
  ]);
  await Promise.all([
    Bun.write(
      checkpointFile,
      options.includeBlocked
        ? "STATUS: blocked\nBLOCKERS:\n- smoke blocker\n"
        : "STATUS: complete\n",
    ),
    Bun.write(resultFile, "STATUS: complete\nGAPS:\n- none\n"),
    Bun.write(
      evidenceFile,
      `${JSON.stringify({ schemaVersion: 1, exitCode: 0 })}\n`,
    ),
    Bun.write(logFile, ""),
    Bun.write(stderrFile, ""),
  ]);

  const ledger = new FsLedger(ledgerRoot);
  await appendEvent(ledger, options.runId, {
    type: "run_started",
    actor: "runtime",
    data: {
      workflow: `issue-sync-smoke-${options.name}`,
      workspace: "agent-flow",
      cwd,
      splitDirection: "down",
      tabId: `issue-sync-smoke:t-${options.name}`,
      controllerPaneId,
      fixedPoint: null,
      issue: options.target,
    },
  });
  await appendEvent(ledger, options.runId, {
    type: "lane_registered",
    actor: "runtime",
    laneId,
    data: {
      laneId,
      paneId,
      logFile,
      stderrFile,
      sentinelToken,
      steps: 1,
      stepDelaySeconds: 0,
      role: "smoke reviewer",
    },
  });
  if (options.includeStart) {
    await appendEvent(ledger, options.runId, {
      type: "lane_dispatch_intent",
      actor: "runtime",
      laneId,
      data: {},
    });
  }
  if (options.includeBlocked) {
    await appendEvent(ledger, options.runId, {
      type: "lane_checkpoint",
      actor: "agent",
      laneId,
      data: {
        semanticState: "blocked",
        checkpointFile,
        blockers: ["Owner input is required for the smoke fixture."],
        next: ["Wait for the owner."],
        gaps: ["No implementation gap."],
      },
    });
  }
  await appendEvent(ledger, options.runId, {
    type: "lane_exited",
    actor: "runtime",
    laneId,
    data: { exitCode: 0 },
  });
  await appendEvent(ledger, options.runId, {
    type: "lane_contract_evaluated",
    actor: "validator",
    laneId,
    data: {
      contractState: "satisfied",
      resultFile,
      errors: [],
    },
  });
  if (options.includeVerification) {
    await appendEvent(ledger, options.runId, {
      type: "lane_verification_recorded",
      actor: "runner",
      laneId,
      data: {
        verificationState: "verified",
        evidenceFile,
      },
    });
  }
  await appendEvent(ledger, options.runId, {
    type: "run_finished",
    actor: "runtime",
    data: {
      status: "clean",
      breakdown: {
        exitedZero: 1,
        exitedNonZero: 0,
        crashed: 0,
        lost: 0,
        failedToStart: 0,
      },
    },
  });
  return {
    ledger,
    ledgerRoot,
    runId: options.runId,
    paneIdentifiers: [paneId, controllerPaneId],
    sentinelIdentifiers: [sentinelToken],
  };
}

async function loadRun(run: CannedRun): Promise<RunView> {
  const loaded = await run.ledger.load(run.runId);
  requireCondition(loaded !== null, `run "${run.runId}" was not found`);
  return loaded;
}

async function flowResume(run: CannedRun): Promise<CliResult> {
  const child = Bun.spawn(
    ["bun", "run", "flow", "resume", run.runId],
    {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        FLOW_LEDGER_ROOT: run.ledgerRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { runId: run.runId, exitCode, stdout, stderr };
}

function requireCliSuccess(observation: CliResult): void {
  if (observation.exitCode === 0) return;
  const stdout = observation.stdout.trim();
  throw new Error(
    `flow resume "${observation.runId}" exited ${observation.exitCode}: stderr=${observation.stderr.trim()}${
      stdout.length === 0 ? "" : ` stdout=${stdout}`
    }`,
  );
}

function recordCliEvidence(
  evidence: SmokeEvidence,
  result: CliResult,
): void {
  evidence.cli.push({
    runId: result.runId,
    exitCode: result.exitCode,
    ...(result.exitCode === 0
      ? {}
      : {
          stderr: result.stderr,
          ...(result.stdout.length === 0
            ? {}
            : { stdout: result.stdout }),
        }),
  });
}

function requireDueKinds(
  run: RunView,
  expected: readonly DueMilestone["kind"][],
): readonly DueMilestone[] {
  const due = dueMilestones(run);
  requireCondition(
    JSON.stringify(due.map((item) => item.kind)) ===
      JSON.stringify(expected),
    `run "${run.runId}" due milestone set did not match ${expected.join(",")}`,
  );
  return due;
}

function deliveredComments(
  run: RunView,
): readonly CreatedComment[] {
  return run.deliveryOrder.map((deliveryId) => {
    const delivery = run.deliveries[deliveryId];
    if (
      delivery?.state === "failed" &&
      delivery.lastFailure !== null
    ) {
      throw new IssueTrackerError(
        delivery.lastFailure.reason,
        delivery.lastFailure.retryable,
      );
    }
    requireCondition(
      delivery?.state === "delivered" &&
        delivery.commentId !== null &&
        delivery.commentUrl !== null,
      `delivery "${deliveryId}" was not confirmed`,
    );
    return {
      deliveryId,
      ref: {
        commentId: delivery.commentId,
        commentUrl: delivery.commentUrl,
      },
    };
  });
}

function recordDeliveredUrls(
  evidence: SmokeEvidence,
  run: RunView,
): void {
  for (const deliveryId of run.deliveryOrder) {
    const commentUrl = run.deliveries[deliveryId]?.commentUrl;
    if (
      commentUrl !== null &&
      commentUrl !== undefined &&
      !evidence.commentUrls.includes(commentUrl)
    ) {
      evidence.commentUrls.push(commentUrl);
    }
  }
}

async function markerRoundTrip(
  tracker: RealIssueTracker,
  observedRunner: ObservedGhRunner,
  target: IssueRef,
  comments: readonly CreatedComment[],
): Promise<readonly MarkerObservation[]> {
  const observations: MarkerObservation[] = [];
  for (const created of comments) {
    const before = observedRunner.lookupCommentCounts.length;
    const found = await tracker.findCommentByMarker(
      target,
      marker(created.deliveryId),
    );
    requireCondition(
      found !== null &&
        found.commentId === created.ref.commentId,
      `marker lookup did not round-trip "${created.deliveryId}"`,
    );
    const parsedCommentCount =
      observedRunner.lookupCommentCounts[before];
    requireCondition(
      parsedCommentCount !== undefined,
      "successful marker lookup did not record its parsed comment count",
    );
    observations.push({
      deliveryId: created.deliveryId,
      ...found,
      parsedCommentCount,
    });
  }
  return observations;
}

async function assertAdapterRefusals(
  target: IssueRef,
): Promise<Record<string, unknown>> {
  let protectedRefusal: Record<string, unknown> | null = null;
  try {
    new RealIssueTracker({
      authorizedTarget: {
        owner: "netfishx",
        repo: "agent-flow",
        number: 6,
      },
      run: async () => {
        throw new Error("protected-target construction invoked gh");
      },
    });
    throw new Error("protected specification issue was accepted");
  } catch (error) {
    requireCondition(
      error instanceof IssueTrackerError &&
        error.retryable === false,
      "protected specification refusal was not non-retryable",
    );
    protectedRefusal = errorObservation(error);
  }

  let runnerCalls = 0;
  const tracker = new RealIssueTracker({
    authorizedTarget: target,
    run: async () => {
      runnerCalls += 1;
      throw new Error("unauthorized target invoked gh");
    },
  });
  const differing = [
    { ...target, owner: `${target.owner}-other` },
    { ...target, repo: `${target.repo}-other` },
    {
      ...target,
      number: target.number === 1 ? 2 : target.number - 1,
    },
  ] as const;
  const capabilityRefusals: Record<string, unknown>[] = [];
  for (const ref of differing) {
    for (const operation of [
      {
        capability: "resolveIssue",
        invoke: () => tracker.resolveIssue(ref),
      },
      {
        capability: "findCommentByMarker",
        invoke: () =>
          tracker.findCommentByMarker(
            ref,
            marker("issue-sync-smoke-allowlist-probe"),
          ),
      },
      {
        capability: "createComment",
        invoke: () =>
          tracker.createComment(ref, "must not be posted"),
      },
      {
        capability: "readCurrentLabels",
        invoke: () => tracker.readCurrentLabels(ref),
      },
      {
        capability: "compareAndSetTriageLabel",
        invoke: () =>
          tracker.compareAndSetTriageLabel(
            ref,
            "ready-for-agent",
            "needs-info",
          ),
      },
    ]) {
      try {
        await operation.invoke();
        throw new Error("unauthorized issue target was accepted");
      } catch (error) {
        requireCondition(
          error instanceof IssueTrackerError &&
            error.reason === "issue tracker target not authorized" &&
            error.retryable === false,
          "target allowlist refusal did not match the approved contract",
        );
        capabilityRefusals.push({
          capability: operation.capability,
          ...errorObservation(error),
        });
      }
    }
  }
  requireCondition(
    runnerCalls === 0,
    "adapter refusal assertion reached its command runner",
  );
  return {
    protectedRefusal,
    capabilityRefusals,
    commandRunnerCalls: runnerCalls,
  };
}

async function restoreTriageLabels(
  tracker: RealIssueTracker,
  direct: VettedDirectGh,
  target: IssueRef,
  startingLabels: readonly string[],
): Promise<Record<string, unknown>> {
  const desired = startingLabels.filter((label) =>
    TRIAGE_LABELS.has(label),
  );
  const before = await tracker.readCurrentLabels(target);
  for (const label of before) {
    if (TRIAGE_LABELS.has(label) && !desired.includes(label)) {
      await direct.removeLabel(label);
    }
  }
  for (const label of desired) {
    if (!before.includes(label)) await direct.addLabel(label);
  }
  const after = await tracker.readCurrentLabels(target);
  const restored = after
    .filter((label) => TRIAGE_LABELS.has(label))
    .sort();
  const expected = [...desired].sort();
  requireCondition(
    JSON.stringify(restored) === JSON.stringify(expected),
    "restored triage labels did not match the starting state",
  );
  return { attempted: true, before, expected, after, ok: true };
}

function assertRedaction(
  bodies: readonly {
    readonly deliveryId: string;
    readonly body: string;
  }[],
  input: {
    readonly tempRoot: string;
    readonly authorizationStatement: string;
    readonly paneIdentifiers: readonly string[];
    readonly sentinelIdentifiers: readonly string[];
  },
): Record<string, unknown> {
  const forbiddenLiterals = [
    "/Users/",
    input.tempRoot,
    "gho_",
    "ghp_",
    "github_pat_",
    input.authorizationStatement,
    ...input.paneIdentifiers,
    ...input.sentinelIdentifiers,
  ];
  for (const { deliveryId, body } of bodies) {
    requireCondition(
      body.split("\n")[0] === marker(deliveryId),
      `comment "${deliveryId}" does not begin with its exact marker`,
    );
    for (const forbidden of forbiddenLiterals) {
      requireCondition(
        forbidden.length === 0 || !body.includes(forbidden),
        `comment "${deliveryId}" failed the public-surface redaction scan`,
      );
    }
  }
  return {
    ok: true,
    commentCount: bodies.length,
    checks: [
      "exact marker first line",
      "/Users/",
      "temporary ledger root",
      "GitHub token prefixes",
      "owner authorization statement",
      "pane identifiers",
      "sentinel identifiers",
    ],
  };
}

async function writeEvidence(
  evidenceDir: string,
  evidence: SmokeEvidence,
): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, "issue-sync-smoke-result.json");
  await Bun.write(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
}

async function runIssueSyncSmoke(): Promise<number> {
  const environment = process.env;
  const gate = issueSyncGate(environment);
  if (!gate.ok) {
    line(`FLOW_SMOKE_REFUSED: ${gate.reason}`);
    return 2;
  }

  // Persistent by default, for the same reason as every other smoke: the
  // evidence must still be readable after a restart. Process-scoped, so two
  // concurrent invocations cannot overwrite each other's report.
  const evidenceDir =
    environment.FLOW_EVIDENCE_DIR === undefined ||
    environment.FLOW_EVIDENCE_DIR.length === 0
      ? join(resolveEvidenceRoot(environment), `issue-sync-${process.pid}`)
      : environment.FLOW_EVIDENCE_DIR;
  const evidence: SmokeEvidence = {
    ok: false,
    gate: {
      target: targetText(gate.target),
      authorizationStatement: gate.authorizationStatement,
    },
    tempLedgerRoot: null,
    scenarios: {},
    labels: {},
    cli: [],
    commentUrls: [],
    parseFailClosedPremise: {
      status: "not-run",
      commentCounts: [],
    },
    primaryRateLimit: { observed: false, detail: null },
    retainedComments: {
      disposition: "accepted-persistent-trace",
      commentUrls: [],
    },
    redaction: null,
    restoration: { attempted: false },
    cleanup: { attempted: false },
    failure: null,
  };

  const observedRunner = new ObservedGhRunner();
  const createdComments: CreatedComment[] = [];
  const paneIdentifiers: string[] = [];
  const sentinelIdentifiers: string[] = [];
  let trackerForRestore: RealIssueTracker | null = null;
  let directForRestore: VettedDirectGh | null = null;
  let tempRoot: string | null = null;
  let startingLabels: readonly string[] | null = null;
  let labelsMayNeedRestore = false;
  let primaryFailure: unknown = null;

  try {
    const tracker = new RealIssueTracker({
      authorizedTarget: gate.target,
      run: observedRunner.run,
    });
    trackerForRestore = tracker;
    const direct = createVettedDirectGh(
      gate.target,
      (error) => observePrimaryRateLimit(evidence, error),
    );
    directForRestore = direct;

    evidence.scenarios.adapterRefusals =
      await assertAdapterRefusals(gate.target);

    startingLabels = await tracker.readCurrentLabels(gate.target);
    evidence.labels.starting = startingLabels;
    requireCondition(
      startingLabels.includes("ready-for-agent"),
      `Owner setup required: apply ready-for-agent to ${targetText(gate.target)} before running the smoke`,
    );

    tempRoot = await mkdtemp(
      join(tmpdir(), "agent-flow-issue-sync-smoke-"),
    );
    evidence.tempLedgerRoot = tempRoot;
    const invocation =
      `${Date.now().toString(36)}-${process.pid.toString(36)}`;

    const scenarioA = await createCannedRun({
      tempRoot,
      name: "a",
      runId: `issue-sync-${invocation}-a`,
      target: gate.target,
      includeStart: true,
      includeBlocked: true,
      includeVerification: true,
    });
    paneIdentifiers.push(...scenarioA.paneIdentifiers);
    sentinelIdentifiers.push(...scenarioA.sentinelIdentifiers);
    const aDue = requireDueKinds(
      await loadRun(scenarioA),
      ["start", "blocked", "complete"],
    );
    labelsMayNeedRestore = true;
    const aFirstCli = await flowResume(scenarioA);
    recordCliEvidence(evidence, aFirstCli);
    requireCliSuccess(aFirstCli);
    const aFirst = await loadRun(scenarioA);
    evidence.scenarios.a = {
      dueKinds: aDue.map((item) => item.kind),
      deliveries: aFirst.deliveryOrder.map(
        (deliveryId) => aFirst.deliveries[deliveryId],
      ),
    };
    recordDeliveredUrls(evidence, aFirst);
    const aComments = deliveredComments(aFirst);
    requireCondition(aComments.length === 3, "scenario A did not deliver three milestones");
    const aBlocked = aFirst.deliveries[
      aDue.find((item) => item.kind === "blocked")!.deliveryId
    ];
    requireCondition(
      aBlocked?.labelTransition === "applied",
      "scenario A blocked label CAS was not applied",
    );
    createdComments.push(...aComments);
    const labelsAfterA = await tracker.readCurrentLabels(gate.target);
    evidence.labels.afterScenarioA = labelsAfterA;
    const aMarkerRoundTrip = await markerRoundTrip(
      tracker,
      observedRunner,
      gate.target,
      aComments,
    );
    evidence.parseFailClosedPremise = {
      status: "observed",
      commentCounts: aMarkerRoundTrip.map(
        (observation) => observation.parsedCommentCount,
      ),
    };
    evidence.scenarios.a = {
      ...evidence.scenarios.a as Record<string, unknown>,
      labelsAfter: labelsAfterA,
      markerRoundTrip: aMarkerRoundTrip,
    };

    const intentsBefore = Object.fromEntries(
      aFirst.deliveryOrder.map((deliveryId) => [
        deliveryId,
        aFirst.deliveries[deliveryId]!.intents,
      ]),
    );
    const aSecondCli = await flowResume(scenarioA);
    recordCliEvidence(evidence, aSecondCli);
    requireCliSuccess(aSecondCli);
    const aSecond = await loadRun(scenarioA);
    const intentsAfter = Object.fromEntries(
      aSecond.deliveryOrder.map((deliveryId) => [
        deliveryId,
        aSecond.deliveries[deliveryId]!.intents,
      ]),
    );
    requireCondition(
      JSON.stringify(intentsAfter) === JSON.stringify(intentsBefore),
      "scenario B1 changed delivery intent counts",
    );
    const b1MarkerRoundTrip = await markerRoundTrip(
      tracker,
      observedRunner,
      gate.target,
      aComments,
    );
    evidence.scenarios.b1 = {
      intentsBefore,
      intentsAfter,
      markerRoundTrip: b1MarkerRoundTrip,
    };

    const scenarioB = await createCannedRun({
      tempRoot,
      name: "b",
      runId: `issue-sync-${invocation}-b`,
      target: gate.target,
      includeStart: true,
      includeBlocked: false,
      includeVerification: false,
    });
    paneIdentifiers.push(...scenarioB.paneIdentifiers);
    sentinelIdentifiers.push(...scenarioB.sentinelIdentifiers);
    const bDue = requireDueKinds(await loadRun(scenarioB), ["start"]);
    requireCondition(
      aFirst.issueNodeId !== null,
      "scenario A did not persist the resolved issue node id",
    );
    await appendEvent(scenarioB.ledger, scenarioB.runId, {
      type: "issue_binding_resolved",
      actor: "runtime",
      data: { issueNodeId: aFirst.issueNodeId },
    });
    const bStart = bDue[0]!;
    await appendEvent(scenarioB.ledger, scenarioB.runId, {
      type: "issue_delivery_intended",
      actor: "runtime",
      data: {
        deliveryId: bStart.deliveryId,
        kind: "start",
        laneId: null,
        payloadHash: canonicalPayloadHash(bStart.payload),
      },
    });
    const preposted = await tracker.createComment(
      gate.target,
      renderMilestone(bStart, {
        labelTransition: "not-applicable",
      }),
    );
    const bCreated = {
      deliveryId: bStart.deliveryId,
      ref: preposted,
    };
    createdComments.push(bCreated);
    evidence.commentUrls.push(preposted.commentUrl);
    const bCli = await flowResume(scenarioB);
    recordCliEvidence(evidence, bCli);
    requireCliSuccess(bCli);
    const bAfter = await loadRun(scenarioB);
    const bDelivery = bAfter.deliveries[bStart.deliveryId];
    if (
      bDelivery?.state === "failed" &&
      bDelivery.lastFailure !== null
    ) {
      throw new IssueTrackerError(
        bDelivery.lastFailure.reason,
        bDelivery.lastFailure.retryable,
      );
    }
    requireCondition(
      bDelivery?.state === "delivered" &&
        bDelivery.commentId === preposted.commentId,
      "scenario B2 did not backfill the pre-posted start comment",
    );
    const bMarkerRoundTrip = await markerRoundTrip(
      tracker,
      observedRunner,
      gate.target,
      [bCreated],
    );
    evidence.scenarios.b2 = {
      dueKinds: bDue.map((item) => item.kind),
      preposted,
      delivered: bDelivery,
      markerRoundTrip: bMarkerRoundTrip,
    };

    requireCondition(
      labelsAfterA.includes("needs-info"),
      "scenario A did not leave needs-info for scenario C setup",
    );
    await direct.removeLabel("needs-info");
    await direct.addLabel("needs-triage");
    const labelsBeforeC = await tracker.readCurrentLabels(gate.target);
    evidence.labels.beforeScenarioC = labelsBeforeC;
    requireCondition(
      labelsBeforeC.includes("needs-triage") &&
        !labelsBeforeC.includes("needs-info"),
      "scenario C human-set label setup failed",
    );

    const scenarioC = await createCannedRun({
      tempRoot,
      name: "c",
      runId: `issue-sync-${invocation}-c`,
      target: gate.target,
      includeStart: false,
      includeBlocked: true,
      includeVerification: false,
    });
    paneIdentifiers.push(...scenarioC.paneIdentifiers);
    sentinelIdentifiers.push(...scenarioC.sentinelIdentifiers);
    const cDue = requireDueKinds(await loadRun(scenarioC), ["blocked"]);
    const cCli = await flowResume(scenarioC);
    recordCliEvidence(evidence, cCli);
    requireCliSuccess(cCli);
    const cAfter = await loadRun(scenarioC);
    recordDeliveredUrls(evidence, cAfter);
    const cComments = deliveredComments(cAfter);
    requireCondition(cComments.length === 1, "scenario C did not deliver one blocked milestone");
    const cDelivery = cAfter.deliveries[cDue[0]!.deliveryId];
    requireCondition(
      cDelivery?.labelTransition === "skipped",
      "scenario C did not skip label CAS under human-set state",
    );
    createdComments.push(...cComments);
    const labelsAfterC = await tracker.readCurrentLabels(gate.target);
    evidence.labels.afterScenarioC = labelsAfterC;
    requireCondition(
      labelsAfterC.includes("needs-triage") &&
        !labelsAfterC.includes("needs-info"),
      "scenario C did not preserve the human-set triage state",
    );
    evidence.scenarios.c = {
      dueKinds: cDue.map((item) => item.kind),
      delivery: cDelivery,
      labelsBefore: labelsBeforeC,
      labelsAfter: labelsAfterC,
    };

    const allCommentBodies = await direct.readCommentBodies();
    const createdBodies = createdComments.map(({ deliveryId, ref }) => {
      const body = allCommentBodies.get(ref.commentId);
      requireCondition(
        body !== undefined,
        `created comment ${ref.commentId} was absent during read-back`,
      );
      return { deliveryId, body };
    });
    evidence.redaction = assertRedaction(createdBodies, {
      tempRoot,
      authorizationStatement: gate.authorizationStatement,
      paneIdentifiers,
      sentinelIdentifiers,
    });
  } catch (error) {
    primaryFailure = error;
    observePrimaryRateLimit(evidence, error);
    evidence.failure = errorObservation(error);
  } finally {
    if (
      labelsMayNeedRestore &&
      startingLabels !== null &&
      trackerForRestore !== null &&
      directForRestore !== null
    ) {
      try {
        evidence.restoration = await restoreTriageLabels(
          trackerForRestore,
          directForRestore,
          gate.target,
          startingLabels,
        );
        evidence.labels.restored =
          (evidence.restoration.after as readonly string[]) ?? [];
      } catch (error) {
        observePrimaryRateLimit(evidence, error);
        evidence.restoration = {
          attempted: true,
          ok: false,
          failure: errorObservation(error),
        };
        if (primaryFailure === null) {
          primaryFailure = error;
          evidence.failure = errorObservation(error);
        }
      }
    }
    if (tempRoot !== null) {
      try {
        await rm(tempRoot, { recursive: true });
        evidence.cleanup = { attempted: true, ok: true };
      } catch (error) {
        evidence.cleanup = {
          attempted: true,
          ok: false,
          failure: errorObservation(error),
        };
      }
    }
  }

  evidence.ok = primaryFailure === null;
  evidence.retainedComments.commentUrls = [...evidence.commentUrls];
  let evidencePath: string;
  try {
    evidencePath = await writeEvidence(evidenceDir, evidence);
  } catch (error) {
    line(
      `FLOW_SMOKE_ERROR: evidence write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }
  line(`evidence=${evidencePath}`);
  if (!evidence.ok) {
    line(
      `FLOW_SMOKE_ERROR: ${
        evidence.failure?.reason ??
        evidence.failure?.message ??
        "issue synchronization smoke failed"
      }`,
    );
    return 2;
  }
  line("FLOW_SMOKE_DONE=0");
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runIssueSyncSmoke();
}
