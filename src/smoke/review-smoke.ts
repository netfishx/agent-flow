// Real-stack cross-review smoke: six visible agent lanes (claude, codex,
// grok x standards, spec) in one Herdr tab.
//
// Rehearsal mode (unbound, historical diff, NOT acceptance evidence):
//   a dispatch child starts the run and holds the controller lease; the
//   parent proves per-CLI-family pre-completion visibility from the durable
//   tee files, waits for the scheduled single-lane interrupt, SIGKILLs the
//   controller while lanes are still live, and resumes through the real CLI
//   to prove re-observation and collection.
//
// Formal mode (bound to the issue under review): one process drives all six
// lanes to completion against the implementation branch's own diff with
// dirtyStatePolicy=reject, producing raw reports, derived results, a full
// ledger, and real start/complete milestones.

import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RealHerdrAdapter } from "../herdr/real-adapter.ts";
import { RealIssueTracker } from "../issue/real-tracker.ts";
import type { BundleSourceFile } from "../review/bundle.ts";
import { GitReviewIsolation } from "../review/isolation.ts";
import type { FixedPoint } from "../runtime/events.ts";
import { FsLedger, resolveLedgerRoot } from "../runtime/fs-ledger.ts";
import { laneSentinelToken } from "../runtime/ids.ts";
import type { RunView } from "../runtime/reducer.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import type {
  AgentLaneSpec,
  RuntimeDeps,
} from "../runtime/types.ts";
import type { ReviewAgentKind } from "../review/types.ts";
import {
  implementationWorktreeRefusal,
  resolveEvidenceRoot,
  runEvidencePath,
  volatileEvidenceRootRefusal,
} from "./evidence-root.ts";
import {
  formalAcceptance,
  formalOverrideRefusal,
  issueTargetMatchesOrigin,
  readInterruptEvidence,
  rehearsalAcceptance,
  reviewSmokeGate,
  type ReviewSmokeMode,
} from "./review-gate.ts";

const REHEARSAL_HEAD = "d932c71fe8899d7fc589c96918813b16f57b5692";

// The established name, not a local alias for it.
const FAMILIES: readonly ReviewAgentKind[] = ["claude", "codex", "grok"];

const line = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

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

interface ModelChoice {
  readonly model: string;
  readonly effort: string;
}

// The D6 model/effort batteries. Formal runs use these EXACTLY — no
// environment override can weaken a formal run's lanes, models, or efforts.
const FORMAL_MODELS: Record<ReviewAgentKind, ModelChoice> = {
  claude: { model: "claude-opus-5", effort: "high" },
  codex: { model: "gpt-5.6-sol", effort: "high" },
  grok: { model: "grok-4.5", effort: "high" },
};

function modelFor(mode: ReviewSmokeMode, family: ReviewAgentKind): ModelChoice {
  if (mode === "formal") return FORMAL_MODELS[family];
  const rehearsalDefaults: Record<ReviewAgentKind, ModelChoice> = {
    claude: { model: "claude-haiku-4-5-20251001", effort: "low" },
    codex: { model: "gpt-5.6-sol", effort: "low" },
    grok: { model: "grok-4.5", effort: "low" },
  };
  const prefix = `FLOW_REVIEW_${family.toUpperCase()}`;
  return {
    model: env(`${prefix}_MODEL`, rehearsalDefaults[family].model),
    effort: env(`${prefix}_EFFORT`, rehearsalDefaults[family].effort),
  };
}

function laneSpecs(mode: ReviewSmokeMode): AgentLaneSpec[] {
  // Only a rehearsal may narrow the family set (cheap debugging); a formal
  // run always fields all three families x both axes.
  const families =
    mode === "formal"
      ? [...FAMILIES]
      : env("FLOW_REVIEW_FAMILIES", FAMILIES.join(","))
          .split(",")
          .map((family) => family.trim())
          .filter((family): family is ReviewAgentKind =>
            (FAMILIES as readonly string[]).includes(family),
          );
  return families.flatMap((family) => {
    const { model, effort } = modelFor(mode, family);
    return (["standards", "spec"] as const).map((axis) => ({
      kind: "agent" as const,
      laneId: `${family}-${axis}`,
      axis,
      agentKind: family,
      model,
      effort,
    }));
  });
}

