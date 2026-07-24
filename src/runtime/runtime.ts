// The visible-run tracer. Runtime facts are committed to the injected Ledger
// and then folded into memory through the same reducer used by ledger replay.

import type { PaneRef } from "../herdr/types.ts";
import { buildLaneCommand } from "../smoke/lane.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  NewRunEvent,
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
import { measured, REASONS, tokensUnavailable, unavailable } from "./metrics.ts";
import {
  projectRunState,
  projectRunOutcomeBreakdown,
  reduce,
  type LaneView,
  type RunView,
} from "./reducer.ts";
import type {
  InterruptOutcome,
  LanePhaseTiming,
  LaneResult,
  LaneState,
  LaneStatus,
  RunHandle,
  RuntimeDeps,
  StartWorkflowConfig,
  WorkflowMetrics,
  WorkflowStatus,
} from "./types.ts";
import type { LeaseHandle } from "./ledger.ts";

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);
const CONDITIONAL_COMMIT_ATTEMPTS = 3;

interface LaneArtifactPaths {
  readonly logFile: string;
  readonly stderrFile: string;
  readonly checkpointFile: string;
  readonly resultFile: string;
  readonly evidenceFile: string;
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
    checkpointFile: join(runDirectory, "checkpoints", `${laneId}.md`),
    resultFile: join(runDirectory, "results", `${laneId}-result.txt`),
    evidenceFile: join(runDirectory, "evidence", `${laneId}-evidence.json`),
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
  private readonly driveSliceMs: number;

  constructor(protected readonly deps: RuntimeDeps) {
    const driveSliceMs = deps.driveSliceMs ?? 2_000;
    if (!Number.isFinite(driveSliceMs) || driveSliceMs <= 0) {
      throw new Error("driveSliceMs must be a positive finite number");
    }
    this.driveSliceMs = driveSliceMs;
  }

