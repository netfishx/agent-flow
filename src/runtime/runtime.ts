// The visible-run tracer. Runtime facts are committed to the injected Ledger
// and then folded into memory through the same reducer used by ledger replay.

import type { PaneRef } from "../herdr/types.ts";
import { dueMilestones } from "../issue/milestones.ts";
import {
  collectBlockedCheckpoint,
  reconcileIssueSync,
  type IssueSyncEvent,
} from "../issue/reconcile.ts";
import { buildLaneCommand } from "../smoke/lane.ts";
import { assembleBrief } from "../review/brief.ts";
import {
  assembleInputBundle,
  type AssembledInputBundle,
} from "../review/bundle.ts";
import { buildAgentLaneCommand } from "../review/commands.ts";
import {
  deriveAgentLaneFacts,
  type AgentLaneDerivation,
} from "../review/derive.ts";
import type {
  SessionIdentity,
  WorktreeVerification,
} from "../review/types.ts";
import {
  failedVerification,
  verificationPassed,
} from "../review/verification.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  IssueRef,
  NewRunEvent,
  OwnerDecision,
  RunEvent,
  RunnerEvidence,
  RuntimeState,
} from "./events.ts";
import {
  assertHandleId,
  laneSentinelRegex,
  laneSentinelToken,
  parseExitFromSentinel,
} from "./ids.ts";
import {
  laneCheckpointFile,
  parseCheckpoint,
} from "./checkpoint.ts";
import { reviewWorktreeCleanupEligibility } from "./lane-cleanup.ts";
import { measured, REASONS, tokensUnavailable, unavailable } from "./metrics.ts";
import {
  expectedFinishStatus,
  projectRunState,
  projectRunOutcomeBreakdown,
  reduce,
  runFinishEligibility,
  type LaneView,
  type RunView,
} from "./reducer.ts";
import type {
  AgentLaneSpec,
  InterruptOutcome,
  LanePhaseTiming,
  LaneResult,
  LaneSpec,
  LaneState,
  LaneStatus,
  RunHandle,
  RuntimeDeps,
  StartWorkflowConfig,
  WorkflowMetrics,
  WorkflowStatus,
} from "./types.ts";
import {
  ControllerLeaseHeldError,
  type LeaseHandle,
} from "./ledger.ts";

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);
const CONDITIONAL_COMMIT_ATTEMPTS = 3;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/;

interface LaneArtifactPaths {
  readonly logFile: string;
  readonly stderrFile: string;
  readonly checkpointFile: string;
  readonly resultFile: string;
  readonly evidenceFile: string;
  readonly rawReportFile: string;
  readonly promptFile: string;
  readonly worktreePath: string;
}

function isAgentSpec(spec: LaneSpec): spec is AgentLaneSpec {
  return spec.kind === "agent";
}

function assertIssueBinding(issue: IssueRef | null | undefined): void {
  if (issue === null || issue === undefined) return;
  if (
    !GITHUB_OWNER.test(issue.owner) ||
    !GITHUB_REPOSITORY.test(issue.repo) ||
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0
  ) {
    throw new Error("invalid issue binding");
  }
}

function hasOutstandingDeliveries(run: RunView): boolean {
  try {
    return dueMilestones(run).length > 0;
  } catch {
    // Planning cannot deliver anything while the pointer remains invalid.
    // The shared synchronization projection exposes the failure to operators.
    return false;
  }
}

function laneArtifactPaths(
  cwd: string,
  runId: string,
  laneId: string,
): LaneArtifactPaths {
  const runDirectory = join(cwd, runId);
  return {
    logFile: join(runDirectory, "logs", `${laneId}.log`),
    stderrFile: join(runDirectory, "logs", `${laneId}.stderr.log`),
    checkpointFile: laneCheckpointFile(cwd, runId, laneId),
    resultFile: join(runDirectory, "results", `${laneId}-result.txt`),
    evidenceFile: join(runDirectory, "evidence", `${laneId}-evidence.json`),
    rawReportFile: join(runDirectory, "reports", `${laneId}.raw`),
    promptFile: join(runDirectory, "briefs", `${laneId}.md`),
    worktreePath: join(runDirectory, "worktrees", laneId),
  };
}

function laneState(lane: LaneView): LaneState {
  switch (lane.runtimeState) {
    case "pending":
      return lane.dispatchedAt === null ? "starting" : "running";
    case "running":
      return "running";
    case "exited":
      if (lane.exitCode === 0) return "complete";
      // A real CLI catches SIGINT and exits with a status of its own — codex
      // exits 1 — so the interrupt fact comes from the ledger. Keying this off
      // exit code 130 projected a genuinely interrupted reviewer as `failed`.
      if (lane.humanInterruptAt !== null) return "interrupted";
      if (lane.exitCode === 130) return "interrupted";
      return "failed";
    case "crashed":
    case "lost":
    case "failed_to_start":
      return "failed";
  }
}

function rejectionMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function runnerTermination(lane: LaneView): Pick<
  RunnerEvidence,
  "termination" | "failure"
> {
  switch (lane.runtimeState) {
    case "exited":
      return { termination: "sentinel-exit", failure: null };
    case "crashed":
      return { termination: "crashed", failure: null };
    case "lost":
      return { termination: "lost", failure: lane.lostCause };
    case "failed_to_start":
      return {
        termination: "failed_to_start",
        failure: lane.startRejection,
      };
    case "pending":
    case "running":
      throw new Error(
        `runner evidence requires a terminal lane, got "${lane.runtimeState}"`,
      );
  }
}

class LaneTerminalAnomaly extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneTerminalAnomaly";
  }
}

/**
 * Raised after durable run creation when pre-dispatch registration or physical
 * dispatch fails. Any lanes that did start remain controllable via `runId`.
 */
export class PartialDispatchError extends Error {
  constructor(
    readonly runId: string,
    readonly startedLaneIds: readonly string[],
    override readonly cause: unknown,
  ) {
    super(
      `dispatch failed after ${startedLaneIds.length} lane(s) in run "${runId}"; started lanes remain controllable`,
    );
    this.name = "PartialDispatchError";
  }
}

export class WorkflowRuntime {
  protected readonly runs = new Map<string, RunView>();
  private readonly pendingTransitions = new Map<string, Promise<void>>();
  private readonly commitTails = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, LeaseHandle>();
  private readonly deferredLeaseReleases = new Set<string>();
  private readonly reconcileTails = new Map<string, Promise<void>>();
  private readonly driveSliceMs: number;

  constructor(protected readonly deps: RuntimeDeps) {
    const driveSliceMs = deps.driveSliceMs ?? 2_000;
    if (!Number.isFinite(driveSliceMs) || driveSliceMs <= 0) {
      throw new Error("driveSliceMs must be a positive finite number");
    }
    this.driveSliceMs = driveSliceMs;
  }

