// The interactive write lane's control plane.
//
// It is a peer of `WorkflowRuntime`, not an extension of it: the read-only
// runtime accepted in #7 is untouched, and this class reuses the mechanisms
// rather than the code path — the same Herdr adapter for pane topology and
// process facts, the same ledger and reducer, the same controller lease, the
// same takeover events, and the same sentinel-based runner contract.
//
// Two rules run through every method here:
//
//   - a control is a HUMAN act. Nothing on this class issues a steer, cancel,
//     abort, or retry on its own, and no method retries anything automatically.
//   - advisory Herdr state is recorded, never consumed as an outcome. It
//     reaches the ledger through the advisory events alone, and the outcome
//     projection cannot read them (see ./attempts.ts).

import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { HerdrAdapter } from "../herdr/adapter.ts";
import type { HerdrAgentControl } from "../herdr/agent-control.ts";
import { agentNameFor, AGENT_START_TIMEOUT_DEFAULT_MS } from "../herdr/agent-argv.ts";
import type { Ledger, LeaseHandle } from "../runtime/ledger.ts";
import type { NewRunEvent, RunEvent } from "../runtime/events.ts";
import { reduce, type RunView } from "../runtime/reducer.ts";
import { assertHandleId } from "../runtime/ids.ts";
import {
  buildNativeArgs,
  buildRunnerCommand,
  parseRunnerExit,
  runnerSentinelRegex,
} from "./commands.ts";
import { attemptDisposition } from "./attempts.ts";
import type {
  AdvisoryAgentStatus,
  AttemptDisposition,
  InteractiveAgentKind,
  InteractiveAttemptView,
  ReconciliationOutcome,
  SteerObservation,
} from "./types.ts";

/** Raised when a control is attempted on a lane a human has taken over. */
export class LaneTakenOverError extends Error {
  constructor(laneId: string) {
    super(
      `lane "${laneId}" is under human takeover: the runtime issues no agent prompt and no agent send-keys to it`,
    );
    this.name = "LaneTakenOverError";
  }
}

/** Raised when a retry is requested without a recorded human authorization. */
export class RetryNotAuthorizedError extends Error {
  constructor(laneId: string) {
    super(`lane "${laneId}" has no recorded retry authorization`);
    this.name = "RetryNotAuthorizedError";
  }
}

/**
 * Raised when a control is attempted on an attempt whose pane reconciled to
 * anything but `live`. A pane that is gone, or that another process now
 * occupies, is not this attempt's pane: issuing a control into it would drive
 * a stranger's session.
 */
export class AttemptNotControllableError extends Error {
  constructor(attemptId: string, reason: string) {
    super(`attempt "${attemptId}" is not controllable: ${reason}`);
    this.name = "AttemptNotControllableError";
  }
}

export interface InteractiveDeps {
  /** Pane topology, process facts, and the abort signal path. */
  readonly adapter: HerdrAdapter;
  readonly agentControl: HerdrAgentControl;
  readonly ledger: Ledger;
  readonly clock: () => number;
  readonly idgen: () => string;
  /** Pre-assigned session UUIDs for claude/grok attempts. */
  readonly sessionIdgen?: () => string;
  readonly readDurable?: (path: string) => Promise<string>;
  readonly writeDurable?: (path: string, text: string) => Promise<void>;
  /** How long `agent start` may take to report readiness. */
  readonly startTimeoutMs?: number;
  /** Window for the post-submission observation of a steer. */
  readonly steerWaitMs?: number;
  /** Window for the runner's sentinel wait. */
  readonly runnerTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface OpenLaneConfig {
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly laneId: string;
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  /** The lane's isolated implementation worktree. */
  readonly worktreePath: string;
  readonly role?: string;
}

export interface StartAttemptInput {
  /** The brief, delivered as the FIRST agent prompt, not as a CLI argument. */
  readonly brief: string;
  readonly briefFile: string;
  readonly checkpointFile: string;
  readonly resultPointer: string;
  /** The human act that authorized this attempt. */
  readonly authorization: { readonly note: string };
  /** Override the rehearsal-pending native argv for this attempt. */
  readonly nativeArgs?: readonly string[];
  readonly parentAttemptId?: string | null;
}

export interface StartAttemptOutcome {
  readonly attemptId: string;
  readonly started: boolean;
  /** Populated on failure; a start failure is never an implicit retry. */
  readonly startFailure: string | null;
}

export interface RunnerRequest {
  readonly argv: readonly string[];
  readonly logFile: string;
  /** Defaults to the attempt's worktree. */
  readonly cwd?: string;
}

const DEFAULT_STEER_WAIT_MS = 5_000;
const DEFAULT_RUNNER_TIMEOUT_MS = 300_000;

export class InteractiveLaneController {
  private readonly runs = new Map<string, RunView>();
  private readonly commitTails = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, LeaseHandle>();