function config() {
  const mode = env("FLOW_REVIEW_MODE", "rehearsal") as ReviewSmokeMode;
  const repoRoot = env(
    "FLOW_REVIEW_REPO_ROOT",
    join(import.meta.dir, "../.."),
  );
  // The evidence root shares the ledger's state root, so a run's artifacts and
  // the ledger that points at them cannot outlive each other.
  const evidenceDir = resolveEvidenceRoot();
  const runId = env(
    "FLOW_RUN_ID",
    `review-${Date.now().toString(36)}-${process.pid.toString(36)}`,
  );
  return {
    mode,
    repoRoot,
    evidenceDir,
    workspace: env("FLOW_WORKSPACE", "w1"),
    runId,
    readyFile: env(
      "FLOW_READY_FILE",
      runEvidencePath(evidenceDir, runId, "controller-ready"),
    ),
    readyTimeoutMs: num("FLOW_CONTROLLER_READY_TIMEOUT_MS", 120_000),
    laneTimeoutMs: num("FLOW_REVIEW_LANE_TIMEOUT_MS", 1_800_000),
    interruptLane: env("FLOW_REVIEW_INTERRUPT_LANE", "codex-spec"),
    interruptAfterMs: num("FLOW_REVIEW_INTERRUPT_AFTER_MS", 20_000),
    visibilityTimeoutMs: num("FLOW_REVIEW_VISIBILITY_TIMEOUT_MS", 180_000),
    unobservedMs: num("FLOW_UNOBSERVED_MS", 5_000),
    ledgerRoot: resolveLedgerRoot(),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

async function captureFixedPoint(
  mode: ReviewSmokeMode,
  repoRoot: string,
): Promise<FixedPoint> {
  const isolation = new GitReviewIsolation();
  if (mode === "rehearsal") {
    const head = env("FLOW_REVIEW_HEAD", REHEARSAL_HEAD);
    const base = env("FLOW_REVIEW_BASE", `${head}^`);
    return isolation.captureFixedPoint({
      repoRoot,
      baseRef: base,
      headRef: head,
      dirtyStatePolicy: "record-hash",
    });
  }
  // A formal run's fixed point is computed, never supplied: the branch tip and
  // its merge-base with the main branch. `formalOverrideRefusal` has already
  // refused any environment attempt to redirect it.
  const headCommit = (await git(repoRoot, "rev-parse", "HEAD")).trim();
  const mergeBase = (
    await git(repoRoot, "merge-base", "HEAD", "origin/main")
  ).trim();
  const fixedPoint = await isolation.captureFixedPoint({
    repoRoot,
    baseRef: mergeBase,
    headRef: headCommit,
    dirtyStatePolicy: "reject",
  });
  if (fixedPoint.headCommit !== headCommit) {
    throw new Error("formal fixed point head does not match the branch tip");
  }
  if (fixedPoint.baseCommit !== mergeBase) {
    throw new Error("formal fixed point base does not match the merge-base");
  }
  return fixedPoint;
}

interface MaterialSpec {
  readonly bundlePath: string;
  readonly role: "issue" | "spec" | "standards";
  readonly source: string;
}

async function captureMaterials(
  repoRoot: string,
  headCommit: string,
): Promise<BundleSourceFile[]> {
  const configured = process.env.FLOW_REVIEW_MATERIALS;
  if (configured !== undefined && configured.length > 0) {
    const specs = JSON.parse(
      await readFile(configured, "utf8"),
    ) as MaterialSpec[];
    const files: BundleSourceFile[] = [];
    for (const spec of specs) {
      files.push({
        path: spec.bundlePath,
        role: spec.role,
        content: await readFile(spec.source, "utf8"),
      });
    }
    return files;
  }
  // Default materials: the change intent from the head commit itself, the
  // runtime design as the spec, and the repository ground rules as standards.
  return [
    {
      path: "bundle/change-intent.md",
      role: "issue",
      content: await git(repoRoot, "log", "-1", "--format=%B", headCommit),
    },
    {
      path: "bundle/runtime-design.md",
      role: "spec",
      content: await readFile(
        join(repoRoot, "docs/design/observable-multi-agent-runtime.md"),
        "utf8",
      ),
    },
    {
      path: "bundle/standards/agents.md",
      role: "standards",
      content: await readFile(join(repoRoot, "AGENTS.md"), "utf8"),
    },
    {
      path: "bundle/standards/context.md",
      role: "standards",
      content: await readFile(join(repoRoot, "CONTEXT.md"), "utf8"),
    },
    // AGENTS.md names these three as the repository's tracker and domain
    // conventions, so a standards-axis reviewer cannot check its charter
    // without them.
    ...(await Promise.all(
      ["domain", "issue-tracker", "triage-labels"].map(async (name) => ({
        path: `bundle/standards/${name}.md`,
        role: "standards" as const,
        content: await readFile(
          join(repoRoot, "docs", "agents", `${name}.md`),
          "utf8",
        ),
      })),
    )),
  ];
}

function makeDeps(runId: string, target: ReturnType<typeof reviewSmokeGate>) {
  const deps: RuntimeDeps = {
    adapter: new RealHerdrAdapter(),
    ledger: new FsLedger(resolveLedgerRoot()),
    clock: () => Date.now(),
    idgen: () => runId,
    readResultFile: (path) => Bun.file(path).text(),
    sleep,
    reviewIsolation: new GitReviewIsolation(),
    sessionIdgen: () => randomUUID(),
    ...(target.ok && target.target !== null
      ? {
          issueTracker: new RealIssueTracker({
            authorizedTarget: target.target,
          }),
        }
      : {}),
  };
  return deps;
}

// ---------------------------------------------------------------------------
// Rehearsal: dispatch child

async function dispatchPhase(): Promise<void> {
  const gate = reviewSmokeGate(process.env);
  if (!gate.ok) throw new Error(`gate refused: ${gate.reason}`);
  const c = config();
  await mkdir(runEvidencePath(c.evidenceDir, c.runId), { recursive: true });
  const fixedPoint = await captureFixedPoint(c.mode, c.repoRoot);
  const materials = await captureMaterials(c.repoRoot, fixedPoint.headCommit);
  const runtime = new WorkflowRuntime(makeDeps(c.runId, gate));
  const lanes = laneSpecs(c.mode);

  line(
    `[dispatch pid=${process.pid}] runId=${c.runId} lanes=${lanes
      .map((lane) => lane.laneId)
      .join(",")}`,
  );
  const handle = await runtime.startWorkflow({
    workflow: "cross-review",
    workspace: c.workspace,
    cwd: c.evidenceDir,
    lanes,
    splitDirection: "down",
    startupSettleMs: 1_000,
    fixedPoint,
    inputBundle: materials,
  });
  for (const laneId of handle.laneIds) {
    const live = await runtime.confirmLaneStarted(handle.runId, laneId, 30_000);
    line(`[dispatch] lane=${laneId} live=${live}`);
  }
  await Bun.write(c.readyFile, `${handle.runId}\n`);
  line("[dispatch] controller ready and holding lease");

  if (c.interruptLane.length > 0 && c.mode === "rehearsal") {
    await sleep(c.interruptAfterMs);
    const outcome = await runtime.interruptLane(handle.runId, c.interruptLane);
    line(
      `[dispatch] interrupt lane=${c.interruptLane} delivered=${outcome.delivered}`,
    );
    await Bun.write(
      runEvidencePath(c.evidenceDir, c.runId, "interrupt-evidence.json"),
      `${JSON.stringify(outcome, null, 2)}\n`,
    );
  }

  for (;;) await sleep(60_000);
}

// ---------------------------------------------------------------------------
// Rehearsal: parent observer

interface LaneObservation {
  laneId: string;
  family: ReviewAgentKind;
  firstProgressAt: number | null;
  completedAt: number | null;
  progressBeforeCompletion: boolean;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Null distinguishes "unreadable" from "readable but wrong", unlike "". */
async function readInterruptEvidenceFile(
  path: string,
): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function cliProgressBytes(log: string, stderr: string): number {
  // Wrapper banners are not CLI progress; count everything else.
  const logProgress = log
    .split("\n")
    .filter(
      (row) =>
        row.length > 0 &&
        !row.startsWith("LANE_START ") &&
        !row.startsWith("LANE_CWD_FAILED "),
    )
    .join("");
  return logProgress.length + stderr.length;
}

async function observeLanes(
  c: ReturnType<typeof config>,
  laneIds: readonly string[],
  until: (observations: readonly LaneObservation[]) => boolean,
  timeoutMs: number,
): Promise<LaneObservation[]> {
  const runDir = runEvidencePath(c.evidenceDir, c.runId);
  const observations: LaneObservation[] = laneIds.map((laneId) => ({
    laneId,
    family: laneId.split("-")[0] as ReviewAgentKind,
    firstProgressAt: null,
    completedAt: null,
    progressBeforeCompletion: false,
  }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const observation of observations) {
      const log = await readOrEmpty(
        join(runDir, "logs", `${observation.laneId}.log`),
      );
      const stderr = await readOrEmpty(
        join(runDir, "logs", `${observation.laneId}.stderr.log`),
      );
      const completed = log.includes(
        `${laneSentinelToken(c.runId, observation.laneId)}=`,
      );
      const progress = cliProgressBytes(log, stderr) > 0;
      if (progress && observation.firstProgressAt === null) {
        observation.firstProgressAt = Date.now();
        if (!completed) observation.progressBeforeCompletion = true;
      }
      if (completed && observation.completedAt === null) {
        observation.completedAt = Date.now();
      }
    }
    if (until(observations) || Date.now() >= deadline) return observations;
    await sleep(500);
  }
}

async function waitForReady(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await Bun.file(path).exists()) return;
    if (Date.now() >= deadline) {
      throw new Error(`dispatch controller not ready within ${timeoutMs}ms`);
    }
    await sleep(200);
  }
}

async function flowCli(
  ledgerRoot: string,
  laneTimeoutMs: number,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

function laneSummary(run: RunView) {
  return run.laneOrder.map((laneId) => {
    const lane = run.lanes[laneId]!;
    return {
      laneId,
      model: lane.model,
      effort: lane.effort,
      runtimeState: lane.runtimeState,
      exitCode: lane.exitCode,
      semanticState: lane.semanticState,
      contractState: lane.contractState,
      contractErrors: lane.contractErrors,
      verificationState: lane.verificationState,
      sessionIdentity: lane.sessionIdentity,
      isolationPre: lane.isolationPre,
      isolationPost: lane.isolationPost,
      rawReportFile: lane.rawReportFile,
      rawReportOutcome: lane.rawReportOutcome,
      resultFile: lane.resultFile,
      checkpointOrigin: lane.checkpointOrigin,
      worktreeDisposition: lane.worktreeDisposition,
    };
  });
}

async function rehearsalParent(): Promise<void> {
  const gate = reviewSmokeGate(process.env);
  if (!gate.ok) {
    line(`FLOW_REVIEW_SMOKE_REFUSED reason=${gate.reason}`);
    process.exitCode = 3;
    return;
  }
  const c = config();
  await mkdir(runEvidencePath(c.evidenceDir, c.runId), { recursive: true });
  const lanes = laneSpecs(c.mode).map((lane) => lane.laneId);
  line("== agent-flow cross-review rehearsal smoke ==");
  line(`runId=${c.runId} evidence=${c.evidenceDir} lanes=${lanes.join(",")}`);

  const controller = Bun.spawn(
    ["bun", "run", import.meta.path, "__dispatch__"],
    {
      env: {
        ...process.env,
        FLOW_RUN_ID: c.runId,
        FLOW_EVIDENCE_DIR: c.evidenceDir,
        FLOW_READY_FILE: c.readyFile,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  let controllerReaped = false;
  try {
    await waitForReady(c.readyFile, c.readyTimeoutMs);

    // Visibility gate: per family, CLI-attributable bytes must appear in the
    // durable tee files (the same bytes the pane renders) strictly before
    // that lane's completion sentinel.
    const interruptEvidenceFile = runEvidencePath(
      c.evidenceDir,
      c.runId,
      "interrupt-evidence.json",
    );
    const observations = await observeLanes(
      c,
      lanes,
      (current) => {
        const everyFamilyProven = FAMILIES.every((family) =>
          current.some(
            (observation) =>
              observation.family === family &&
              observation.progressBeforeCompletion,
          ),
        );
        return everyFamilyProven;
      },
      c.visibilityTimeoutMs,
    );
    const visibility = FAMILIES.map((family) => ({
      family,
      proven: observations.some(
        (observation) =>
          observation.family === family &&
          observation.progressBeforeCompletion,
      ),
    }));
    line(
      `visibility gate: ${visibility
        .map((entry) => `${entry.family}=${entry.proven}`)
        .join(" ")}`,
    );

    // Wait for the scheduled interrupt to land: the target lane must reach
    // its sentinel shortly after the SIGINT. CLIs are free to catch SIGINT
    // and exit with their own code (codex exits 1), so any sentinel counts;
    // the recorded exit code stays honest.
    const interruptDeadline = Date.now() + c.interruptAfterMs + 60_000;
    let interruptExit: number | null = null;
    const sentinelPattern = new RegExp(
      `${laneSentinelToken(c.runId, c.interruptLane)}=(\\d+)`,
    );
    while (Date.now() < interruptDeadline) {
      const log = await readOrEmpty(
        runEvidencePath(c.evidenceDir, c.runId, "logs", `${c.interruptLane}.log`),
      );
      const match = log.match(sentinelPattern);
      if (match) {
        interruptExit = Number.parseInt(match[1]!, 10);
        break;
      }
      await sleep(500);
    }
    const interrupted = interruptExit !== null && interruptExit !== 0;
    const interruptEvidence = readInterruptEvidence(
      await readInterruptEvidenceFile(interruptEvidenceFile),
      c.interruptLane,
    );
    line(
      `interrupt observed: lane=${c.interruptLane} exit=${interruptExit} accepted=${interrupted} evidence=${
        interruptEvidence.ok ? "valid" : `INVALID (${interruptEvidence.reason})`
      }`,
    );

    let aliveAtKill = 0;
    for (const laneId of lanes) {
      const log = await readOrEmpty(
        runEvidencePath(c.evidenceDir, c.runId, "logs", `${laneId}.log`),
      );
      if (!log.includes(`${laneSentinelToken(c.runId, laneId)}=`)) {
        aliveAtKill += 1;
      }
    }
    controller.kill("SIGKILL");
    await controller.exited;
    controllerReaped = true;
    line(`controller SIGKILLed with ${aliveAtKill} lane(s) still live`);
    await sleep(c.unobservedMs);

    const resumed = await flowCli(
      c.ledgerRoot,
      c.laneTimeoutMs,
      "resume",
      c.runId,
    );
    if (resumed.exitCode !== 0) {
      throw new Error(
        `resume failed: exit=${resumed.exitCode} stderr=${resumed.stderr.trim()}`,
      );
    }
    line("resume completed collection after controller loss");

    const run = await new FsLedger(c.ledgerRoot).load(c.runId);
    if (!run || run.finishStatus === null) {
      throw new Error("run did not reach run_finished");
    }
    const acceptance = rehearsalAcceptance({
      visibility,
      interruptSentinelNonZero: interrupted,
      interruptEvidenceOk: interruptEvidence.ok,
      laneCount: lanes.length,
      exitedZero: run.breakdown?.exitedZero ?? null,
      exitedNonZero: run.breakdown?.exitedNonZero ?? null,
      aliveAtKill,
      finishStatus: run.finishStatus,
    });
    const report = {
      mode: c.mode,
      runId: c.runId,
      acceptanceEvidence: false,
      fixedPoint: run.fixedPoint,
      bundleHash: run.inputBundle?.bundleHash ?? null,
      evidenceRoot: c.evidenceDir,
      runEvidenceDir: runEvidencePath(c.evidenceDir, c.runId),
      visibility,
      interrupt: {
        laneId: c.interruptLane,
        exitCode: interruptExit,
        accepted: interrupted,
        evidence: interruptEvidence.ok ? interruptEvidence.evidence : null,
        evidenceFailure: interruptEvidence.ok ? null : interruptEvidence.reason,
      },
      controllerLoss: { aliveAtKill, resumedExit: resumed.exitCode },
      // Interrupting exactly one lane is the demonstration, so it is asserted
      // rather than merely implied by a non-invalid finish.
      interruptIsolation: {
        interruptedLanes: run.breakdown?.exitedNonZero ?? null,
        completedLanes: run.breakdown?.exitedZero ?? null,
        expectedCompleted: lanes.length - 1,
      },
      finishStatus: run.finishStatus,
      lanes: laneSummary(run),
      observations,
      failures: acceptance.failures,
      ok: acceptance.ok,
    };
    await Bun.write(
      runEvidencePath(c.evidenceDir, c.runId, "rehearsal-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    line(`FLOW_REVIEW_SMOKE_DONE=${report.ok ? 0 : 1}`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    if (!controllerReaped) {
      controller.kill("SIGKILL");
      await controller.exited;
    }
  }
}

// ---------------------------------------------------------------------------
// Formal run: one process drives to completion

async function formalRun(): Promise<void> {
  const gate = reviewSmokeGate(process.env);
  if (!gate.ok) {
    line(`FLOW_REVIEW_SMOKE_REFUSED reason=${gate.reason}`);
    process.exitCode = 3;
    return;
  }
  const c = config();
  // A formal run reviews a bound issue: its materials are the issue and spec
  // texts themselves, captured explicitly — the rehearsal defaults are not
  // acceptable review inputs here.
  const materialsFile = process.env.FLOW_REVIEW_MATERIALS;
  if (materialsFile === undefined || materialsFile.length === 0) {
    throw new Error(
      "a formal run requires FLOW_REVIEW_MATERIALS pointing at the captured issue/spec/standards materials",
    );
  }
  // Refuse before anything is written or dispatched: a formal run that reviewed
  // the wrong tree, or reported onto the wrong issue, would still leave
  // evidence that looked correct.
  const overrideRefusal = formalOverrideRefusal(process.env);
  if (overrideRefusal !== null) {
    throw new Error(`formal run refused: ${overrideRefusal}`);
  }
  // Acceptance evidence written into a directory the operating system may clear
  // is not evidence. This refusal is what makes "raw report retained" true of
  // the default configuration rather than of one operator's careful choice.
  const volatileRefusal = volatileEvidenceRootRefusal(c.evidenceDir);
  if (volatileRefusal !== null) {
    throw new Error(`formal run refused: ${volatileRefusal}`);
  }
  const insideRepoRefusal = implementationWorktreeRefusal(
    c.evidenceDir,
    c.repoRoot,
  );
  if (insideRepoRefusal !== null) {
    throw new Error(`formal run refused: ${insideRepoRefusal}`);
  }
  const originUrl = await git(c.repoRoot, "remote", "get-url", "origin");
  if (!issueTargetMatchesOrigin(gate.target!, originUrl)) {
    throw new Error(
      `formal run refused: issue target ${gate.target!.owner}/${gate.target!.repo} is not the repository under review (${originUrl.trim()})`,
    );
  }
  await mkdir(runEvidencePath(c.evidenceDir, c.runId), { recursive: true });
  const fixedPoint = await captureFixedPoint(c.mode, c.repoRoot);
  const materials = await captureMaterials(c.repoRoot, fixedPoint.headCommit);
  const runtime = new WorkflowRuntime(makeDeps(c.runId, gate));
  const lanes = laneSpecs(c.mode);
  if (lanes.length !== 6) {
    throw new Error(`a formal run fields exactly six lanes, got ${lanes.length}`);
  }

  line("== agent-flow cross-review FORMAL run ==");
  line(
    `runId=${c.runId} base=${fixedPoint.baseCommit} head=${fixedPoint.headCommit}`,
  );
  const handle = await runtime.startWorkflow({
    workflow: "cross-review",
    workspace: c.workspace,
    cwd: c.evidenceDir,
    lanes,
    splitDirection: "down",
    startupSettleMs: 1_000,
    fixedPoint,
    issue: gate.target,
    inputBundle: materials,
  });
  for (const laneId of handle.laneIds) {
    const live = await runtime.confirmLaneStarted(handle.runId, laneId, 30_000);
    line(`lane=${laneId} live=${live}`);
  }
  for (const laneId of handle.laneIds) {
    const result = await runtime.awaitLane(
      handle.runId,
      laneId,
      c.laneTimeoutMs,
    );
    line(
      `lane=${laneId} state=${result.state} exit=${result.exitCode} timedOut=${result.timedOut}`,
    );
  }

  const run = await new FsLedger(c.ledgerRoot).load(c.runId);
  if (!run || run.finishStatus === null) {
    throw new Error("formal run did not reach run_finished");
  }
  const deliveries = run.deliveryOrder.map((deliveryId) => {
    const delivery = run.deliveries[deliveryId]!;
    return {
      deliveryId,
      kind: delivery.kind,
      state: delivery.state,
      commentUrl: delivery.commentUrl,
      labelTransition: delivery.labelTransition,
    };
  });
  // A formal run is acceptance evidence only when the runtime itself called the
  // finish `clean` and every lane produced a verified, contract-satisfying
  // report from a captured raw artifact. A lost or malformed report is the stop
  // line's "unrecoverable report loss", never a quiet pass.
  const acceptance = formalAcceptance({
    finishStatus: run.finishStatus,
    expectedLaneCount: lanes.length,
    bundleRoles: (run.inputBundle?.files ?? []).map((file) => file.role),
    deliveries: deliveries.map((delivery) => ({
      kind: delivery.kind,
      state: delivery.state,
    })),
    lanes: run.laneOrder.map((laneId) => {
      const lane = run.lanes[laneId]!;
      return {
        laneId,
        runtimeState: lane.runtimeState,
        exitCode: lane.exitCode,
        verificationState: lane.verificationState,
        contractState: lane.contractState,
        rawReportOutcome: lane.rawReportOutcome,
        resultFile: lane.resultFile,
      };
    }),
  });
  const report = {
    mode: c.mode,
    runId: c.runId,
    issue: run.issue,
    fixedPoint: run.fixedPoint,
    bundleHash: run.inputBundle?.bundleHash ?? null,
    evidenceRoot: c.evidenceDir,
    runEvidenceDir: runEvidencePath(c.evidenceDir, c.runId),
    finishStatus: run.finishStatus,
    lanes: laneSummary(run),
    deliveries,
    failures: acceptance.failures,
    ok: acceptance.ok,
  };
  await Bun.write(
    runEvidencePath(c.evidenceDir, c.runId, "formal-result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  line(`FLOW_REVIEW_SMOKE_DONE=${report.ok ? 0 : 1}`);
  if (!report.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("__dispatch__")) {
    await dispatchPhase();
    return;
  }
  const mode = env("FLOW_REVIEW_MODE", "rehearsal");
  if (mode === "formal") {
    await formalRun();
    return;
  }
  await rehearsalParent();
}

main().catch((error) => {
  line(
    `FLOW_REVIEW_SMOKE_ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
});
