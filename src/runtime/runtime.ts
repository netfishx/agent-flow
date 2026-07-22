// The visible-run tracer. Given a Herdr adapter, it lays out a dedicated tab,
// dispatches simulated lanes into their own panes, and exposes a small handle-
// based interface for status, focus, interrupt, and durable result inspection.
//
// Completion discipline (absorbed from the #3 smoke): a lane is done only when
// its run+lane-specific sentinel is observed AND its real exit code is read from
// the durable log AND process-info confirms the foreground group is back at the
// shell. `wait-output` matching is a liveness signal, never the exit code.

import type { PaneRef, TabRef } from "../herdr/types.ts";
import { buildControllerMarkerCommand, buildLaneCommand } from "../smoke/lane.ts";
import {
  assertHandleId,
  controllerSentinelRegex,
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

interface LaneRecord {
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

interface RunRecord {
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

export class WorkflowRuntime {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly deps: RuntimeDeps) {}

  // ── Public interface ──────────────────────────────────────────────────────

  async startWorkflow(config: StartWorkflowConfig): Promise<RunHandle> {
    const runId = this.deps.idgen();
    assertHandleId("runId", runId);
    for (const lane of config.lanes) assertHandleId("laneId", lane.laneId);
    if (config.lanes.length === 0) {
      throw new Error("startWorkflow requires at least one lane");
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
      const record: LaneRecord = {
        laneId: spec.laneId,
        pane,
        logFile: `${config.cwd}/lane-${spec.laneId}.log`,
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
      };
      lanes.set(spec.laneId, record);
      laneOrder.push(spec.laneId);
    }

    // Let each freshly split pane's shell reach its prompt before dispatch,
    // otherwise `pane run` lands before the shell is ready (the split→run race).
    await this.settle(config.startupSettleMs ?? 0);

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
      await this.deps.adapter.runInPane(lane.pane, command);
      lane.state = "running";
    }
    const dispatchedAt = this.deps.clock();

    const run: RunRecord = {
      runId,
      config,
      tab,
      controllerPane,
      startedAt,
      dispatchedAt,
      checkpointAnnouncedAt: null,
      lanes,
      laneOrder,
    };
    this.runs.set(runId, run);
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
    const output = await this.readDurable(lane.logFile);
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
    if (outcome.matched) await this.finalizeLane(run, lane);
    return this.inspectLaneResult(runId, laneId);
  }

  /**
   * Wait for the controller marker to finish, evidence that the launcher left.
   * Returns process facts proving the lanes are not the launcher's children.
   */
  async runControllerMarker(
    runId: string,
    timeoutMs: number,
  ): Promise<{ controllerBackAtShell: boolean; markerMatched: boolean }> {
    const run = this.getRun(runId);
    await this.deps.adapter.runInPane(
      run.controllerPane,
      buildControllerMarkerCommand(runId),
    );
    const outcome = await this.deps.adapter.waitForOutput(
      run.controllerPane,
      controllerSentinelRegex(runId),
      timeoutMs,
    );
    const info = await this.deps.adapter.processInfo(run.controllerPane);
    return {
      markerMatched: outcome.matched,
      controllerBackAtShell:
        info.foregroundProcessGroupId === info.shellPid,
    };
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

  private async refreshLane(run: RunRecord, lane: LaneRecord): Promise<void> {
    if (TERMINAL.has(lane.state)) return;
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