  constructor(private readonly deps: InteractiveDeps) {}

  // ---------------------------------------------------------------- lifecycle

  /**
   * Provision the lane: a dedicated tab, a controller pane, and a registered
   * interactive lane. No agent is started here — an attempt does that, so the
   * lane can outlive any number of them.
   */
  async openLane(config: OpenLaneConfig): Promise<{
    readonly runId: string;
    readonly laneId: string;
  }> {
    assertHandleId("laneId", config.laneId);
    const runId = this.deps.idgen();
    assertHandleId("runId", runId);
    const created = await this.deps.adapter.createTab({
      workspace: config.workspace,
      cwd: config.cwd,
      label: config.workflow,
    });
    await this.commit(runId, {
      type: "run_started",
      actor: "runtime",
      data: {
        workflow: config.workflow,
        workspace: config.workspace,
        cwd: config.cwd,
        splitDirection: "right",
        tabId: created.tab.id,
        controllerPaneId: created.controllerPane.id,
        fixedPoint: null,
        issue: null,
      },
    });
    await this.commit(runId, {
      type: "lane_registered",
      actor: "runtime",
      laneId: config.laneId,
      data: {
        kind: "interactive",
        laneId: config.laneId,
        paneId: created.controllerPane.id,
        logFile: "",
        stderrFile: "",
        sentinelToken: "",
        agentKind: config.agentKind,
        model: config.model,
        effort: config.effort,
        worktreePath: config.worktreePath,
        ...(config.role === undefined ? {} : { role: config.role }),
      },
    });
    return { runId, laneId: config.laneId };
  }

