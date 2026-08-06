// Deterministic in-memory Herdr adapter for tests: no real Herdr, no sleeps, no
// wall clock. It advances a shared mutable clock by configured amounts so the
// runtime's timing metrics are exactly assertable, and it reconstructs each
// lane's runId/laneId from the dispatched command — which doubles as a check
// that the command's shell quoting round-trips.

import type { HerdrAdapter } from "./adapter.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CreatedTab,
  CreateTabOptions,
  InterruptEvidence,
  PaneRef,
  ProcessInfo,
  SplitPaneOptions,
  TabRef,
  WaitOutcome,
} from "./types.ts";

export interface MutableClock {
  now(): number;
  advance(ms: number): void;
}

export function createClock(start = 0): MutableClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface FakeLaneProgram {
  readonly laneId: string;
  readonly exitCode: number;
  /** Clock advance for a matched wait; unmatched waits consume their timeout. */
  readonly execMs?: number;
  /** Whether the sentinel appears (false exercises the missing-sentinel path). */
  readonly emitSentinel?: boolean;
  /** Whether `wait-output` reports a match. */
  readonly waitMatches?: boolean;
  /** Make `wait-output` throw, exercising the CLI/environment failure path. */
  readonly waitErrors?: boolean;
  /** Make the durable-log read throw, exercising an I/O failure on a real lane. */
  readonly readErrors?: boolean;
  /**
   * Keep the lane's foreground process group alive even after the sentinel
   * matches, so completion cannot be declared without a process-info check.
   */
  readonly staysRunningAfterMatch?: boolean;
  readonly extraOutput?: readonly string[];
  /** Agent lanes: bytes the fake CLI leaves in the raw-report artifact. */
  readonly rawReport?: string;
  /** Agent lanes: bytes the fake CLI leaves in the durable stderr artifact. */
  readonly stderrContent?: string;
  /** Agent lanes: leave no raw-report file (derivation-failure path). */
  readonly omitRawReport?: boolean;
  /**
   * The exit status an interrupted lane reports. Real CLIs catch SIGINT and
   * exit with a code of their own — codex exits 1 — so 130 is only one of the
   * shapes an interrupted lane can take.
   */
  readonly interruptExitCode?: number;
}

export interface FakeAdvances {
  readonly createTab?: number;
  readonly splitPane?: number;
  readonly runInPane?: number;
  readonly processInfo?: number;
  readonly focusPane?: number;
  readonly interruptPane?: number;
}

export interface FakeHerdrAdapterOptions {
  readonly clock?: MutableClock;
  readonly lanes?: readonly FakeLaneProgram[];
  readonly advances?: FakeAdvances;
  /** Make every `runInPane` throw (command-failure path). */
  readonly failRunInPane?: boolean;
  /** Throw on `runInPane` only after this many successful calls (partial dispatch). */
  readonly failRunInPaneAfter?: number;
  /** Throw on `splitPane` only after this many successful calls. */
  readonly failSplitPaneAfter?: number;
  /**
   * Exit code the interactive lane's RUNNER pane reports. The runner is an
   * ordinary headless command under the same sentinel contract as a lane, so
   * the fake writes its sentinel into the durable log and nothing else.
   */
  readonly runnerExitCode?: number;
  /** Make the runner leave no sentinel, so no exit code can be parsed. */
  readonly runnerOmitsSentinel?: boolean;
  /** Pane ids `processInfo` rejects, modelling a pane that no longer exists. */
  readonly missingPaneIds?: readonly string[];
}

interface FakePaneState {
  paneId: string;
  role: "controller" | "lane" | "idle";
  kind?: "simulated" | "agent";
  laneId?: string;
  runId?: string;
  logFile?: string;
  stderrFile?: string;
  checkpointFile?: string;
  resultFile?: string;
  rawFile?: string;
  program?: FakeLaneProgram;
  finished: boolean;
  pendingExit: number | null;
}

const SHELL_PID = 1000;

/** Recover the single-quoted tokens produced by shellSingleQuote. */
export function scanSingleQuoted(command: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] !== "'") {
      i++;
      continue;
    }
    i++; // opening quote
    let value = "";
    while (i < command.length) {
      if (command[i] === "'") {
        if (
          command[i + 1] === "\\" &&
          command[i + 2] === "'" &&
          command[i + 3] === "'"
        ) {
          value += "'";
          i += 4;
          continue;
        }
        i++; // closing quote
        break;
      }
      value += command[i];
      i++;
    }
    out.push(value);
  }
  return out;
}

