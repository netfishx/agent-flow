// The visible-run tracer. Runtime facts are committed to the injected Ledger
// and then folded into memory through the same reducer used by ledger replay.

import type { PaneRef } from "../herdr/types.ts";
import { buildLaneCommand } from "../smoke/lane.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  NewRunEvent,
  RunEvent,
  RunOutcomeBreakdown,
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
import type { LeaseHandle } from "./ledger.ts";

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);

interface LaneArtifactPaths {
  readonly checkpointFile: string;
  readonly resultFile: string;
  readonly evidenceFile: string;
}

function laneArtifactPaths(cwd: string, laneId: string): LaneArtifactPaths {
  return {
    checkpointFile: `${cwd}/checkpoints/${laneId}.md`,
    resultFile: `${cwd}/results/${laneId}-result.txt`,
    evidenceFile: `${cwd}/evidence/${laneId}-evidence.json`,
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
  private readonly leases = new Map<string, LeaseHandle>();

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
      artifacts: LaneArtifactPaths;
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
        artifacts: laneArtifactPaths(config.cwd, spec.laneId),
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
        checkpointFile: item.artifacts.checkpointFile,
        resultFile: item.artifacts.resultFile,
        steps: item.spec.steps,
        stepDelaySeconds: item.stepDelaySeconds,
      });
      const dispatchedAt = this.deps.clock();
      try {
        await this.deps.adapter.runInPane(item.pane, command);
      } catch (cause) {
        try {
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
            data: {},
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
      if (lane.runtimeState !== "failed_to_start") {
        await this.recordTerminalFacts(runId, laneId, lane.exitCode);
        await this.finishIfTerminal(runId);
      }
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

  protected registerReducedView(view: RunView): void {
    this.runs.set(view.runId, view);
  }

  protected async acquireControllerLease(runId: string): Promise<void> {
    if (this.leases.has(runId)) return;
    const lease = await this.deps.ledger.acquireLease(runId, {
      controllerId: `runtime-${process.pid}`,
      pid: process.pid,
    });
    this.leases.set(runId, lease);
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
      const current = this.runs.get(runId);
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
    if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
      if (
        lane.runtimeState !== "failed_to_start" &&
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
      await this.recordTerminalFacts(runId, laneId, exitCode);
      await this.finishIfTerminal(runId);
      const finalizedLane = this.getLane(this.getRun(runId), laneId);
      if (
        finalizedLane.runtimeState === "lost" &&
        finalizedLane.lostCause === "dispatch-outcome-unknown"
      ) {
        throw new Error(
          `lane "${laneId}" was lost (dispatch-outcome-unknown): its process is gone without positive execution evidence or a sentinel`,
        );
      }
      throw new Error(
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
    await this.recordTerminalFacts(runId, laneId, exitCode);
    await this.finishIfTerminal(runId);
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
    const command = buildLaneCommand({
      runId,
      laneId,
      logFile: terminalLane.logFile,
      checkpointFile,
      resultFile,
      steps: terminalLane.steps,
      stepDelaySeconds: terminalLane.stepDelaySeconds,
    });
    const termination =
      terminalLane.runtimeState === "lost"
        ? "lost"
        : terminalLane.runtimeState === "crashed"
          ? "crashed"
          : "sentinel-exit";
    const evidence: RunnerEvidence = {
      schemaVersion: 1,
      runId,
      laneId,
      command,
      logFile: terminalLane.logFile,
      dispatchedAt: terminalLane.dispatchedAt,
      liveAt: terminalLane.liveAt,
      completedAt: terminalLane.completedAt,
      exitCode: parsedExitCode,
      termination,
    };
    await mkdir(dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const evidenceComplete =
      evidence.command.length > 0 &&
      evidence.logFile.length > 0 &&
      evidence.dispatchedAt !== null &&
      evidence.liveAt !== null &&
      evidence.completedAt !== null &&
      evidence.exitCode !== null &&
      evidence.termination === "sentinel-exit";
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
  }

  private async finishIfTerminal(runId: string): Promise<void> {
    await this.commitEventConditionally(runId, (run) => {
      if (!run) throw new Error(`unknown runId "${runId}"`);
      if (run.finishStatus !== null || run.laneOrder.length === 0) return null;
      const lanes = run.laneOrder.map((laneId) => this.getLane(run, laneId));
      if (!lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))) {
        return null;
      }
      if (
        lanes.some(
          (lane) =>
            lane.runtimeState !== "failed_to_start" &&
            (lane.contractEvaluatedAt === null ||
              lane.verificationRecordedAt === null),
        )
      ) {
        return null;
      }
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
      return {
        type: "run_finished",
        actor: "runtime",
        data: { status: clean ? "clean" : "degraded", breakdown },
      };
    });
    if (this.getRun(runId).finishStatus !== null) {
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