  /**
   * Start one attempt: the RUNTIME provisions the pane, then Herdr starts or
   * recognizes the interactive agent in it. `herdr agent start` never creates,
   * splits, or moves layout, so pane topology stays this side of the seam.
   */
  async startAttempt(
    runId: string,
    laneId: string,
    input: StartAttemptInput,
  ): Promise<StartAttemptOutcome> {
    const run = await this.reload(runId);
    const lane = this.lane(run, laneId);
    if (lane.kind !== "interactive") {
      throw new Error(`lane "${laneId}" is not an interactive write lane`);
    }
    const parentAttemptId = input.parentAttemptId ?? null;
    if (parentAttemptId !== null && !this.retryAuthorized(run, parentAttemptId)) {
      throw new RetryNotAuthorizedError(laneId);
    }
    const attemptId = this.deps.idgen();
    assertHandleId("attemptId", attemptId);
    const ordinal = this.attemptsOf(run, laneId).length + 1;

    // A NEW pane per attempt: a retry never resumes, impersonates, or replaces
    // a prior session, so it never reuses that session's pane either.
    const pane = await this.deps.adapter.splitPane({
      from: { id: run.controllerPaneId },
      direction: "right",
      cwd: lane.worktreePath ?? run.cwd,
    });

    await this.write(input.briefFile, input.brief);
    await this.commit(runId, {
      type: "interactive_attempt_started",
      actor: "runtime",
      laneId,
      data: {
        attemptId,
        ordinal,
        parentAttemptId,
        agentKind: lane.agentKind as InteractiveAgentKind,
        model: lane.model ?? "",
        effort: lane.effort ?? "",
        paneId: pane.id,
        worktreePath: lane.worktreePath ?? run.cwd,
        briefFile: input.briefFile,
        checkpointFile: input.checkpointFile,
        resultPointer: input.resultPointer,
        authorization: { actor: "human", note: input.authorization.note },
      },
    });

    if (parentAttemptId !== null) {
      // Append-only: superseding records a relationship on the prior attempt
      // and rewrites none of its facts.
      await this.commit(runId, {
        type: "interactive_attempt_superseded",
        actor: "runtime",
        laneId,
        data: { attemptId: parentAttemptId, supersededBy: attemptId },
      });
    }

    const agentKind = lane.agentKind as InteractiveAgentKind;
    const sessionId =
      agentKind === "codex" ? null : (this.deps.sessionIdgen?.() ?? null);
    const nativeArgs =
      input.nativeArgs ??
      buildNativeArgs({
        agentKind,
        model: lane.model ?? "",
        effort: lane.effort ?? "",
        sessionId,
      });
    const name = agentNameFor(laneId, attemptId);
    const startedAt = this.deps.clock();
    try {
      const started = await this.deps.agentControl.startAgent({
        name,
        kind: agentKind,
        paneId: pane.id,
        timeoutMs: this.deps.startTimeoutMs ?? AGENT_START_TIMEOUT_DEFAULT_MS,
        nativeArgs,
      });
      await this.commit(runId, {
        type: "interactive_attempt_bound",
        actor: "runtime",
        laneId,
        data: {
          attemptId,
          agentName: started.agent.name ?? name,
          agentSessionId: started.agent.sessionId ?? sessionId,
          argv: started.argv,
          readinessMs: this.deps.clock() - startedAt,
        },
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      await this.commit(runId, {
        type: "interactive_attempt_start_failed",
        actor: "runtime",
        laneId,
        data: { attemptId, cause },
      });
      return { attemptId, started: false, startFailure: cause };
    }

    // The brief is the first prompt: an interactive session has no one-shot
    // prompt-file equivalent that also leaves it steerable.
    await this.steer(runId, laneId, input.brief, { attemptId });
    return { attemptId, started: true, startFailure: null };
  }

  // ------------------------------------------------------------------ controls

  /**
   * Submit an instruction to a live session, as TWO facts.
   *
   * The submission is recorded BEFORE the call, so a controller that dies
   * mid-call still leaves the intent in the ledger. The transition afterwards
   * is recorded as an observation. Neither says the steer was applied and
   * neither says the work finished — `--wait` tracks lifecycle state, not
   * turns, so an already-working agent's active turn can satisfy it.
   */
  async steer(
    runId: string,
    laneId: string,
    text: string,
    options: { readonly attemptId?: string } = {},
  ): Promise<SteerObservation> {
    const { run, attempt } = await this.liveAttempt(runId, laneId, options.attemptId);
    this.assertNotTakenOver(run, laneId);
    this.assertControllable(attempt);
    const target = this.targetOf(attempt);

    await this.commit(runId, {
      type: "lane_steer_submitted",
      actor: "human",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        text,
        paneId: attempt.paneId,
        target,
      },
    });

    const result = await this.deps.agentControl.promptAgent(target, text, {
      waitMs: this.deps.steerWaitMs ?? DEFAULT_STEER_WAIT_MS,
    });
    const observedStatus = result.agent?.status ?? null;
    await this.commit(runId, {
      type: "lane_steer_observed",
      actor: "runtime",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        outcome: result.outcome,
        observedStatus,
        source: observedStatus === null ? null : "herdr-detection",
      },
    });
    return {
      outcome: result.outcome,
      observed:
        observedStatus === null
          ? null
          : {
              status: observedStatus,
              source: "herdr-detection",
              paneId: attempt.paneId,
              at: this.deps.clock(),
            },
    };
  }

  /**
   * Cancel the current turn and KEEP the session alive and steerable. This is
   * the default interrupt for a write lane; the signal path would end the
   * session, which is a different act with a different record.
   */
  async cancelTurn(
    runId: string,
    laneId: string,
    options: { readonly attemptId?: string; readonly keys?: readonly string[] } = {},
  ): Promise<AdvisoryAgentStatus | null> {
    const { run, attempt } = await this.liveAttempt(runId, laneId, options.attemptId);
    this.assertNotTakenOver(run, laneId);
    this.assertControllable(attempt);
    const target = this.targetOf(attempt);
    const keys = options.keys ?? ["esc"];
    await this.deps.agentControl.sendKeys(target, keys);
    const observed = await this.deps.agentControl.getAgent(target);
    await this.commit(runId, {
      type: "lane_cancel_turn",
      actor: "human",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        method: "send-keys",
        keys: [...keys],
        observedStatus: observed?.status ?? null,
      },
    });
    return observed?.status ?? null;
  }

