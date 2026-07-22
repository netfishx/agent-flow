// The visible-run tracer. Given a Herdr adapter, it lays out a dedicated tab,
// dispatches simulated lanes into their own panes, and exposes a small handle-
// based interface for status, focus, interrupt, and durable result inspection.
//
// Completion discipline (absorbed from the #3 smoke): a lane is done only when
// its run+lane-specific sentinel is observed AND its real exit code is read from
// the durable log AND process-info confirms the foreground group is back at the
// shell. `wait-output` matching is a liveness signal, never the exit code.

import type { PaneRef, TabRef } from "../herdr/types.ts";
import { buildLaneCommand } from "../smoke/lane.ts";
import {
  assertHandleId,
  laneSentinelRegex,
  laneSentinelToken,
  parseExitFromSentinel,
} from "./ids.ts";
import { measured, REASONS, tokensUnavailable, unavailable } from "./metrics.ts";
import type {
  InterruptOutcome,
  LanePhaseTiming,
  LaneResult,
  LaneState,
  LaneStatus,
  RunHandle,
  RunState,
  RuntimeDeps,
  StartWorkflowConfig,
  WorkflowMetrics,
  WorkflowStatus,
} from "./types.ts";

// Internal records. Exported for the smoke's controller-loss handoff seam only;
// NOT re-exported from index.ts, so they are not part of the public API.
export interface LaneRecord {
  readonly laneId: string;
  readonly pane: PaneRef;
  readonly logFile: string;
  readonly sentinelToken: string;
  readonly steps: number;
  readonly stepDelaySeconds: number;
  dispatchedAt: number | null;
  liveAt: number | null;
  completedAt: number | null;
  state: LaneState;
  exitCode: number | null;
  waitMatched: boolean;
  humanCoordinationMs: number | null;
}

export interface RunRecord {
  readonly runId: string;
  readonly config: StartWorkflowConfig;
  readonly tab: TabRef;
  readonly controllerPane: PaneRef;
  readonly startedAt: number;
  dispatchedAt: number | null;
  checkpointAnnouncedAt: number | null;
  readonly lanes: Map<string, LaneRecord>;
  readonly laneOrder: string[];
}

const TERMINAL: ReadonlySet<LaneState> = new Set([
  "complete",
  "interrupted",
  "failed",
]);

function classifyExit(exitCode: number): LaneState {
  if (exitCode === 0) return "complete";
  if (exitCode === 130) return "interrupted";
  return "failed";
}