export class FakeHerdrAdapter implements HerdrAdapter {
  readonly clock: MutableClock;
  private readonly programs = new Map<string, FakeLaneProgram>();
  private readonly advances: FakeAdvances;
  private readonly failRunInPane: boolean;
  private readonly failRunInPaneAfter: number | null;
  private readonly failSplitPaneAfter: number | null;
  private readonly runnerExitCode: number;
  private readonly runnerOmitsSentinel: boolean;
  private readonly missingPaneIds: ReadonlySet<string>;
  private runInPaneCalls = 0;
  private splitPaneCalls = 0;
  private readonly panes = new Map<string, FakePaneState>();
  private readonly paneByLane = new Map<string, string>();
  private tabSeq = 0;
  private paneSeq = 0;

  // Observability for assertions.
  focusedPaneId: string | null = null;
  focusedTabId: string | null = null;
  processInfoCalls = 0;
  readonly processInfoPaneIds: string[] = [];
  readonly waitedPaneIds: string[] = [];
  readonly waitTimeoutMs: number[] = [];
  readonly interruptedPaneIds: string[] = [];
  readonly dispatched: { paneId: string; command: string }[] = [];

  constructor(options: FakeHerdrAdapterOptions = {}) {
    this.clock = options.clock ?? createClock();
    this.advances = options.advances ?? {};
    this.failRunInPane = options.failRunInPane ?? false;
    this.failRunInPaneAfter = options.failRunInPaneAfter ?? null;
    this.failSplitPaneAfter = options.failSplitPaneAfter ?? null;
    this.runnerExitCode = options.runnerExitCode ?? 0;
    this.runnerOmitsSentinel = options.runnerOmitsSentinel ?? false;
    this.missingPaneIds = new Set(options.missingPaneIds ?? []);
    for (const lane of options.lanes ?? []) this.programs.set(lane.laneId, lane);
  }

  paneIdForLane(laneId: string): string | undefined {
    return this.paneByLane.get(laneId);
  }

  /** Simulate a lane exiting on its own without going through wait/interrupt. */
  finishLane(laneId: string): void {
    const paneId = this.paneByLane.get(laneId);
    const state = paneId === undefined ? undefined : this.panes.get(paneId);
    if (!state || state.role !== "lane") {
      throw new Error(`fake: unknown lane ${laneId}`);
    }
    state.finished = true;
  }

  private tick(ms: number | undefined): void {
    if (ms) this.clock.advance(ms);
  }

  async createTab(_opts: CreateTabOptions): Promise<CreatedTab> {
    this.tick(this.advances.createTab);
    const tabId = `wf:t${++this.tabSeq}`;
    const paneId = `wf:p${++this.paneSeq}`;
    this.panes.set(paneId, {
      paneId,
      role: "controller",
      finished: false,
      pendingExit: null,
    });
    return { tab: { id: tabId }, controllerPane: { id: paneId } };
  }

  async splitPane(_opts: SplitPaneOptions): Promise<PaneRef> {
    this.tick(this.advances.splitPane);
    if (
      this.failSplitPaneAfter !== null &&
      this.splitPaneCalls >= this.failSplitPaneAfter
    ) {
      this.splitPaneCalls++;
      throw new Error("fake: splitPane failed");
    }
    this.splitPaneCalls++;
    const paneId = `wf:p${++this.paneSeq}`;
    this.panes.set(paneId, {
      paneId,
      role: "idle",
      finished: false,
      pendingExit: null,
    });
    return { id: paneId };
  }