  async startWorkflow(config: StartWorkflowConfig): Promise<RunHandle> {
    assertIssueBinding(config.issue);
    if (config.issue && this.deps.issueTracker === undefined) {
      throw new Error("bound issue requires an issue tracker");
    }
    const runId = this.deps.idgen();
    assertHandleId("runId", runId);
    if (config.lanes.length === 0) {
      throw new Error("startWorkflow requires at least one lane");
    }
    const seen = new Set<string>();
    for (const lane of config.lanes) {
      assertHandleId("laneId", lane.laneId);
      if (seen.has(lane.laneId)) {
        throw new Error(`duplicate laneId "${lane.laneId}"`);
      }
      seen.add(lane.laneId);
    }

    const agentSpecs = config.lanes.filter(isAgentSpec);
    if (agentSpecs.length > 0) {
      if (config.fixedPoint === undefined || config.fixedPoint === null) {
        throw new Error("agent lanes require a captured fixed point");
      }
      // The first acceptance criterion is mechanical: the fixed point resolves
      // and the diff is non-empty BEFORE any reviewer starts. The git port
      // enforces it while capturing, but a caller may hand the runtime a
      // fabricated fixed point, so the boundary checks what it can prove.
      const fixed = config.fixedPoint;
      if (
        fixed.baseCommit.length === 0 ||
        fixed.headCommit.length === 0 ||
        fixed.diffHash.length === 0
      ) {
        throw new Error("a captured fixed point requires base, head, and diff hash");
      }
      if (fixed.baseCommit === fixed.headCommit) {
        throw new Error(
          "a fixed point whose base and head are the same commit has an empty diff",
        );
      }
      if (
        config.inputBundle === undefined ||
        config.inputBundle === null ||
        config.inputBundle.length === 0
      ) {
        throw new Error("agent lanes require a captured input bundle");
      }
      if (this.deps.reviewIsolation === undefined) {
        throw new Error("agent lanes require a review isolation port");
      }
      if (
        this.deps.sessionIdgen === undefined &&
        agentSpecs.some(
          (spec) => spec.agentKind === "claude" || spec.agentKind === "grok",
        )
      ) {
        throw new Error(
          "claude and grok lanes require a session id generator",
        );
      }
    }
    const bundle =
      agentSpecs.length > 0
        ? assembleInputBundle(config.inputBundle!)
        : null;

    const startedAt = this.deps.clock();
    const { tab, controllerPane } = await this.deps.adapter.createTab({
      workspace: config.workspace,
      cwd: config.cwd,
      label: config.workflow,
    });

    const direction = config.splitDirection ?? "down";
    interface AgentLanePlan {
      readonly spec: AgentLaneSpec;
      readonly preassignedSessionId: string | null;
      readonly brief: string;
    }
    const topology: Array<{
      spec: StartWorkflowConfig["lanes"][number];
      pane: PaneRef;
      logFile: string;
      sentinelToken: string;
      stepDelaySeconds: number;
      artifacts: LaneArtifactPaths;
      agent: AgentLanePlan | null;
      skipDispatch: boolean;
    }> = [];
    const dispatchPlan: Array<{
      item: (typeof topology)[number];
      command: string;
    }> = [];
    let previous = controllerPane;
    for (const spec of config.lanes) {
      const pane = await this.deps.adapter.splitPane({
        from: previous,
        direction,
        cwd: config.cwd,
      });
      previous = pane;
      const artifacts = laneArtifactPaths(config.cwd, runId, spec.laneId);
      const agent: AgentLanePlan | null = isAgentSpec(spec)
        ? {
            spec,
            preassignedSessionId:
              spec.agentKind === "claude" || spec.agentKind === "grok"
                ? this.deps.sessionIdgen!()
                : null,
            brief: assembleBrief({
              axis: spec.axis,
              agentKind: spec.agentKind,
              fixedPoint: config.fixedPoint!,
              bundle: bundle!,
              artifactRoot: join(config.cwd, runId),
            }),
          }
        : null;
      const item = {
        spec,
        pane,
        logFile: artifacts.logFile,
        sentinelToken: laneSentinelToken(runId, spec.laneId),
        stepDelaySeconds:
          isAgentSpec(spec) ? 0 : spec.stepDelaySeconds ?? 0.2,
        artifacts,
        agent,
        skipDispatch: false,
      };
      topology.push(item);
    }

    await this.acquireControllerLease(runId);
    try {
      await this.commitEvent(
        runId,
        {
          type: "run_started",
          actor: "runtime",
          data: {
            workflow: config.workflow,
            workspace: config.workspace,
            cwd: config.cwd,
            splitDirection: direction,
            tabId: tab.id,
            controllerPaneId: controllerPane.id,
            fixedPoint: config.fixedPoint ?? null,
            issue: config.issue ?? null,
          },
        },
        startedAt,
      );
    } catch (error) {
      await this.releaseControllerLease(runId);
      throw error;
    }
    try {
      if (bundle !== null) {
        await this.commitEvent(runId, {
          type: "input_bundle_captured",
          actor: "runtime",
          data: {
            files: bundle.manifest.files,
            bundleHash: bundle.manifest.bundleHash,
          },
        });
      }
      for (const item of topology) {
        const { spec } = item;
        const common = {
          laneId: spec.laneId,
          paneId: item.pane.id,
          logFile: item.logFile,
          stderrFile: item.artifacts.stderrFile,
          sentinelToken: item.sentinelToken,
        };
        await this.commitEvent(runId, {
          type: "lane_registered",
          actor: "runtime",
          laneId: spec.laneId,
          data: isAgentSpec(spec)
            ? {
                ...common,
                kind: "agent",
                axis: spec.axis,
                agentKind: spec.agentKind,
                model: spec.model,
                effort: spec.effort,
                promptFile: item.artifacts.promptFile,
                bundleHash: bundle!.manifest.bundleHash,
                rawReportFile: item.artifacts.rawReportFile,
                worktreePath: item.artifacts.worktreePath,
                preassignedSessionId: item.agent!.preassignedSessionId,
                role: `${spec.agentKind}:${spec.axis}`,
              }
            : {
                ...common,
                steps: spec.steps,
                stepDelaySeconds: item.stepDelaySeconds,
                ...(spec.role === undefined ? {} : { role: spec.role }),
              },
        });
      }
      for (const item of topology) {
        await mkdir(dirname(item.logFile), { recursive: true });
        await writeFile(item.logFile, "", "utf8");
        await writeFile(item.artifacts.stderrFile, "", "utf8");
      }
      if (bundle !== null) {
        await this.persistBundle(config.cwd, runId, bundle);
      }
      for (const item of topology) {
        if (item.agent === null) continue;
        await mkdir(dirname(item.artifacts.promptFile), { recursive: true });
        await writeFile(item.artifacts.promptFile, item.agent.brief, "utf8");
      }
      for (const item of topology) {
        if (item.agent === null) continue;
        const verification = await this.buildReviewWorktree(
          config.fixedPoint!,
          item.artifacts.worktreePath,
        );
        await this.commitEvent(runId, {
          type: "lane_isolation_verified",
          actor: "runner",
          laneId: item.spec.laneId,
          data: { phase: "pre", ...verification },
        });
        if (!verificationPassed(verification)) {
          await this.commitEvent(runId, {
            type: "lane_failed_to_start",
            actor: "runtime",
            laneId: item.spec.laneId,
            data: {
              rejection: `isolation pre-flight failed: ${verification.detail ?? "verification failed"}`,
              command: null,
            },
          });
          item.skipDispatch = true;
        }
      }

      await this.settle(config.startupSettleMs ?? 0);
      for (const item of topology) {
        if (item.skipDispatch) continue;
        dispatchPlan.push({
          item,
          command:
            item.agent === null
              ? (this.deps.laneCommandBuilder ?? buildLaneCommand)({
                  runId,
                  laneId: item.spec.laneId,
                  logFile: item.logFile,
                  stderrFile: item.artifacts.stderrFile,
                  checkpointFile: item.artifacts.checkpointFile,
                  resultFile: item.artifacts.resultFile,
                  steps: isAgentSpec(item.spec) ? 0 : item.spec.steps,
                  stepDelaySeconds: item.stepDelaySeconds,
                })
              : (this.deps.agentLaneCommandBuilder ?? buildAgentLaneCommand)({
                  runId,
                  laneId: item.spec.laneId,
                  agentKind: item.agent.spec.agentKind,
                  model: item.agent.spec.model,
                  effort: item.agent.spec.effort,
                  worktreePath: item.artifacts.worktreePath,
                  promptFile: item.artifacts.promptFile,
                  rawReportFile: item.artifacts.rawReportFile,
                  logFile: item.logFile,
                  stderrFile: item.artifacts.stderrFile,
                  sessionId: item.agent.preassignedSessionId,
                }),
        });
      }
    } catch (cause) {
      try {
        await this.releaseControllerLease(runId);
      } catch (releaseCause) {
        throw new PartialDispatchError(
          runId,
          [],
          new AggregateError(
            [cause, releaseCause],
            "pre-dispatch failure and controller lease release failure",
          ),
        );
      }
      throw new PartialDispatchError(runId, [], cause);
    }

    const started: string[] = [];
    for (let index = 0; index < dispatchPlan.length; index++) {
      const { item, command } = dispatchPlan[index]!;
      try {
        await this.commitEvent(runId, {
          type: "lane_dispatch_intent",
          actor: "runtime",
          laneId: item.spec.laneId,
          data: {},
        });
      } catch (cause) {
        throw new PartialDispatchError(runId, [...started], cause);
      }
      const dispatchedAt = this.deps.clock();
      try {
        await this.deps.adapter.runInPane(item.pane, command);
      } catch (cause) {
        try {
          await this.commitEvent(runId, {
            type: "lane_failed_to_start",
            actor: "runtime",
            laneId: item.spec.laneId,
            data: { rejection: rejectionMessage(cause), command },
          });
          for (const aborted of dispatchPlan.slice(index + 1)) {
            await this.commitEvent(runId, {
              type: "lane_failed_to_start",
              actor: "runtime",
              laneId: aborted.item.spec.laneId,
              data: {
                rejection: "dispatch aborted after earlier lane failed",
                command: null,
              },
            });
          }
          // The run may only finish once these lanes' terminal facts are in
          // the ledger. A physical dispatch failure keeps the controller
          // lease, so the release is deferred while the facts land.
          this.deferredLeaseReleases.add(runId);
          try {
            await this.recordFactsForTerminalLanes(runId);
          } finally {
            this.deferredLeaseReleases.delete(runId);
          }
        } catch (commitCause) {
          throw new PartialDispatchError(runId, [...started], commitCause);
        }
        throw new PartialDispatchError(runId, started, cause);
      }
      const physicallyStarted = [...started, item.spec.laneId];
      try {
        await this.commitEvent(
          runId,
          {
            type: "lane_dispatched",
            actor: "runtime",
            laneId: item.spec.laneId,
            data: { command },
          },
          dispatchedAt,
        );
      } catch (cause) {
        throw new PartialDispatchError(runId, physicallyStarted, cause);
      }
      started.push(item.spec.laneId);
    }

    // Every lane may already be terminal when isolation pre-flight refused
    // them all; record their facts so the run closes instead of staying
    // undrivable. Recording the last lane's facts is what finishes the run.
    const afterDispatch = this.getRun(runId);
    if (
      afterDispatch.laneOrder.every((laneId) =>
        TERMINAL_RUNTIME.has(this.getLane(afterDispatch, laneId).runtimeState),
      )
    ) {
      await this.recordFactsForTerminalLanes(runId);
    }

    await this.reconcileBoundIssue(runId);
    return { runId, laneIds: topology.map((item) => item.spec.laneId) };
  }