  /**
   * End the session by signalling the pane's foreground process group — the
   * existing interrupt path, reused unchanged. This terminates the attempt,
   * and is recorded distinctly from a cancelled turn because it is a different
   * fact. Neither is a verdict on the work.
   */
  async abortSession(
    runId: string,
    laneId: string,
    options: { readonly attemptId?: string } = {},
  ): Promise<void> {
    const { attempt } = await this.liveAttempt(runId, laneId, options.attemptId);
    const evidence = await this.deps.adapter.interruptPane({ id: attempt.paneId });
    const observed = await this.deps.agentControl.getAgent(
      this.targetOf(attempt),
    );
    await this.commit(runId, {
      type: "lane_abort_session",
      actor: "human",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        method: "signal-process-group",
        signal: evidence.signal,
        delivered: evidence.delivered,
        observedStatus: observed?.status ?? null,
      },
    });
    await this.commit(runId, {
      type: "interactive_attempt_ended",
      actor: "runtime",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        endReason: "aborted",
        // No exit code is invented: the signal was delivered to a process
        // group, and Herdr exposes no exit code on any surface.
        exitCode: null,
      },
    });
  }

  /** Human ownership of the lane's input channel. Reuses the shipped events. */
  async takeover(runId: string, laneId: string): Promise<void> {
    await this.reload(runId);
    await this.commit(runId, {
      type: "lane_takeover",
      actor: "human",
      laneId,
      data: {},
    });
  }

  async release(runId: string, laneId: string): Promise<void> {
    await this.reload(runId);
    await this.commit(runId, {
      type: "lane_release",
      actor: "human",
      laneId,
      data: {},
    });
  }

  /**
   * Record a human's authorization to retry. It stands alone in the ledger so
   * it survives a controller that dies before the new attempt starts.
   */
  async authorizeRetry(
    runId: string,
    laneId: string,
    parentAttemptId: string,
    note: string,
  ): Promise<void> {
    await this.reload(runId);
    await this.commit(runId, {
      type: "interactive_retry_authorized",
      actor: "human",
      laneId,
      data: { parentAttemptId, note },
    });
  }

  // ------------------------------------------------------------- observations

  /**
   * Read Herdr's advisory classification and record it WITH its source. This
   * is a UI signal and a wait edge. It is not evidence, and nothing downstream
   * can read it as one.
   */
  async observeAdvisoryState(
    runId: string,
    laneId: string,
    options: { readonly attemptId?: string } = {},
  ): Promise<AdvisoryAgentStatus | null> {
    const { attempt } = await this.liveAttempt(runId, laneId, options.attemptId);
    const observed = await this.deps.agentControl.getAgent(
      this.targetOf(attempt),
    );
    if (observed === null) return null;
    await this.recordAdvisory(runId, laneId, attempt, observed.status, null);
    return observed.status;
  }

  /**
   * Wait for Herdr to classify the pane as showing an approval or question UI.
   * Consumed as a wait edge only: answering the approval is a human act,
   * performed in the pane or through `steer`, and no approval-UI parser exists
   * for any CLI.
   */
  async waitForBlocked(
    runId: string,
    laneId: string,
    timeoutMs: number,
    options: { readonly attemptId?: string } = {},
  ): Promise<boolean> {
    const { attempt } = await this.liveAttempt(runId, laneId, options.attemptId);
    const observed = await this.deps.agentControl.waitForState(
      this.targetOf(attempt),
      ["blocked"],
      timeoutMs,
    );
    if (observed === null) return false;
    await this.recordAdvisory(runId, laneId, attempt, observed.status, null);
    return observed.status === "blocked";
  }

  /** Publish runtime-owned advisory state for the Herdr UI. Optional, never evidence. */
  async publishAdvisoryState(
    runId: string,
    laneId: string,
    state: "idle" | "working" | "blocked" | "unknown",
    message?: string,
  ): Promise<void> {
    const { attempt } = await this.liveAttempt(runId, laneId);
    await this.deps.agentControl.reportAgentState({
      paneId: attempt.paneId,
      source: this.advisorySource(runId),
      agent: this.targetOf(attempt),
      state,
      ...(message === undefined ? {} : { message }),
    });
    await this.recordAdvisory(
      runId,
      laneId,
      attempt,
      state,
      message ?? null,
      "runtime-published",
    );
  }

  async releaseAdvisoryState(runId: string, laneId: string): Promise<void> {
    const { attempt } = await this.liveAttempt(runId, laneId);
    await this.deps.agentControl.releaseAgentState({
      paneId: attempt.paneId,
      source: this.advisorySource(runId),
      agent: this.targetOf(attempt),
    });
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Reconcile one attempt against the world after controller loss. Three
   * outcomes, and two of them fail closed:
   *
   *   - the pane is alive and hosts the expected kind → the attempt continues;
   *   - the pane is alive but hosts a different or unrecognized occupant →
   *     `unknown`, and NO control call is issued;
   *   - the pane is gone → `unknown` with no exit code, and the evidence is
   *     whatever landed on disk.
   */
  async reconcileAttempt(
    runId: string,
    laneId: string,
    attemptId: string,
  ): Promise<ReconciliationOutcome> {
    const run = await this.reload(runId);
    const attempt = this.attempt(run, attemptId);
    const target = this.targetOf(attempt);
    let observed = null;
    let paneMissing = false;
    try {
      observed = await this.deps.agentControl.getAgent(target);
    } catch {
      // A failed lookup is not proof of anything; the pane decides below.
      observed = null;
    }
    if (observed === null) {
      try {
        await this.deps.adapter.processInfo({ id: attempt.paneId });
      } catch {
        paneMissing = true;
      }
    }

    const outcome: ReconciliationOutcome =
      observed === null
        ? paneMissing
          ? "missing"
          : "reoccupied"
        : observed.agent === attempt.agentKind
          ? "live"
          : "reoccupied";
    const detail =
      outcome === "live"
        ? null
        : outcome === "missing"
          ? "pane could not be resolved"
          : `pane hosts ${observed?.agent ?? "an unrecognized occupant"}, expected ${attempt.agentKind}`;

    await this.commit(runId, {
      type: "interactive_attempt_reconciled",
      actor: "runtime",
      laneId,
      data: {
        attemptId,
        outcome,
        // Re-read rather than assumed: a pane moved between workspaces gets a
        // new workspace-qualified id.
        paneId: observed?.paneId ?? attempt.paneId,
        detail,
      },
    });
    if (outcome !== "live" && attempt.endedAt === null) {
      await this.commit(runId, {
        type: "interactive_attempt_ended",
        actor: "runtime",
        laneId,
        data: { attemptId, endReason: "lost", exitCode: null },
      });
    }
    return outcome;
  }

  // -------------------------------------------------------------------- runner

  /**
   * Run a verification command in its OWN pane, as an ordinary command. Never
   * inside the agent session and never through the agent surface: an agent's
   * claim that it ran a command is a claim, and this exit code is the evidence.
   */
  async recordRunnerEvidence(
    runId: string,
    laneId: string,
    attemptId: string,
    request: RunnerRequest,
  ): Promise<{ readonly evidenceId: string; readonly exitCode: number | null }> {
    const run = await this.reload(runId);
    const attempt = this.attempt(run, attemptId);
    const evidenceId = this.deps.idgen();
    assertHandleId("evidenceId", evidenceId);
    const pane = await this.deps.adapter.splitPane({
      from: { id: run.controllerPaneId },
      direction: "down",
      cwd: request.cwd ?? attempt.worktreePath,
    });
    const command = buildRunnerCommand({
      runId,
      evidenceId,
      cwd: request.cwd ?? attempt.worktreePath,
      logFile: request.logFile,
      argv: request.argv,
    });
    const startedAt = this.deps.clock();
    await this.deps.adapter.runInPane(pane, command);
    await this.deps.adapter.waitForOutput(
      pane,
      runnerSentinelRegex(runId, evidenceId),
      this.deps.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS,
    );
    const output = await this.read(request.logFile);
    // The real exit code comes from the durable log's sentinel, never from the
    // wait: a matched pattern says the line was printed, nothing more.
    const exitCode = parseRunnerExit(runId, evidenceId, output);
    await this.commit(runId, {
      type: "interactive_runner_evidence",
      actor: "runner",
      laneId,
      data: {
        evidenceId,
        attemptId,
        command,
        logFile: request.logFile,
        paneId: pane.id,
        exitCode,
        startedAt,
        endedAt: this.deps.clock(),
      },
    });
    return { evidenceId, exitCode };
  }

  /**
   * Record the Agent's own checkpoint, read from the declared path. Nothing
   * durable comes from scrollback: an alternate-screen TUI's departed rows
   * never enter host scrollback and cannot be recovered with more lines.
   */
  async collectAgentCheckpoint(
    runId: string,
    laneId: string,
    attemptId: string,
  ): Promise<"agent" | "unknown"> {
    const run = await this.reload(runId);
    const attempt = this.attempt(run, attemptId);
    let text: string | null = null;
    try {
      text = await this.read(attempt.checkpointFile);
    } catch {
      text = null;
    }
    const parsed = text === null ? null : parseAgentStatus(text);
    if (parsed === null) {
      // The lane left no checkpoint. The runtime records `unknown` under its
      // OWN actor and invents no Agent claim.
      await this.commit(runId, {
        type: "lane_checkpoint",
        actor: "runtime",
        laneId,
        data: {
          semanticState: "unknown",
          checkpointFile: attempt.checkpointFile,
          attemptId,
        },
      });
      return "unknown";
    }
    await this.commit(runId, {
      type: "lane_checkpoint",
      actor: "agent",
      laneId,
      data: {
        semanticState: parsed,
        checkpointFile: attempt.checkpointFile,
        attemptId,
      },
    });
    return "agent";
  }

  // ------------------------------------------------------------------ readers

  async inspect(runId: string): Promise<RunView> {
    return this.reload(runId);
  }

  async attempts(
    runId: string,
    laneId: string,
  ): Promise<readonly InteractiveAttemptView[]> {
    return this.attemptsOf(await this.reload(runId), laneId);
  }

  async disposition(
    runId: string,
    attemptId: string,
  ): Promise<AttemptDisposition> {
    return attemptDisposition(this.attempt(await this.reload(runId), attemptId));
  }

  // ------------------------------------------------------------------ internals

  private advisorySource(runId: string): string {
    return `agent-flow-${runId}`;
  }

  private targetOf(attempt: InteractiveAttemptView): string {
    // Re-resolved on every control call: a name is not a durable handle, so
    // the ledger's paneId is the fallback Herdr also accepts as a target.
    return attempt.agentName ?? attempt.paneId;
  }

  private assertNotTakenOver(run: RunView, laneId: string): void {
    if (this.lane(run, laneId).controlMode === "human_owned") {
      throw new LaneTakenOverError(laneId);
    }
  }

  private assertControllable(attempt: InteractiveAttemptView): void {
    const reconciliation = attempt.reconciliation;
    if (reconciliation !== null && reconciliation.outcome !== "live") {
      throw new AttemptNotControllableError(
        attempt.attemptId,
        reconciliation.detail ?? `pane reconciled ${reconciliation.outcome}`,
      );
    }
  }

  private retryAuthorized(run: RunView, parentAttemptId: string): boolean {
    return pendingRetries(run, parentAttemptId) > 0;
  }

  private async recordAdvisory(
    runId: string,
    laneId: string,
    attempt: InteractiveAttemptView,
    status: AdvisoryAgentStatus,
    message: string | null,
    source: "herdr-detection" | "runtime-published" = "herdr-detection",
  ): Promise<void> {
    await this.commit(runId, {
      type: status === "blocked" ? "lane_blocked_observed" : "lane_advisory_state_observed",
      actor: "runtime",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        status,
        source,
        paneId: attempt.paneId,
        message,
      },
    });
  }

  private attemptsOf(
    run: RunView,
    laneId: string,
  ): readonly InteractiveAttemptView[] {
    return run.interactiveAttemptOrder
      .map((id) => run.interactiveAttempts[id]!)
      .filter((attempt) => attempt.laneId === laneId);
  }

  private attempt(run: RunView, attemptId: string): InteractiveAttemptView {
    const attempt = run.interactiveAttempts[attemptId];
    if (!attempt) throw new Error(`unknown attemptId "${attemptId}"`);
    return attempt;
  }

  private async liveAttempt(
    runId: string,
    laneId: string,
    attemptId?: string,
  ): Promise<{ readonly run: RunView; readonly attempt: InteractiveAttemptView }> {
    const run = await this.reload(runId);
    if (attemptId !== undefined) {
      return { run, attempt: this.attempt(run, attemptId) };
    }
    const attempts = this.attemptsOf(run, laneId);
    const current = attempts.at(-1);
    if (!current) throw new Error(`lane "${laneId}" has no attempt`);
    return { run, attempt: current };
  }

  private lane(run: RunView, laneId: string) {
    const lane = run.lanes[laneId];
    if (!lane) throw new Error(`unknown laneId "${laneId}"`);
    return lane;
  }

  private async reload(runId: string): Promise<RunView> {
    const inFlight = this.commitTails.get(runId);
    if (inFlight) await inFlight;
    const loaded = await this.deps.ledger.load(runId);
    if (!loaded) throw new Error(`run not found: "${runId}"`);
    this.runs.set(runId, loaded);
    return loaded;
  }

  /** Commits are serialized per run: one run never overtakes itself. */
  private commit(runId: string, input: NewRunEvent): Promise<RunView> {
    const prior = this.commitTails.get(runId) ?? Promise.resolve();
    const transition = prior.then(async () => {
      const current = this.runs.get(runId);
      const sequence = (current?.lastAppliedSequence ?? 0) + 1;
      const event = {
        schemaVersion: 1,
        eventId: `${runId}#${sequence}`,
        runId,
        sequence,
        at: this.deps.clock(),
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

  private async read(path: string): Promise<string> {
    if (this.deps.readDurable) return this.deps.readDurable(path);
    return Bun.file(path).text();
  }

  private async write(path: string, text: string): Promise<void> {
    if (this.deps.writeDurable) return this.deps.writeDurable(path, text);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  }

  /** The controller lease, reused unchanged from the read-only runtime. */
  async acquireLease(runId: string): Promise<void> {
    if (this.leases.has(runId)) return;
    this.leases.set(
      runId,
      await this.deps.ledger.acquireLease(runId, {
        controllerId: `interactive-${process.pid}`,
        pid: process.pid,
      }),
    );
  }

  async releaseLease(runId: string): Promise<void> {
    const lease = this.leases.get(runId);
    if (!lease) return;
    await lease.release();
    this.leases.delete(runId);
  }
}

/**
 * How many retries a human has authorized past `parentAttemptId` that no
 * attempt has consumed yet. One authorization buys exactly one attempt, so a
 * second retry needs a second authorization — there is no path from a failure
 * to a new attempt that does not pass through a human.
 */
export function pendingRetries(run: RunView, parentAttemptId: string): number {
  const authorized = run.retryAuthorizations.filter(
    (id) => id === parentAttemptId,
  ).length;
  const consumed = Object.values(run.interactiveAttempts).filter(
    (attempt) => attempt.parentAttemptId === parentAttemptId,
  ).length;
  return authorized - consumed;
}

/** Read STATUS from an agent-authored checkpoint; null when it has none. */
function parseAgentStatus(
  text: string,
): "working" | "complete" | "partial" | "blocked" | "unknown" | null {
  const match = text.match(/^STATUS:\s*(\w+)/m);
  const status = match?.[1];
  if (status === undefined) return null;
  const allowed = ["working", "complete", "partial", "blocked", "unknown"];
  return allowed.includes(status)
    ? (status as "working" | "complete" | "partial" | "blocked" | "unknown")
    : null;
}
