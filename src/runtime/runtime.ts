// The visible-run tracer. Runtime facts are committed to the injected Ledger
// and then folded into memory through the same reducer used by ledger replay.

import type { PaneRef } from "../herdr/types.ts";
import { buildLaneCommand } from "../smoke/lane.ts";
import type {
  NewRunEvent,
  RunEvent,
  RunOutcomeBreakdown,
  RuntimeState,
} from "./events.ts";
import {
  assertHandleId,
  laneSentinelRegex,
  laneSentinelToken,
  parseExitFromSentinel,
} from "./ids.ts";
import { measured, REASONS, tokensUnavailable, unavailable } from "./metrics.ts";
import { reduce, type LaneView, type RunView } from "./reducer.ts";
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

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);

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

/**
 * Raised when dispatch fails partway. The run is already registered, so the
 * lanes that did start remain inspectable and interruptible via `runId`.
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

  constructor(protected readonly deps: RuntimeDeps) {}

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
    }> = [];
    let previous = controllerPane;
    for (const spec of config.lanes) {
      const pane = await this.deps.adapter.splitPane({
        from: previous,
        direction,
        cwd: config.cwd,
      });
      previous = pane;
      const item = {
        spec,
        pane,
        logFile: `${config.cwd}/lane-${runId}-${spec.laneId}.log`,
        sentinelToken: laneSentinelToken(runId, spec.laneId),
        stepDelaySeconds: spec.stepDelaySeconds ?? 0.2,
      };
      topology.push(item);
    }

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
        },
      },
      startedAt,
    );
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
          sentinelToken: item.sentinelToken,
          steps: spec.steps,
          stepDelaySeconds: item.stepDelaySeconds,
          ...(spec.role === undefined ? {} : { role: spec.role }),
        },
      });
    }

    await this.settle(config.startupSettleMs ?? 0);

    const started: string[] = [];
    for (let index = 0; index < topology.length; index++) {
      const item = topology[index]!;
      const command = buildLaneCommand({
        runId,
        laneId: item.spec.laneId,
        logFile: item.logFile,
        steps: item.spec.steps,
        stepDelaySeconds: item.stepDelaySeconds,
      });
      const dispatchedAt = this.deps.clock();
      try {
        await this.deps.adapter.runInPane(item.pane, command);
      } catch (cause) {
        await this.commitEvent(runId, {
          type: "lane_failed_to_start",
          actor: "runtime",
          laneId: item.spec.laneId,
          data: { rejection: rejectionMessage(cause) },
        });
        for (const aborted of topology.slice(index + 1)) {
          await this.commitEvent(runId, {
            type: "lane_failed_to_start",
            actor: "runtime",
            laneId: aborted.spec.laneId,
            data: {
              rejection: "dispatch aborted after earlier lane failed",
            },
          });
        }
        await this.finishIfTerminal(runId);
        throw new PartialDispatchError(runId, started, cause);
      }
      await this.commitEvent(
        runId,
        {
          type: "lane_dispatched",
          actor: "runtime",
          laneId: item.spec.laneId,
          data: {},
        },
        dispatchedAt,
      );
      started.push(item.spec.laneId);
    }

    return { runId, laneIds: topology.map((item) => item.spec.laneId) };
  }

  async inspectWorkflow(runId: string): Promise<WorkflowStatus> {
    await this.flushPending(runId);
    let run = this.getRun(runId);
    for (const laneId of run.laneOrder) {
      await this.refreshLane(runId, laneId);
      run = this.getRun(runId);
    }
    await this.finishIfTerminal(runId);
    run = this.getRun(runId);
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
      runId,
      state: this.runState(run),
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
    await this.flushPending(runId);
    let lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
      return this.inspectLaneResult(runId, laneId);
    }

    const outcome = await this.deps.adapter.waitForOutput(
      { id: lane.paneId },
      laneSentinelRegex(runId, laneId),
      timeoutMs,
    );
    if (outcome.matched) {
      const gone = await this.confirmProcessGone({ id: lane.paneId });
      if (!gone) {
        throw new Error(
          `lane "${laneId}" printed its sentinel but its process is still running`,
        );
      }
      await this.finalizeLane(runId, laneId, outcome.matched);
      lane = this.getLane(this.getRun(runId), laneId);
    }
    return this.inspectLaneResult(runId, laneId);
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
        const current = this.getLane(this.getRun(runId), laneId);
        if (current.runtimeState !== "running") {
          await this.commitEvent(runId, {
            type: "lane_live",
            actor: "runtime",
            laneId,
            data: {},
          });
        }
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

  protected registerReducedView(view: RunView): void {
    this.runs.set(view.runId, view);
  }

  private commitEvent(
    runId: string,
    input: NewRunEvent,
    at = this.deps.clock(),
  ): Promise<RunView> {
    const prior = this.commitTails.get(runId) ?? Promise.resolve();
    const transition = prior.then(async () => {
      const current = this.runs.get(runId);
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
      await this.deps.ledger.commit(event);
      const next = reduce(current, event);
      this.runs.set(runId, next);
      return next;
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
    const lane = this.getLane(this.getRun(runId), laneId);
    if (TERMINAL_RUNTIME.has(lane.runtimeState) || lane.dispatchedAt === null) {
      return;
    }
    const info = await this.deps.adapter.processInfo({ id: lane.paneId });
    if (info.foregroundProcessGroupId === info.shellPid) {
      await this.finalizeLane(runId, laneId, false);
    } else if (lane.runtimeState !== "running") {
      await this.commitEvent(runId, {
        type: "lane_live",
        actor: "runtime",
        laneId,
        data: {},
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
      await this.commitEvent(runId, {
        type: "lane_crashed",
        actor: "runtime",
        laneId,
        data: {},
      });
      await this.finishIfTerminal(runId);
      throw new Error(
        `lane "${laneId}" produced no sentinel ${lane.sentinelToken} in its durable log`,
      );
    }
    await this.commitEvent(runId, {
      type: "lane_exited",
      actor: "runtime",
      laneId,
      data: {
        exitCode,
        ...(exitCode === 130 ? { signal: "SIGINT" } : {}),
        waitMatched,
      },
    });
    await this.finishIfTerminal(runId);
  }

  private async finishIfTerminal(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (run.finishStatus !== null || run.laneOrder.length === 0) return;
    const lanes = run.laneOrder.map((laneId) => this.getLane(run, laneId));
    if (!lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))) return;
    const breakdown: RunOutcomeBreakdown = {
      exitedZero: lanes.filter(
        (lane) => lane.runtimeState === "exited" && lane.exitCode === 0,
      ).length,
      exitedNonZero: lanes.filter(
        (lane) => lane.runtimeState === "exited" && lane.exitCode !== 0,
      ).length,
      crashed: lanes.filter((lane) => lane.runtimeState === "crashed").length,
      lost: lanes.filter((lane) => lane.runtimeState === "lost").length,
      failedToStart: lanes.filter(
        (lane) => lane.runtimeState === "failed_to_start",
      ).length,
    };
    const clean = breakdown.exitedZero === lanes.length;
    await this.commitEvent(runId, {
      type: "run_finished",
      actor: "runtime",
      data: { status: clean ? "clean" : "degraded", breakdown },
    });
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

  private runState(run: RunView): RunState {
    const states = run.laneOrder.map((laneId) =>
      laneState(this.getLane(run, laneId)),
    );
    if (states.some((state) => state === "running")) return "running";
    if (states.every((state) => state !== "starting" && state !== "running")) {
      return states.every((state) => state === "complete") ? "complete" : "partial";
    }
    return "dispatched";
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