  async runInPane(pane: PaneRef, shellCommand: string): Promise<void> {
    this.tick(this.advances.runInPane);
    this.dispatched.push({ paneId: pane.id, command: shellCommand });
    if (
      this.failRunInPane ||
      (this.failRunInPaneAfter !== null &&
        this.runInPaneCalls >= this.failRunInPaneAfter)
    ) {
      this.runInPaneCalls++;
      throw new Error("fake: runInPane failed");
    }
    this.runInPaneCalls++;
    const state = this.panes.get(pane.id);
    if (!state) throw new Error(`fake: unknown pane ${pane.id}`);
    const tokens = scanSingleQuoted(shellCommand);
    if (tokens[0]?.startsWith("# flow interactive runner")) {
      // tokens: [script, runId, evidenceId, cwd, logFile, ...argv]
      const [, runId, evidenceId, , logFile] = tokens;
      if (!runId || !evidenceId || !logFile) {
        throw new Error(`fake: could not parse runner command: ${shellCommand}`);
      }
      state.role = "lane";
      state.runId = runId;
      state.laneId = evidenceId;
      state.logFile = logFile;
      state.finished = true;
      await mkdir(dirname(logFile), { recursive: true });
      await writeFile(
        logFile,
        this.runnerOmitsSentinel
          ? `RUNNER_START run=${runId} evidence=${evidenceId}\n`
          : `RUNNER_START run=${runId} evidence=${evidenceId}\nFLOW_${runId}_RUNNER_${evidenceId}_EXIT=${this.runnerExitCode}\n`,
        "utf8",
      );
      return;
    }
    if (tokens[0]?.startsWith("# flow agent lane")) {
      // tokens: [script, runId, laneId, cwd, logFile, stderrFile, rawFile,
      // promptFile, stdinMode, rawMode, ...cli]
      const [, runId, laneId, , logFile, stderrFile, rawFile] = tokens;
      if (!runId || !laneId || !logFile || !stderrFile || !rawFile) {
        throw new Error(
          `fake: could not parse agent lane command: ${shellCommand}`,
        );
      }
      state.role = "lane";
      state.kind = "agent";
      state.runId = runId;
      state.laneId = laneId;
      state.logFile = logFile;
      state.stderrFile = stderrFile;
      state.rawFile = rawFile;
      state.program = this.programs.get(laneId);
      state.finished = false;
      state.pendingExit = null;
      this.paneByLane.set(laneId, pane.id);
      // The fake CLI leaves its captured bytes behind; checkpoints and
      // results are the RUNTIME's derivation job, so the fake never writes
      // them for agent lanes.
      if (!(state.program?.omitRawReport ?? false)) {
        await mkdir(dirname(rawFile), { recursive: true });
        await writeFile(rawFile, state.program?.rawReport ?? "", "utf8");
      }
      await mkdir(dirname(stderrFile), { recursive: true });
      await writeFile(
        stderrFile,
        state.program?.stderrContent ?? "",
        "utf8",
      );
      return;
    }
    // tokens: [script, runId, laneId, logFile, stderrFile, steps, delay,
    // checkpointFile, resultFile]
    const [
      ,
      runId,
      laneId,
      logFile,
      stderrFile,
      ,
      ,
      checkpointFile,
      resultFile,
    ] = tokens;
    if (
      !runId ||
      !laneId ||
      !logFile ||
      !stderrFile ||
      !checkpointFile ||
      !resultFile
    ) {
      throw new Error(`fake: could not parse lane command: ${shellCommand}`);
    }
    state.role = "lane";
    state.kind = "simulated";
    state.runId = runId;
    state.laneId = laneId;
    state.logFile = logFile;
    state.stderrFile = stderrFile;
    state.checkpointFile = checkpointFile;
    state.resultFile = resultFile;
    state.program = this.programs.get(laneId);
    state.finished = false;
    state.pendingExit = null;
    this.paneByLane.set(laneId, pane.id);
    if (state.program?.emitSentinel ?? true) {
      await this.writeRecords(state, "complete", "ok");
    }
  }

  async waitForOutput(
    pane: PaneRef,
    _regex: string,
    timeoutMs: number,
  ): Promise<WaitOutcome> {
    this.waitedPaneIds.push(pane.id);
    this.waitTimeoutMs.push(timeoutMs);
    const state = this.panes.get(pane.id);
    if (state?.role === "lane") {
      const matched = state.program?.waitMatches ?? true;
      this.tick(
        matched
          ? Math.min(state.program?.execMs ?? 0, timeoutMs)
          : timeoutMs,
      );
      if (state.program?.waitErrors) {
        throw new Error("fake: herdr pane wait-output failed");
      }
      // Normally a matched sentinel means the process has exited; a lane marked
      // staysRunningAfterMatch keeps its foreground group alive, so completion
      // must still be gated on process-info.
      if (matched && !state.program?.staysRunningAfterMatch) {
        state.finished = true;
      }
      return { matched, timedOut: !matched };
    }
    // controller marker or idle pane: matches immediately.
    return { matched: true, timedOut: false };
  }