/**
 * Raised when dispatch fails partway. The run is already registered, so the
 * lanes that did start remain inspectable and interruptible via `runId` — a
 * lane never runs without a handle to it.
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
  protected readonly runs = new Map<string, RunRecord>();

  constructor(private readonly deps: RuntimeDeps) {}

  // ── Public interface ──────────────────────────────────────────────────────

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
    const lanes = new Map<string, LaneRecord>();
    const laneOrder: string[] = [];
    let previous: PaneRef = controllerPane;
    for (const spec of config.lanes) {
      const pane = await this.deps.adapter.splitPane({
        from: previous,
        direction,
        cwd: config.cwd,
      });
      previous = pane;
      lanes.set(spec.laneId, {
        laneId: spec.laneId,
        pane,
        // The runId scopes the log path so a later or concurrent run with the
        // same cwd + laneId cannot truncate this run's durable result.
        logFile: `${config.cwd}/lane-${runId}-${spec.laneId}.log`,
        sentinelToken: laneSentinelToken(runId, spec.laneId),
        steps: spec.steps,
        stepDelaySeconds: spec.stepDelaySeconds ?? 0.2,
        dispatchedAt: null,
        liveAt: null,
        completedAt: null,
        state: "starting",
        exitCode: null,
        waitMatched: false,
        humanCoordinationMs: null,
      });
      laneOrder.push(spec.laneId);
    }

    // Register the run before dispatch so a partial-dispatch failure still
    // leaves every already-started lane inspectable and interruptible — a lane
    // must never run without a handle to it.
    const run: RunRecord = {
      runId,
      config,
      tab,
      controllerPane,
      startedAt,
      dispatchedAt: null,
      checkpointAnnouncedAt: null,
      lanes,
      laneOrder,
    };
    this.runs.set(runId, run);

    // Let each freshly split pane's shell reach its prompt before dispatch,
    // otherwise `pane run` lands before the shell is ready (the split→run race).
    await this.settle(config.startupSettleMs ?? 0);

    const started: string[] = [];
    for (const laneId of laneOrder) {
      const lane = lanes.get(laneId)!;
      const command = buildLaneCommand({
        runId,
        laneId,
        logFile: lane.logFile,
        steps: lane.steps,
        stepDelaySeconds: lane.stepDelaySeconds,
      });
      lane.dispatchedAt = this.deps.clock();
      try {
        await this.deps.adapter.runInPane(lane.pane, command);
      } catch (cause) {
        lane.state = "failed";
        // Lanes after the failure were never dispatched; give them a terminal
        // state so the whole run is inspectable — an idle, never-run pane is not
        // a completed process and must not be read as one.
        for (const id of laneOrder) {
          const other = lanes.get(id)!;
          if (other.state === "starting") other.state = "failed";
        }
        // The run stays registered with the lanes that did start, so the caller
        // can inspect and interrupt them via the runId carried on the error.
        throw new PartialDispatchError(runId, started, cause);
      }
      lane.state = "running";
      started.push(laneId);
    }
    run.dispatchedAt = this.deps.clock();
    return { runId, laneIds: [...laneOrder] };
  }

  async inspectWorkflow(runId: string): Promise<WorkflowStatus> {
    const run = this.getRun(runId);
    for (const laneId of run.laneOrder) {
      await this.refreshLane(run, run.lanes.get(laneId)!);
    }
    const lanes: LaneStatus[] = run.laneOrder.map((laneId) => {
      const lane = run.lanes.get(laneId)!;
      return {
        laneId,
        state: lane.state,
        exitCode: lane.exitCode,
        timing: this.laneTiming(lane),
      };
    });
    return {
      runId,
      state: this.runState(run),
      lanes,
      metrics: this.metrics(run),
    };
  }

  async focusLane(runId: string, laneId: string): Promise<void> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    await this.deps.adapter.focusPane(lane.pane, run.tab);
  }

  async interruptLane(
    runId: string,
    laneId: string,
  ): Promise<InterruptOutcome> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    const evidence = await this.deps.adapter.interruptPane(lane.pane);
    if (run.checkpointAnnouncedAt !== null && lane.humanCoordinationMs === null) {
      lane.humanCoordinationMs = this.deps.clock() - run.checkpointAnnouncedAt;
    }
    return {
      laneId,
      signal: evidence.signal,
      delivered: evidence.delivered,
    };
  }

  async inspectLaneResult(runId: string, laneId: string): Promise<LaneResult> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    // A never-dispatched lane (e.g. after a partial dispatch) has no durable
    // log; inspection must still return a result, not throw.
    const output = await this.readDurable(lane.logFile).catch(() => "");
    const parsedExit = parseExitFromSentinel(runId, laneId, output);
    const tail = output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-8);
    return {
      laneId,
      state: lane.state,
      exitCode: lane.exitCode ?? parsedExit,
      waitMatched: lane.waitMatched,
      sentinelToken: lane.sentinelToken,
      outputTail: tail,
    };
  }

  // ── Run-driving helpers (used by the smoke entry) ─────────────────────────

  /** Stamp the start of a human checkpoint, so interrupt latency is measurable. */
  markCheckpoint(runId: string): void {
    this.getRun(runId).checkpointAnnouncedAt = this.deps.clock();
  }

  /**
   * Block until the lane's sentinel appears (or timeout), then finalize its real
   * exit code from the durable log. Match success and exit code stay separate.
   */
  async awaitLane(
    runId: string,
    laneId: string,
    timeoutMs: number,
  ): Promise<LaneResult> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    if (TERMINAL.has(lane.state)) return this.inspectLaneResult(runId, laneId);

    const outcome = await this.deps.adapter.waitForOutput(
      lane.pane,
      laneSentinelRegex(runId, laneId),
      timeoutMs,
    );
    lane.waitMatched = outcome.matched;
    if (outcome.matched) {
      // A matched sentinel is a liveness signal, not proof the process exited:
      // the lane prints the sentinel immediately before exiting. Confirm via
      // process-info that the foreground group is back at the shell before
      // finalizing, so completion is never declared over a live process.
      const gone = await this.confirmProcessGone(lane.pane);
      if (!gone) {
        throw new Error(
          `lane "${laneId}" printed its sentinel but its process is still running`,
        );
      }
      await this.finalizeLane(run, lane);
    }
    return this.inspectLaneResult(runId, laneId);
  }

  /**
   * Poll process-info until the pane's foreground group returns to the shell.
   * Bounded by attempt count so it always terminates, even under a fake clock.
   */
  private async confirmProcessGone(pane: PaneRef): Promise<boolean> {
    const timeoutMs = this.deps.processGoneTimeoutMs ?? 2_000;
    const intervalMs = this.deps.processGoneIntervalMs ?? 100;
    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
    for (let i = 0; i < attempts; i++) {
      const info = await this.deps.adapter.processInfo(pane);
      if (info.foregroundProcessGroupId === info.shellPid) return true;
      if (i < attempts - 1) await this.settle(intervalMs);
    }
    return false;
  }

  /** Confirm a lane's process is live and record its startup latency. */
  async confirmLaneStarted(
    runId: string,
    laneId: string,
    pollTimeoutMs = 5_000,
    pollIntervalMs = 100,
  ): Promise<boolean> {
    const run = this.getRun(runId);
    const lane = this.getLane(run, laneId);
    const deadline = this.deps.clock() + pollTimeoutMs;
    for (;;) {
      const info = await this.deps.adapter.processInfo(lane.pane);
      if (info.foregroundProcessGroupId !== info.shellPid) {
        if (lane.liveAt === null) lane.liveAt = this.deps.clock();
        return true;
      }
      if (this.deps.clock() >= deadline) return false;
      await this.settle(pollIntervalMs);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Register a run record. Used by the smoke's controller-loss handoff. */
  protected registerRun(run: RunRecord): void {
    this.runs.set(run.runId, run);
  }

  /** Read a run record for internal handoff. */
  protected runRecord(runId: string): RunRecord {
    return this.getRun(runId);
  }

  private async refreshLane(run: RunRecord, lane: LaneRecord): Promise<void> {
    if (TERMINAL.has(lane.state)) return;
    // A lane that was never dispatched has no process on its pane; its idle
    // shell must not be mistaken for a completed process.
    if (lane.dispatchedAt === null) return;
    const info = await this.deps.adapter.processInfo(lane.pane);
    if (info.foregroundProcessGroupId === info.shellPid) {
      await this.finalizeLane(run, lane);
    } else {
      if (lane.liveAt === null) lane.liveAt = this.deps.clock();
      lane.state = "running";
    }
  }

  private async finalizeLane(run: RunRecord, lane: LaneRecord): Promise<void> {
    if (TERMINAL.has(lane.state)) return;
    const output = await this.readDurable(lane.logFile);
    const exit = parseExitFromSentinel(run.runId, lane.laneId, output);
    if (exit === null) {
      lane.state = "failed";
      throw new Error(
        `lane "${lane.laneId}" produced no sentinel ${lane.sentinelToken} in its durable log`,
      );
    }
    lane.completedAt = this.deps.clock();
    lane.exitCode = exit;
    lane.state = classifyExit(exit);
  }

  private async readDurable(path: string): Promise<string> {
    return this.deps.readResultFile(path);
  }

  private async settle(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.deps.sleep) await this.deps.sleep(ms);
  }

  private getRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown runId "${runId}"`);
    return run;
  }

  private getLane(run: RunRecord, laneId: string): LaneRecord {
    const lane = run.lanes.get(laneId);
    if (!lane) throw new Error(`unknown laneId "${laneId}" in run "${run.runId}"`);
    return lane;
  }

  private runState(run: RunRecord): RunState {
    const states = run.laneOrder.map((id) => run.lanes.get(id)!.state);
    if (states.every((s) => TERMINAL.has(s))) {
      return states.every((s) => s === "complete") ? "complete" : "partial";
    }
    return run.dispatchedAt === null ? "dispatched" : "running";
  }

  private laneTiming(lane: LaneRecord): LanePhaseTiming {
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
        lane.humanCoordinationMs !== null
          ? measured(lane.humanCoordinationMs)
          : unavailable(REASONS.noCheckpoint),
    };
  }

  private metrics(run: RunRecord): WorkflowMetrics {
    const perLane: Record<string, LanePhaseTiming> = {};
    for (const laneId of run.laneOrder) {
      perLane[laneId] = this.laneTiming(run.lanes.get(laneId)!);
    }
    return {
      startupLatency:
        run.dispatchedAt !== null
          ? measured(run.dispatchedAt - run.startedAt)
          : unavailable(REASONS.runNotDispatched),
      tokenUsage: tokensUnavailable(REASONS.simulatedNoTokens),
      perLane,
    };
  }
}