  private async persistBundle(
    cwd: string,
    runId: string,
    bundle: AssembledInputBundle,
  ): Promise<void> {
    const runDirectory = join(cwd, runId);
    for (const artifact of bundle.artifacts) {
      const target = join(runDirectory, artifact.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, artifact.numberedText, "utf8");
    }
    const manifestFile = join(runDirectory, "bundle", "manifest.json");
    await mkdir(dirname(manifestFile), { recursive: true });
    await writeFile(
      manifestFile,
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
      "utf8",
    );
  }

  private async buildReviewWorktree(
    fixedPoint: NonNullable<StartWorkflowConfig["fixedPoint"]>,
    worktreePath: string,
  ): Promise<WorktreeVerification> {
    const isolation = this.deps.reviewIsolation!;
    try {
      await isolation.createWorktree({
        repoRoot: fixedPoint.repoRoot,
        headCommit: fixedPoint.headCommit,
        path: worktreePath,
      });
      return await isolation.verifyWorktree({
        path: worktreePath,
        fixedPoint,
      });
    } catch (cause) {
      // A port failure proves nothing about the worktree — fail closed.
      return failedVerification(rejectionMessage(cause));
    }
  }

  /**
   * Post-flight isolation verification, committed BEFORE a lane's terminal
   * event so run_finished can fold isolation into the finish status. The
   * reducer fails closed: a ran-to-terminal agent lane without a passing
   * post-flight makes the run invalid.
   */
  private async recordPostFlightIsolation(
    runId: string,
    laneId: string,
  ): Promise<void> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    if (lane.kind !== "agent" || lane.isolationPost !== null) return;
    let verification: WorktreeVerification;
    const isolation = this.deps.reviewIsolation;
    if (
      isolation === undefined ||
      run.fixedPoint === null ||
      lane.worktreePath === null
    ) {
      verification = failedVerification(
        "review isolation port unavailable for post-flight",
      );
    } else {
      try {
        verification = await isolation.verifyWorktree({
          path: lane.worktreePath,
          fixedPoint: run.fixedPoint,
        });
      } catch (cause) {
        verification = failedVerification(rejectionMessage(cause));
      }
    }
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const currentLane = this.getLane(current, laneId);
      if (currentLane.isolationPost !== null) return null;
      return {
        type: "lane_isolation_verified",
        actor: "runner",
        laneId,
        data: { phase: "post", ...verification },
      };
    });
  }

  async inspectWorkflow(runId: string): Promise<WorkflowStatus> {
    await this.flushPending(runId);
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`unknown runId "${runId}"`);
    this.registerReducedView(loaded);
    await this.finishIfTerminal(runId);
    let run = this.getRun(runId);
    for (const laneId of run.laneOrder) {
      try {
        await this.refreshLane(runId, laneId, false);
      } catch (error) {
        if (!(error instanceof LaneTerminalAnomaly)) throw error;
      }
      run = this.getRun(runId);
    }
    await this.finishIfTerminal(runId);
    run = this.getRun(runId);
    return this.workflowStatus(run);
  }

  // Ownership flips intentionally commit lease-free so a human can take control
  // from a live managed controller. Use takeover -> controller loss -> resume;
  // concurrent controller commits may race ledger state (issue #20).
  async takeoverLane(
    runId: string,
    laneId: string,
  ): Promise<WorkflowStatus> {
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    this.registerReducedView(loaded);
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const lane = this.getLane(current, laneId);
      if (lane.controlMode === "human_owned") return null;
      return {
        type: "lane_takeover",
        actor: "human",
        laneId,
        data: {},
      };
    });
    return this.workflowStatus(this.getRun(runId));
  }

  async releaseLane(
    runId: string,
    laneId: string,
  ): Promise<WorkflowStatus> {
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    this.registerReducedView(loaded);
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const lane = this.getLane(current, laneId);
      if (lane.controlMode === "managed") return null;
      return {
        type: "lane_release",
        actor: "human",
        laneId,
        data: {},
      };
    });
    return this.workflowStatus(this.getRun(runId));
  }

  async recordOwnerDecision(
    runId: string,
    input: {
      readonly decision: OwnerDecision;
      readonly note: string;
      readonly resultingIssueState?: string | null;
    },
  ): Promise<WorkflowStatus> {
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    if (loaded.issue !== null && this.deps.issueTracker === undefined) {
      throw new Error("bound issue requires an issue tracker");
    }
    this.registerReducedView(loaded);
    await this.commitEvent(runId, {
      type: "owner_decision_recorded",
      actor: "human",
      data: {
        decision: input.decision,
        note: input.note,
        resultingIssueState: input.resultingIssueState ?? null,
      },
    });

    // An unfinished run is delivered by its controller's next drive boundary
    // or a later resume tail. An unbound run has no delivery path, so neither
    // case touches the controller lease here.
    if (
      this.getRun(runId).finishStatus === null ||
      this.getRun(runId).issue === null
    ) {
      return this.workflowStatus(this.getRun(runId));
    }

    const leaseAlreadyHeld = this.leases.has(runId);
    if (!leaseAlreadyHeld) {
      try {
        await this.acquireControllerLease(runId);
      } catch (error) {
        if (error instanceof ControllerLeaseHeldError) {
          return this.workflowStatus(this.getRun(runId));
        }
        throw error;
      }
    }
    try {
      await this.reconcileBoundIssue(runId);
    } finally {
      if (!leaseAlreadyHeld) await this.releaseControllerLease(runId);
    }
    return this.workflowStatus(this.getRun(runId));
  }

  async resumeWorkflow(
    runId: string,
    perLaneTimeoutMs = 300_000,
  ): Promise<WorkflowStatus> {
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    if (loaded.issue !== null && this.deps.issueTracker === undefined) {
      throw new Error("bound issue requires an issue tracker");
    }
    if (loaded.finishStatus !== null) {
      if (
        loaded.issue === null ||
        !hasOutstandingDeliveries(loaded)
      ) {
        return this.workflowStatus(loaded);
      }

      const leaseAlreadyHeld = this.leases.has(runId);
      if (!leaseAlreadyHeld) await this.acquireControllerLease(runId);
      try {
        const authoritative = await this.deps.ledger.load(runId);
        if (!authoritative) throw new Error(`run not found: "${runId}"`);
        if (
          authoritative.issue === null ||
          !hasOutstandingDeliveries(authoritative)
        ) {
          return this.workflowStatus(authoritative);
        }
        this.registerReducedView(authoritative);
        await this.commitEvent(runId, {
          type: "controller_attached",
          actor: "runtime",
          data: {
            controllerId: this.controllerId(),
            epoch: authoritative.controllerEpoch + 1,
            pid: process.pid,
          },
        });
        await this.reconcileBoundIssue(runId);
        return this.workflowStatus(this.getRun(runId));
      } finally {
        if (!leaseAlreadyHeld) await this.releaseControllerLease(runId);
      }
    }

    await this.acquireControllerLease(runId);
    this.deferredLeaseReleases.add(runId);
    try {
      const authoritative = await this.deps.ledger.load(runId);
      if (!authoritative) throw new Error(`run not found: "${runId}"`);
      if (authoritative.finishStatus !== null) {
        this.deferredLeaseReleases.delete(runId);
        await this.releaseControllerLease(runId);
        return this.workflowStatus(authoritative);
      }
      this.registerReducedView(authoritative);

      const epoch = authoritative.controllerEpoch + 1;
      await this.commitEvent(runId, {
        type: "controller_attached",
        actor: "runtime",
        data: {
          controllerId: this.controllerId(),
          epoch,
          pid: process.pid,
        },
      });

      const liveLaneIds: string[] = [];
      for (const laneId of authoritative.laneOrder) {
        const lane = this.getLane(this.getRun(runId), laneId);
        if (TERMINAL_RUNTIME.has(lane.runtimeState)) continue;
        const info = await this.deps.adapter.processInfo({ id: lane.paneId });
        if (info.foregroundProcessGroupId !== info.shellPid) {
          if (lane.runtimeState === "pending") {
            await this.commitEvent(runId, {
              type: "lane_live",
              actor: "runtime",
              laneId,
              data: {},
            });
          }
          if (!this.autoControlSuppressed(lane)) liveLaneIds.push(laneId);
          continue;
        }

        const output = await this.readDurable(lane.logFile);
        const exitCode = parseExitFromSentinel(runId, laneId, output);
        await this.recordPostFlightIsolation(runId, laneId);
        if (exitCode !== null) {
          await this.commitEvent(runId, {
            type: "lane_exited",
            actor: "runtime",
            laneId,
            data: {
              exitCode,
              ...(exitCode === 130 ? { signal: "SIGINT" } : {}),
            },
          });
        } else if (lane.liveAt !== null || output.length > 0) {
          await this.commitEvent(runId, {
            type: "lane_crashed",
            actor: "runtime",
            laneId,
            data: {},
          });
        } else {
          await this.commitEvent(runId, {
            type: "lane_lost",
            actor: "runtime",
            laneId,
            data: { cause: "dispatch-outcome-unknown" },
          });
        }
      }

      await this.finishIfTerminal(runId);
      for (const laneId of liveLaneIds) {
        try {
          await this.awaitLane(runId, laneId, perLaneTimeoutMs);
        } catch (error) {
          if (!(error instanceof LaneTerminalAnomaly)) throw error;
        }
      }
      await this.finishIfTerminal(runId);
      for (const laneId of this.getRun(runId).laneOrder) {
        const lane = this.getLane(this.getRun(runId), laneId);
        if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
          await this.recordTerminalFacts(runId, laneId, lane.exitCode);
        }
      }
      const completed = this.getRun(runId);
      await this.reconcileBoundIssue(runId);
      if (completed.finishStatus === null) {
        const nonTerminal = completed.laneOrder
          .map((laneId) => this.getLane(completed, laneId))
          .filter((lane) => !TERMINAL_RUNTIME.has(lane.runtimeState));
        const drivable = nonTerminal.filter(
          (lane) => !this.autoControlSuppressed(lane),
        );
        if (drivable.length > 0) {
          throw new Error(
            `resume did not reach run_finished; lanes did not terminate: ${drivable
              .map((lane) => lane.laneId)
              .join(", ")}`,
          );
        }
        // Every remaining non-terminal lane is human_owned: reconciled, never auto-driven.
        // The controller detaches; the human-owned lane keeps running in its pane.
      }
      this.deferredLeaseReleases.delete(runId);
      await this.releaseControllerLease(runId);
      return this.workflowStatus(this.getRun(runId));
    } catch (error) {
      this.deferredLeaseReleases.delete(runId);
      try {
        await this.releaseControllerLease(runId);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "resume failure and controller lease release failure",
        );
      }
      throw error;
    }
  }

  private workflowStatus(run: RunView): WorkflowStatus {
    const lanes: LaneStatus[] = run.laneOrder.map((laneId) => {
      const lane = this.getLane(run, laneId);
      return {
        laneId,
        state: laneState(lane),
        exitCode: lane.exitCode,
        timing: this.laneTiming(lane),
      };
    });
    return {
      runId: run.runId,
      state: projectRunState(run),
      lanes,
      metrics: this.metrics(run),
    };
  }

  async focusLane(runId: string, laneId: string): Promise<void> {
    await this.flushPending(runId);
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    await this.deps.adapter.focusPane({ id: lane.paneId }, { id: run.tabId });
  }

  async interruptLane(
    runId: string,
    laneId: string,
  ): Promise<InterruptOutcome> {
    await this.flushPending(runId);
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    const evidence = await this.deps.adapter.interruptPane({ id: lane.paneId });
    if (evidence.delivered) {
      await this.commitEvent(runId, {
        type: "human_interrupt",
        actor: "human",
        laneId,
        data: { laneId },
      });
    }
    return {
      laneId,
      signal: evidence.signal,
      delivered: evidence.delivered,
    };
  }

  async inspectLaneResult(runId: string, laneId: string): Promise<LaneResult> {
    await this.flushPending(runId);
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    const output =
      lane.dispatchedAt === null ? "" : await this.readDurable(lane.logFile);
    const parsedExit = parseExitFromSentinel(runId, laneId, output);
    const tail = output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-8);
    return {
      laneId,
      state: laneState(lane),
      exitCode: lane.exitCode ?? parsedExit,
      waitMatched: lane.waitMatched,
      timedOut: false,
      sentinelToken: lane.sentinelToken,
      outputTail: tail,
    };
  }

  /**
   * Stamp the start of a human checkpoint without changing the #4 void
   * signature. An asynchronous append rejection is retained and thrown by the
   * next async public operation before that operation performs side effects.
   */
  markCheckpoint(runId: string): void {
    this.getRun(runId);
    const at = this.deps.clock();
    const prior = this.pendingTransitions.get(runId) ?? Promise.resolve();
    const transition = prior.then(async () => {
      await this.commitEvent(
        runId,
        { type: "checkpoint_announced", actor: "runtime", data: {} },
        at,
      );
    });
    this.pendingTransitions.set(runId, transition);
    void transition.catch(() => {});
  }

  async awaitLane(
    runId: string,
    laneId: string,
    timeoutMs: number,
  ): Promise<LaneResult> {
    let remaining = timeoutMs;
    for (;;) {
      await this.reloadFromLedger(runId);
      let lane = this.getLane(this.getRun(runId), laneId);
      if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
        await this.finishIfTerminal(runId);
        await this.recordTerminalFacts(runId, laneId, lane.exitCode);
        return this.inspectLaneResult(runId, laneId);
      }
      if (this.autoControlSuppressed(lane)) {
        return this.inspectLaneResult(runId, laneId);
      }

      const slice = Math.min(remaining, this.driveSliceMs);
      if (slice <= 0) {
        const result = await this.inspectLaneResult(runId, laneId);
        return { ...result, timedOut: true };
      }

      await this.onDriveSliceBoundary(runId, laneId);
      const outcome = await this.deps.adapter.waitForOutput(
        { id: lane.paneId },
        laneSentinelRegex(runId, laneId),
        slice,
      );

      await this.reloadFromLedger(runId);
      lane = this.getLane(this.getRun(runId), laneId);
      if (outcome.matched) {
        const gone = await this.confirmProcessGone({ id: lane.paneId });
        await this.reloadFromLedger(runId);
        lane = this.getLane(this.getRun(runId), laneId);
        if (!gone) {
          if (this.autoControlSuppressed(lane)) {
            return this.inspectLaneResult(runId, laneId);
          }
          throw new Error(
            `lane "${laneId}" printed its sentinel but its process is still running`,
          );
        }
        await this.finalizeLane(runId, laneId, true, true);
        lane = this.getLane(this.getRun(runId), laneId);
        if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
          await this.recordTerminalFacts(runId, laneId, lane.exitCode);
          return this.inspectLaneResult(runId, laneId);
        }
      } else {
        await this.refreshLane(runId, laneId);
        await this.reloadFromLedger(runId);
        lane = this.getLane(this.getRun(runId), laneId);
      }

      if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
        await this.recordTerminalFacts(runId, laneId, lane.exitCode);
        return this.inspectLaneResult(runId, laneId);
      }
      if (this.autoControlSuppressed(lane)) {
        return this.inspectLaneResult(runId, laneId);
      }
      remaining -= slice;
    }
  }

  async confirmLaneStarted(
    runId: string,
    laneId: string,
    pollTimeoutMs = 5_000,
    pollIntervalMs = 100,
  ): Promise<boolean> {
    await this.flushPending(runId);
    const lane = this.getLane(this.getRun(runId), laneId);
    const deadline = this.deps.clock() + pollTimeoutMs;
    for (;;) {
      const info = await this.deps.adapter.processInfo({ id: lane.paneId });
      if (info.foregroundProcessGroupId !== info.shellPid) {
        await this.commitEventConditionally(runId, (current) => {
          if (!current) throw new Error(`unknown runId "${runId}"`);
          const currentLane = this.getLane(current, laneId);
          if (currentLane.runtimeState !== "pending") return null;
          return {
            type: "lane_live",
            actor: "runtime",
            laneId,
            data: {},
          };
        });
        return true;
      }
      if (this.deps.clock() >= deadline) return false;
      await this.settle(pollIntervalMs);
    }
  }

  protected runView(runId: string): RunView {
    return this.getRun(runId);
  }

  protected hasPendingTransition(runId: string): boolean {
    return this.pendingTransitions.has(runId) || this.commitTails.has(runId);
  }

  protected async onDriveSliceBoundary(
    runId: string,
    _laneId: string,
  ): Promise<void> {
    await this.reconcileBoundIssue(runId);
  }

  protected registerReducedView(view: RunView): void {
    this.runs.set(view.runId, view);
  }

  protected async acquireControllerLease(runId: string): Promise<void> {
    if (this.leases.has(runId)) return;
    const lease = await this.deps.ledger.acquireLease(runId, {
      controllerId: this.controllerId(),
      pid: process.pid,
    });
    this.leases.set(runId, lease);
  }

  private controllerId(): string {
    return `runtime-${process.pid}`;
  }

  private autoControlSuppressed(lane: LaneView): boolean {
    return lane.controlMode === "human_owned";
  }

  protected async releaseControllerLease(runId: string): Promise<void> {
    const lease = this.leases.get(runId);
    if (!lease) return;
    await lease.release();
    this.leases.delete(runId);
  }

  private commitEvent(
    runId: string,
    input: NewRunEvent,
    at = this.deps.clock(),
  ): Promise<RunView> {
    return this.commitEventConditionally(runId, () => input, at).then((next) => {
      if (!next) throw new Error("unconditional event commit was skipped");
      return next;
    });
  }

  // The controller lease makes one process the single writer, but a controller
  // drives several lanes at once, so its own boundaries can overlap. Two
  // overlapping passes would both query the marker before either created its
  // comment, and both would post. Passes are therefore queued per run: one run
  // never overtakes itself, and runs never wait on each other.
  private reconcileBoundIssue(runId: string): Promise<void> {
    if (this.deps.issueTracker === undefined) return Promise.resolve();
    const prior = this.reconcileTails.get(runId) ?? Promise.resolve();
    const pass = prior.then(() => this.reconcileBoundIssuePass(runId));
    const tail = pass.then(
      () => undefined,
      () => undefined,
    );
    this.reconcileTails.set(runId, tail);
    void tail.then(() => {
      if (this.reconcileTails.get(runId) === tail) {
        this.reconcileTails.delete(runId);
      }
    });
    return pass;
  }

  private async reconcileBoundIssuePass(runId: string): Promise<void> {
    const tracker = this.deps.issueTracker;
    // Re-read at execution time: a queued pass must not deliver under a lease
    // that was released while it waited.
    if (tracker === undefined || !this.leases.has(runId)) return;
    await reconcileIssueSync({
      loadRun: async () => {
        const loaded = await this.deps.ledger.load(runId);
        if (!loaded) throw new Error(`run not found: "${runId}"`);
        this.registerReducedView(loaded);
        return loaded;
      },
      appendEvent: async (event: IssueSyncEvent) => {
        await this.commitEvent(runId, {
          ...event,
          actor: "runtime",
        } as NewRunEvent);
      },
      commitLaneCheckpoint: async ({
        laneId,
        checkpoint,
        checkpointFile,
      }) => {
        const committed = await this.commitEventConditionally(
          runId,
          (current) => {
            if (!current) {
              throw new Error(`unknown runId "${runId}"`);
            }
            const event = collectBlockedCheckpoint(
              current,
              laneId,
              checkpoint,
              checkpointFile,
            );
            return event === null
              ? null
              : { ...event, actor: "agent" };
          },
        );
        return committed !== null;
      },
      readLaneCheckpoint: async (laneId: string) => {
        const run = this.getRun(runId);
        const { checkpointFile } = laneArtifactPaths(
          run.cwd,
          runId,
          laneId,
        );
        try {
          return {
            text: await readFile(checkpointFile, "utf8"),
            checkpointFile,
          };
        } catch {
          return null;
        }
      },
      tracker,
    });
  }

  private commitEventConditionally(
    runId: string,
    selectEvent: (current: RunView | undefined) => NewRunEvent | null,
    at = this.deps.clock(),
  ): Promise<RunView | null> {
    const prior = this.commitTails.get(runId) ?? Promise.resolve();
    const transition = prior.then(async () => {
      let current = this.runs.get(runId);
      for (
        let attempt = 0;
        attempt < CONDITIONAL_COMMIT_ATTEMPTS;
        attempt++
      ) {
        const input = selectEvent(current);
        if (input === null) return null;
        const sequence = (current?.lastAppliedSequence ?? 0) + 1;
        const event = {
          schemaVersion: 1,
          eventId: `${runId}#${sequence}`,
          runId,
          sequence,
          at,
          controllerEpoch: current?.controllerEpoch ?? 0,
          ...input,
        } as RunEvent;
        try {
          await this.deps.ledger.commit(event);
        } catch (error) {
          if (attempt === CONDITIONAL_COMMIT_ATTEMPTS - 1) throw error;
          // This transition is itself the run's commit tail. Reload directly:
          // reloadFromLedger would await this transition and deadlock.
          const authoritative = await this.deps.ledger.load(runId);
          if (!authoritative) throw error;
          const previousSequence = current?.lastAppliedSequence ?? 0;
          if (authoritative.lastAppliedSequence <= previousSequence) {
            throw error;
          }
          this.registerReducedView(authoritative);
          current = authoritative;
          continue;
        }
        const next = reduce(current, event);
        this.runs.set(runId, next);
        return next;
      }
      throw new Error("conditional commit retry bound exhausted");
    });
    const tail = transition.then(
      () => undefined,
      () => undefined,
    );
    this.commitTails.set(runId, tail);
    void tail.then(() => {
      if (this.commitTails.get(runId) === tail) this.commitTails.delete(runId);
    });
    return transition;
  }

  private async flushPending(runId: string): Promise<void> {
    const pending = this.pendingTransitions.get(runId);
    if (!pending) return;
    this.pendingTransitions.delete(runId);
    await pending;
  }

  private async reloadFromLedger(runId: string): Promise<void> {
    await this.flushPending(runId);
    const inFlight = this.commitTails.get(runId);
    if (inFlight) await inFlight;
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    this.registerReducedView(loaded);
  }

  private async confirmProcessGone(pane: PaneRef): Promise<boolean> {
    const timeoutMs = this.deps.processGoneTimeoutMs ?? 2_000;
    const intervalMs = this.deps.processGoneIntervalMs ?? 100;
    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
    for (let index = 0; index < attempts; index++) {
      const info = await this.deps.adapter.processInfo(pane);
      if (info.foregroundProcessGroupId === info.shellPid) return true;
      if (index < attempts - 1) await this.settle(intervalMs);
    }
    return false;
  }

  private async refreshLane(
    runId: string,
    laneId: string,
    synchronizeIssue = true,
  ): Promise<void> {
    let lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
      if (
        (lane.contractEvaluatedAt === null || lane.verificationRecordedAt === null)
      ) {
        await this.recordTerminalFacts(
          runId,
          laneId,
          lane.exitCode,
          synchronizeIssue,
        );
      }
      return;
    }
    if (lane.dispatchedAt === null) {
      return;
    }
    const info = await this.deps.adapter.processInfo({ id: lane.paneId });
    await this.reloadFromLedger(runId);
    lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
      if (
        (lane.contractEvaluatedAt === null || lane.verificationRecordedAt === null)
      ) {
        await this.recordTerminalFacts(
          runId,
          laneId,
          lane.exitCode,
          synchronizeIssue,
        );
      }
      return;
    }
    if (info.foregroundProcessGroupId === info.shellPid) {
      await this.finalizeLane(
        runId,
        laneId,
        false,
        synchronizeIssue,
      );
    } else {
      await this.commitEventConditionally(runId, (current) => {
        if (!current) throw new Error(`unknown runId "${runId}"`);
        const currentLane = this.getLane(current, laneId);
        if (currentLane.runtimeState !== "pending") return null;
        return {
          type: "lane_live",
          actor: "runtime",
          laneId,
          data: {},
        };
      });
    }
  }

  private async finalizeLane(
    runId: string,
    laneId: string,
    waitMatched: boolean,
    synchronizeIssue: boolean,
  ): Promise<void> {
    const lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) return;
    // Post-flight isolation must precede the terminal event (see the note on
    // recordPostFlightIsolation); the lane's process is already gone here.
    await this.recordPostFlightIsolation(runId, laneId);
    const output = await this.readDurable(lane.logFile);
    const exitCode = parseExitFromSentinel(runId, laneId, output);
    if (exitCode === null) {
      await this.commitEventConditionally(
        runId,
        (current): NewRunEvent | null => {
          if (!current) throw new Error(`unknown runId "${runId}"`);
          const currentLane = this.getLane(current, laneId);
          if (TERMINAL_RUNTIME.has(currentLane.runtimeState)) return null;
          if (currentLane.liveAt === null && output.length === 0) {
            return {
              type: "lane_lost",
              actor: "runtime",
              laneId,
              data: { cause: "dispatch-outcome-unknown" },
            };
          }
          return {
            type: "lane_crashed",
            actor: "runtime",
            laneId,
            data: {},
          };
        },
      );
      await this.finishIfTerminal(runId);
      await this.recordTerminalFacts(
        runId,
        laneId,
        exitCode,
        synchronizeIssue,
      );
      const finalizedLane = this.getLane(this.getRun(runId), laneId);
      if (
        finalizedLane.runtimeState === "lost" &&
        finalizedLane.lostCause === "dispatch-outcome-unknown"
      ) {
        throw new LaneTerminalAnomaly(
          `lane "${laneId}" was lost (dispatch-outcome-unknown): its process is gone without positive execution evidence or a sentinel`,
        );
      }
      throw new LaneTerminalAnomaly(
        `lane "${laneId}" produced no sentinel ${lane.sentinelToken} in its durable log`,
      );
    }
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const currentLane = this.getLane(current, laneId);
      if (TERMINAL_RUNTIME.has(currentLane.runtimeState)) return null;
      return {
        type: "lane_exited",
        actor: "runtime",
        laneId,
        data: {
          exitCode,
          ...(exitCode === 130 ? { signal: "SIGINT" } : {}),
          waitMatched,
        },
      };
    });
    await this.finishIfTerminal(runId);
    await this.recordTerminalFacts(
      runId,
      laneId,
      exitCode,
      synchronizeIssue,
    );
  }

  private async recordTerminalFacts(
    runId: string,
    laneId: string,
    parsedExitCode: number | null,
    synchronizeIssue = true,
  ): Promise<void> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    if (!TERMINAL_RUNTIME.has(lane.runtimeState)) return;
    const { checkpointFile, resultFile, evidenceFile } = laneArtifactPaths(
      run.cwd,
      runId,
      laneId,
    );

    // Agent lanes derive report, terminal record, contract, and session facts
    // from the lane's own captured bytes — copies, never rewrites of the raw
    // artifacts. A lane that never started has nothing to derive from.
    const derivation =
      lane.kind === "agent" && lane.runtimeState !== "failed_to_start"
        ? await this.deriveAgentLane(lane, parsedExitCode ?? lane.exitCode)
        : null;
    let resultArtifact: string | null = lane.kind === "agent" ? null : resultFile;
    if (derivation !== null) {
      if (derivation.reportText !== null) {
        await mkdir(dirname(resultFile), { recursive: true });
        await writeFile(resultFile, derivation.reportText, "utf8");
        resultArtifact = resultFile;
      }
      // Every terminal agent lane gets its record, whatever became of its bytes.
      await mkdir(dirname(checkpointFile), { recursive: true });
      await writeFile(checkpointFile, derivation.checkpointText, "utf8");
    }

    // An Agent-written checkpoint is the Agent's own claim and is recorded as
    // such; a record the runtime derived is committed under the runtime actor,
    // so the ledger never presents a derivation as the reviewer's voice.
    if (derivation !== null) {
      // A derived record is always committed, whatever the lane's terminal
      // state, and always under the runtime actor. Its semantic state may be
      // `unknown`: a crashed or lost lane left no evidence of progress, and
      // claiming otherwise would assert progress nobody observed.
      const semanticState = derivation.checkpointStatus;
      await this.commitEventConditionally(runId, (current) => {
        if (!current) throw new Error(`unknown runId "${runId}"`);
        const currentLane = this.getLane(current, laneId);
        if (currentLane.checkpointOrigin === "runtime") return null;
        return {
          type: "lane_checkpoint",
          actor: "runtime",
          laneId,
          data: { semanticState, checkpointFile },
        };
      });
    } else {
      let checkpoint: string | null = null;
      try {
        checkpoint = await readFile(checkpointFile, "utf8");
      } catch {
        // An absent/unreadable Agent record leaves the semantic state unknown.
      }
      const status =
        checkpoint === null ? null : parseCheckpoint(checkpoint).status;
      // Only a lane that writes its own checkpoint may be credited with one. An
      // agent lane never does, so reaching here for one (a lane that never
      // started, say) must not publish a file on disk as the Agent's claim.
      if (
        lane.kind !== "agent" &&
        (status === "complete" || status === "partial")
      ) {
        const semanticState = status;
        await this.commitEventConditionally(runId, (current) => {
          if (!current) throw new Error(`unknown runId "${runId}"`);
          const currentLane = this.getLane(current, laneId);
          if (
            currentLane.semanticState === "complete" ||
            currentLane.semanticState === "partial"
          ) {
            return null;
          }
          return {
            type: "lane_checkpoint",
            actor: "agent",
            laneId,
            data: { semanticState, checkpointFile },
          };
        });
      }
    }

    const contractErrors: string[] = [];
    if (lane.runtimeState === "failed_to_start") {
      contractErrors.push("lane never started");
    }
    if (parsedExitCode === null) contractErrors.push("completion sentinel missing");
    if (lane.kind === "agent") {
      if (derivation !== null) contractErrors.push(...derivation.contractErrors);
    } else {
      let result = "";
      try {
        result = await readFile(resultFile, "utf8");
      } catch (error) {
        contractErrors.push(`result file unavailable: ${rejectionMessage(error)}`);
      }
      if (result.length > 0 && !/^RESULT: (?:ok|interrupted) steps=\d+\s*$/.test(result)) {
        contractErrors.push("result file is malformed");
      } else if (result.length === 0 && !contractErrors.some((error) => error.startsWith("result file unavailable"))) {
        contractErrors.push("result file is empty");
      }
    }

    if (lane.kind === "agent") {
      const session: SessionIdentity =
        lane.runtimeState === "failed_to_start"
          ? { kind: "unavailable", reason: "lane never started" }
          : derivation!.session;
      await this.commitEventConditionally(runId, (current) => {
        if (!current) throw new Error(`unknown runId "${runId}"`);
        const currentLane = this.getLane(current, laneId);
        if (currentLane.sessionIdentity !== null) return null;
        return {
          type: "lane_session_recorded",
          actor: "runner",
          laneId,
          data: { session },
        };
      });
    }
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const currentLane = this.getLane(current, laneId);
      if (currentLane.contractEvaluatedAt !== null) return null;
      return {
        type: "lane_contract_evaluated",
        actor: "validator",
        laneId,
        data: {
          contractState: contractErrors.length === 0 ? "satisfied" : "violated",
          // Never point at a result artifact that was never written; a lost
          // report must project as absent, not as a path to nothing.
          resultFile: resultArtifact,
          errors: contractErrors,
        },
      };
    });

    const terminalLane = this.getLane(this.getRun(runId), laneId);
    const termination = runnerTermination(terminalLane);
    const reportedEnvironmentFailure =
      (await this.deps.runnerEnvironmentFailure?.(runId, laneId)) ?? null;
    const environmentFailure =
      reportedEnvironmentFailure ??
      (terminalLane.runtimeState === "failed_to_start"
        ? terminalLane.startRejection
        : null);
    const evidence: RunnerEvidence = {
      schemaVersion: 1,
      runId,
      laneId,
      command: terminalLane.dispatchedCommand,
      stdoutArtifact: terminalLane.logFile,
      stderrArtifact: terminalLane.stderrFile,
      dispatchedAt: terminalLane.dispatchedAt,
      liveAt: terminalLane.liveAt,
      completedAt: terminalLane.completedAt,
      exitCode: parsedExitCode,
      signal: terminalLane.signal,
      environmentFailure,
      executionTimeout: null,
      rawReportArtifact: lane.kind === "agent" ? lane.rawReportFile : null,
      tokens: derivation?.tokens ?? null,
      ...termination,
    };
    await mkdir(dirname(evidenceFile), { recursive: true });
    await this.writeRunnerEvidenceFile(evidenceFile, evidence);
    const evidenceComplete =
      evidence.command !== null &&
      evidence.command.length > 0 &&
      evidence.stdoutArtifact.length > 0 &&
      evidence.stderrArtifact.length > 0 &&
      evidence.dispatchedAt !== null &&
      evidence.liveAt !== null &&
      evidence.completedAt !== null &&
      evidence.exitCode !== null &&
      evidence.termination === "sentinel-exit" &&
      evidence.environmentFailure === null;
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const currentLane = this.getLane(current, laneId);
      if (currentLane.verificationRecordedAt !== null) return null;
      return {
        type: "lane_verification_recorded",
        actor: "runner",
        laneId,
        data: {
          verificationState: evidenceComplete ? "verified" : "failed",
          evidenceFile,
          rawReportOutcome: derivation?.rawOutcome ?? null,
        },
      };
    });
    await this.disposeReviewWorktree(runId, laneId);
    // Only now that every per-lane terminal fact is committed may the run
    // finish: the finish status is computed over the facts, never ahead of them.
    await this.finishIfTerminal(runId);
    await this.synchronizeIssueAndReleaseControllerLeaseAfterTerminalFacts(
      runId,
      synchronizeIssue,
    );
  }

  /**
   * Release a lane's review worktree, or keep it and say why. Destroying the
   * worktree is the one irreversible step of finalization, so it happens only
   * when the lane's recorded facts prove every artifact derived from it is
   * safely on disk. The disposition itself is a ledger fact, so resume and
   * inspect can see that a forensic worktree is being held.
   */
  private async disposeReviewWorktree(
    runId: string,
    laneId: string,
  ): Promise<void> {
    const lane = this.getLane(this.getRun(runId), laneId);
    if (lane.kind !== "agent" || lane.worktreeDisposition !== null) return;
    const worktreePath = lane.worktreePath;
    if (worktreePath === null) return;
    const eligibility = reviewWorktreeCleanupEligibility(lane);
    const fixedPoint = this.getRun(runId).fixedPoint;
    let disposition: "removed" | "retained" = "retained";
    let retainedReason: string | null = eligibility.eligible
      ? null
      : eligibility.reason;
    if (eligibility.eligible) {
      if (this.deps.reviewIsolation === undefined || fixedPoint === null) {
        retainedReason = "no review isolation port was available to release it";
      } else {
        try {
          await this.deps.reviewIsolation.removeWorktree({
            repoRoot: fixedPoint.repoRoot,
            path: worktreePath,
          });
          disposition = "removed";
          retainedReason = null;
        } catch (cause) {
          // Retention is the safe failure direction, and it is recorded.
          retainedReason = `removal failed: ${rejectionMessage(cause)}`;
        }
      }
    }
    await this.commitEventConditionally(runId, (current) => {
      if (!current) throw new Error(`unknown runId "${runId}"`);
      const currentLane = this.getLane(current, laneId);
      if (currentLane.worktreeDisposition !== null) return null;
      return {
        type: "lane_worktree_disposition",
        actor: "runner",
        laneId,
        data: { disposition, retainedReason, worktreePath },
      };
    });
  }

  private async deriveAgentLane(
    lane: LaneView,
    exitCode: number | null,
  ): Promise<AgentLaneDerivation> {
    const rawPath = lane.rawReportFile!;
    let raw: string | null = null;
    try {
      raw = await readFile(rawPath, "utf8");
    } catch {
      raw = null;
    }
    let stderrText: string | null = null;
    try {
      stderrText = await readFile(lane.stderrFile, "utf8");
    } catch {
      stderrText = null;
    }
    return deriveAgentLaneFacts({
      agentKind: lane.agentKind!,
      raw,
      rawPath,
      stderr: stderrText,
      preassignedSessionId: lane.preassignedSessionId,
      exitCode,
      // The terminal state and the interrupt fact come from the ledger, so a
      // CLI that catches SIGINT and exits with its own code is still recorded
      // as interrupted instead of being guessed at from the exit code.
      termination: lane.runtimeState === "crashed" ? "crashed" : lane.runtimeState === "lost" ? "lost" : "exited",
      interrupted: lane.humanInterruptAt !== null,
      terminationDetail: lane.lostCause,
    });
  }

  protected async writeRunnerEvidenceFile(
    path: string,
    evidence: RunnerEvidence,
  ): Promise<void> {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  /**
   * Record terminal facts for every lane that has already reached a terminal
   * state. Recording the last such lane's facts is what lets the run finish,
   * so this is the only way a run closes.
   */
  private async recordFactsForTerminalLanes(runId: string): Promise<void> {
    for (const laneId of this.getRun(runId).laneOrder) {
      const lane = this.getLane(this.getRun(runId), laneId);
      if (!TERMINAL_RUNTIME.has(lane.runtimeState)) continue;
      await this.recordTerminalFacts(runId, laneId, lane.exitCode);
    }
  }

  private async finishIfTerminal(runId: string): Promise<void> {
    await this.commitEventConditionally(runId, (run) => {
      if (!run) throw new Error(`unknown runId "${runId}"`);
      if (run.finishStatus !== null) return null;
      // This is the live submission guard, and the only place the ordering is
      // enforced: a run may only finish once every lane's terminal facts are
      // already committed. Replay deliberately does not enforce it — a reducer
      // that rejected an out-of-order `run_finished` would make every pre-#7
      // ledger unloadable, so those keep legacy status validation instead.
      if (!runFinishEligibility(run).ready) return null;
      const breakdown = projectRunOutcomeBreakdown(run);
      return {
        type: "run_finished",
        actor: "runtime",
        data: { status: expectedFinishStatus(run), breakdown },
      };
    });
  }

  private async synchronizeIssueAndReleaseControllerLeaseAfterTerminalFacts(
    runId: string,
    synchronizeIssue: boolean,
  ): Promise<void> {
    const run = this.getRun(runId);
    if (run.finishStatus === null) return;
    const factsComplete = run.laneOrder.every((laneId) => {
      const lane = this.getLane(run, laneId);
      return (
        lane.contractEvaluatedAt !== null &&
        lane.verificationRecordedAt !== null
      );
    });
    if (factsComplete) {
      if (this.deferredLeaseReleases.has(runId)) return;
      if (synchronizeIssue) await this.reconcileBoundIssue(runId);
      await this.releaseControllerLease(runId);
    }
  }

  private async readDurable(path: string): Promise<string> {
    return this.deps.readResultFile(path);
  }

  private async settle(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.deps.sleep) await this.deps.sleep(ms);
  }

  private getRun(runId: string): RunView {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown runId "${runId}"`);
    return run;
  }

  private getLane(run: RunView, laneId: string): LaneView {
    const lane = run.lanes[laneId];
    if (!lane) throw new Error(`unknown laneId "${laneId}" in run "${run.runId}"`);
    return lane;
  }

  private laneTiming(lane: LaneView): LanePhaseTiming {
    return {
      processStartup:
        lane.liveAt !== null && lane.dispatchedAt !== null
          ? measured(lane.liveAt - lane.dispatchedAt)
          : unavailable(REASONS.laneNotStarted),
      modelInference: unavailable(
        lane.kind === "agent"
          ? REASONS.headlessNoInferenceSplit
          : REASONS.simulatedNoModel,
      ),
      executionWait:
        lane.completedAt !== null && lane.liveAt !== null
          ? measured(lane.completedAt - lane.liveAt)
          : unavailable(REASONS.laneNotComplete),
      humanCoordination:
        lane.humanCoordinationMs === null
          ? unavailable(REASONS.noCheckpoint)
          : measured(lane.humanCoordinationMs),
    };
  }

  private metrics(run: RunView): WorkflowMetrics {
    const perLane: Record<string, LanePhaseTiming> = {};
    for (const laneId of run.laneOrder) {
      perLane[laneId] = this.laneTiming(this.getLane(run, laneId));
    }
    const dispatched = run.laneOrder
      .map((laneId) => this.getLane(run, laneId).dispatchedAt)
      .filter((at): at is number => at !== null);
    const lastDispatchedAt =
      dispatched.length === 0 ? null : Math.max(...dispatched);
    const hasAgentLane = run.laneOrder.some(
      (laneId) => this.getLane(run, laneId).kind === "agent",
    );
    return {
      startupLatency:
        lastDispatchedAt === null
          ? unavailable(REASONS.runNotDispatched)
          : measured(lastDispatchedAt - run.startedAt),
      tokenUsage: tokensUnavailable(
        hasAgentLane ? REASONS.agentTokensInEvidence : REASONS.simulatedNoTokens,
      ),
      perLane,
    };
  }
}