  async processInfo(pane: PaneRef): Promise<ProcessInfo> {
    this.processInfoCalls++;
    this.processInfoPaneIds.push(pane.id);
    this.tick(this.advances.processInfo);
    if (this.missingPaneIds.has(pane.id)) {
      throw new Error(`fake: pane ${pane.id} no longer exists`);
    }
    const state = this.panes.get(pane.id);
    if (!state) throw new Error(`fake: unknown pane ${pane.id}`);
    const running = state.role === "lane" && !state.finished;
    const pgid = running ? 2000 + this.paneSeqIndex(pane.id) : SHELL_PID;
    return {
      paneId: pane.id,
      shellPid: SHELL_PID,
      foregroundProcessGroupId: pgid,
      foregroundPids: running ? [pgid] : [SHELL_PID],
      foregroundNames: running ? ["bash"] : ["-zsh"],
    };
  }

  async focusPane(pane: PaneRef, tab: TabRef): Promise<void> {
    this.tick(this.advances.focusPane);
    this.focusedPaneId = pane.id;
    this.focusedTabId = tab.id;
  }

  async interruptPane(pane: PaneRef): Promise<InterruptEvidence> {
    this.interruptedPaneIds.push(pane.id);
    this.tick(this.advances.interruptPane);
    const state = this.panes.get(pane.id);
    const running = state?.role === "lane" && !state.finished;
    if (!running || !state) {
      return { signal: "SIGINT", processGroupId: null, delivered: false };
    }
    state.pendingExit = state.program?.interruptExitCode ?? 130;
    state.finished = true;
    if (state.kind !== "agent") {
      await this.writeRecords(state, "partial", "interrupted");
    }
    return {
      signal: "SIGINT",
      processGroupId: 2000 + this.paneSeqIndex(pane.id),
      delivered: true,
    };
  }

  /** Wired into RuntimeDeps.readResultFile: reconstruct a lane's durable log. */
  readResultFile = async (path: string): Promise<string> => {
    for (const state of this.panes.values()) {
      if (state.logFile === path) {
        if (state.program?.readErrors) {
          throw new Error("fake: durable read failed (I/O)");
        }
        return this.durable(state);
      }
    }
    throw new Error(`fake: no durable log for ${path}`);
  };

  private durable(state: FakePaneState): string {
    const lines: string[] = [...(state.program?.extraOutput ?? [])];
    const emit = state.program?.emitSentinel ?? true;
    if (!emit) return lines.join("\n");
    const exit = state.pendingExit ?? state.program?.exitCode ?? 0;
    const event = exit === 130 ? "interrupted-SIGINT" : "done";
    lines.push(`STEP=42 EVENT=${event}`);
    lines.push(`FLOW_${state.runId}_LANE_${state.laneId}_EXIT=${exit}`);
    return lines.join("\n");
  }

  private async writeRecords(
    state: FakePaneState,
    status: "complete" | "partial",
    result: "ok" | "interrupted",
  ): Promise<void> {
    if (!state.checkpointFile || !state.resultFile) return;
    await mkdir(dirname(state.checkpointFile), { recursive: true });
    await mkdir(dirname(state.resultFile), { recursive: true });
    const steps = state.program?.exitCode === 130 || status === "partial" ? 0 : 1;
    await writeFile(
      state.checkpointFile,
      `STATUS: ${status}\nPHASE: simulated\nCOMPLETED:\n- steps ${steps}\nNEXT:\n- none\nBLOCKERS:\n- none\nARTIFACTS:\n- ${state.resultFile}\nVERIFICATION_CLAIMS:\n- completion sentinel\nGAPS:\n- none\n`,
      "utf8",
    );
    await writeFile(state.resultFile, `RESULT: ${result} steps=${steps}\n`, "utf8");
  }

  private paneSeqIndex(paneId: string): number {
    const n = Number.parseInt(paneId.replace("wf:p", ""), 10);
    return Number.isNaN(n) ? 0 : n;
  }
}