  async startWorkflow(config: StartWorkflowConfig): Promise<RunHandle> {
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

    const startedAt = this.deps.clock();
    const { tab, controllerPane } = await this.deps.adapter.createTab({
      workspace: config.workspace,
      cwd: config.cwd,
      label: config.workflow,
    });

    const direction = config.splitDirection ?? "down";
    const topology: Array<{
      spec: StartWorkflowConfig["lanes"][number];
      pane: PaneRef;
      logFile: string;
      sentinelToken: string;
      stepDelaySeconds: number;
      artifacts: LaneArtifactPaths;
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
      const item = {
        spec,
        pane,
        logFile: artifacts.logFile,
        sentinelToken: laneSentinelToken(runId, spec.laneId),
        stepDelaySeconds: spec.stepDelaySeconds ?? 0.2,
        artifacts,
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
        },
        },
        startedAt,
      );
    } catch (error) {
      await this.releaseControllerLease(runId);
      throw error;
    }
    try {
      for (const item of topology) {
        const { spec } = item;
        await this.commitEvent(runId, {
          type: "lane_registered",
          actor: "runtime",
          laneId: spec.laneId,
          data: {
            laneId: spec.laneId,
            paneId: item.pane.id,
            logFile: item.logFile,
            stderrFile: item.artifacts.stderrFile,
            sentinelToken: item.sentinelToken,
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

      await this.settle(config.startupSettleMs ?? 0);
      for (const item of topology) {
        dispatchPlan.push({
          item,
          command: (this.deps.laneCommandBuilder ?? buildLaneCommand)({
            runId,
            laneId: item.spec.laneId,
            logFile: item.logFile,
            stderrFile: item.artifacts.stderrFile,
            checkpointFile: item.artifacts.checkpointFile,
            resultFile: item.artifacts.resultFile,
            steps: item.spec.steps,
            stepDelaySeconds: item.stepDelaySeconds,
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
          for (const aborted of topology.slice(index + 1)) {
            await this.commitEvent(runId, {
              type: "lane_failed_to_start",
              actor: "runtime",
              laneId: aborted.spec.laneId,
              data: {
                rejection: "dispatch aborted after earlier lane failed",
                command: null,
              },
            });
          }
          await this.finishIfTerminal(runId);
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

    return { runId, laneIds: topology.map((item) => item.spec.laneId) };
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
        await this.refreshLane(runId, laneId);
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

  async resumeWorkflow(
    runId: string,
    perLaneTimeoutMs = 300_000,
  ): Promise<WorkflowStatus> {
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    if (loaded.finishStatus !== null) return this.workflowStatus(loaded);

    await this.acquireControllerLease(runId);
    try {
      const authoritative = await this.deps.ledger.load(runId);
      if (!authoritative) throw new Error(`run not found: "${runId}"`);
      if (authoritative.finishStatus !== null) {
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
        await this.releaseControllerLease(runId);
      }
      return this.workflowStatus(this.getRun(runId));
    } catch (error) {
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
        await this.finalizeLane(runId, laneId, true);
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
    _runId: string,
    _laneId: string,
  ): Promise<void> {}

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

  private async refreshLane(runId: string, laneId: string): Promise<void> {
    let lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
      if (
        (lane.contractEvaluatedAt === null || lane.verificationRecordedAt === null)
      ) {
        await this.recordTerminalFacts(runId, laneId, lane.exitCode);
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
        await this.recordTerminalFacts(runId, laneId, lane.exitCode);
      }
      return;
    }
    if (info.foregroundProcessGroupId === info.shellPid) {
      await this.finalizeLane(runId, laneId, false);
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
  ): Promise<void> {
    const lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) return;
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
      await this.recordTerminalFacts(runId, laneId, exitCode);
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
    await this.recordTerminalFacts(runId, laneId, exitCode);
  }

  private async recordTerminalFacts(
    runId: string,
    laneId: string,
    parsedExitCode: number | null,
  ): Promise<void> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    if (!TERMINAL_RUNTIME.has(lane.runtimeState)) return;
    const { checkpointFile, resultFile, evidenceFile } = laneArtifactPaths(
      run.cwd,
      runId,
      laneId,
    );

    let checkpoint: string | null = null;
    try {
      checkpoint = await readFile(checkpointFile, "utf8");
    } catch {
      // An absent/unreadable Agent record leaves the semantic dimension unknown.
    }
    const status = checkpoint?.match(/^STATUS:\s*(complete|partial)\s*$/m)?.[1];
    if (status === "complete" || status === "partial") {
      await this.commitEventConditionally(runId, (current) => {
        if (!current) throw new Error(`unknown runId "${runId}"`);
        const currentLane = this.getLane(current, laneId);
        if (currentLane.checkpointAt !== null) return null;
        return {
          type: "lane_checkpoint",
          actor: "agent",
          laneId,
          data: { semanticState: status, checkpointFile },
        };
      });
    }

    const contractErrors: string[] = [];
    if (lane.runtimeState === "failed_to_start") {
      contractErrors.push("lane never started");
    }
    if (parsedExitCode === null) contractErrors.push("completion sentinel missing");
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
          resultFile,
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
        },
      };
    });
    await this.releaseControllerLeaseIfFactsComplete(runId);
  }

  protected async writeRunnerEvidenceFile(
    path: string,
    evidence: RunnerEvidence,
  ): Promise<void> {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  private async finishIfTerminal(runId: string): Promise<void> {
    await this.commitEventConditionally(runId, (run) => {
      if (!run) throw new Error(`unknown runId "${runId}"`);
      if (run.finishStatus !== null || run.laneOrder.length === 0) return null;
      const lanes = run.laneOrder.map((laneId) => this.getLane(run, laneId));
      if (!lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))) {
        return null;
      }
      const breakdown = projectRunOutcomeBreakdown(run);
      const clean = breakdown.exitedZero === lanes.length;
      return {
        type: "run_finished",
        actor: "runtime",
        data: { status: clean ? "clean" : "degraded", breakdown },
      };
    });
  }

  private async releaseControllerLeaseIfFactsComplete(
    runId: string,
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
    if (factsComplete) await this.releaseControllerLease(runId);
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
      modelInference: unavailable(REASONS.simulatedNoModel),
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
    return {
      startupLatency:
        lastDispatchedAt === null
          ? unavailable(REASONS.runNotDispatched)
          : measured(lastDispatchedAt - run.startedAt),
      tokenUsage: tokensUnavailable(REASONS.simulatedNoTokens),
      perLane,
    };
  }
}
