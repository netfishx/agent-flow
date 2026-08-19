// The interactive write lane's control plane.
//
// It is a peer of `WorkflowRuntime`, not an extension of it: the read-only
// runtime accepted in #7 is untouched, and this class reuses the mechanisms
// rather than the code path — the same Herdr adapter for pane topology and
// process facts, the same ledger and reducer, the same controller lease, the
// same takeover events, and the same sentinel contract from `runtime/ids.ts`.
//
// Four rules run through every method here:
//
//   - a control is a HUMAN act. Nothing on this class issues a steer, cancel,
//     abort, or retry on its own, and no method retries anything.
//   - every mutating operation holds the run's controller lease and is
//     serialized per run, so a check and the commit it authorizes cannot be
//     split by a concurrent caller.
//   - a control records its INTENT before the Herdr call and its DELIVERY
//     after. A failed observation never erases either.
//   - advisory Herdr state is recorded, never consumed as an outcome.

import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { HerdrAdapter } from "../herdr/adapter.ts";
import type { HerdrAgentControl } from "../herdr/agent-control.ts";
import {
  agentNameFor,
  AGENT_START_TIMEOUT_DEFAULT_MS,
} from "../herdr/agent-argv.ts";
import type { Ledger } from "../runtime/ledger.ts";
import type { NewRunEvent, RunEvent, SemanticState } from "../runtime/events.ts";
import { reduce, type LaneView, type RunView } from "../runtime/reducer.ts";
import {
  assertHandleId,
  sentinelRegex,
  parseSentinelExit,
} from "../runtime/ids.ts";
import type { SessionIdentity } from "../review/types.ts";
import { buildNativeArgs, buildRunnerCommand } from "./commands.ts";
import type { WriteLaneIsolationPort } from "./isolation.ts";
import type { AgentInfoView } from "../herdr/agent-json.ts";
import type {
  AdvisoryAgentStatus,
  ControlDeliveryState,
  ControlRecord,
  DeliveredControl,
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

/** Raised when a retry is requested without an unconsumed human authorization. */
export class RetryNotAuthorizedError extends Error {
  constructor(laneId: string) {
    super(
      `lane "${laneId}" has no unconsumed retry authorization: one authorization creates one attempt`,
    );
    this.name = "RetryNotAuthorizedError";
  }
}

/**
 * Raised when a control is attempted on an attempt that registered but has not
 * bound an agent yet — the window a controller crash between `started` and
 * `bound` leaves behind. Nothing is probed and nothing is reconciled: a pane
 * whose agent has not started is not evidence that the agent is gone.
 */
export class WriteLaneIsolationError extends Error {
  constructor(worktreePath: string, reason: string) {
    super(`write lane worktree "${worktreePath}" is not isolated: ${reason}`);
    this.name = "WriteLaneIsolationError";
  }
}

export class AttemptNotBoundError extends Error {
  constructor(attemptId: string) {
    super(
      `attempt "${attemptId}" has not bound an agent yet: it is starting, so it is neither controllable nor probeable`,
    );
    this.name = "AttemptNotBoundError";
  }
}

/**
 * Raised when a control is attempted on an attempt that may not be controlled:
 * it has ended, or its pane is gone, occupied by a stranger, or unprobeable.
 * Thrown BEFORE any Herdr side effect, so nothing reaches a pane the runtime
 * does not own and nothing reaches a session that already finished.
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
  /** Write-lane preflight: proves the worktree is this repository's, and linked. */
  readonly isolation: WriteLaneIsolationPort;
  /** Root each attempt's declared brief/checkpoint/result paths hang under. */
  readonly artifactRoot: string;
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
}

export interface OpenLaneConfig {
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly laneId: string;
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  /** The lane's isolated implementation worktree. Verified before anything. */
  readonly worktreePath: string;
  /** The repository the worktree must belong to. */
  readonly repoRoot: string;
  readonly role?: string;
}

export interface StartAttemptInput {
  /** The brief, delivered as the FIRST agent prompt, not as a CLI argument. */
  readonly brief: string;
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
  /** Defaults to a path under the attempt's artifact directory. */
  readonly logFile?: string;
  /** Defaults to the attempt's worktree. */
  readonly cwd?: string;
}

/** The declared paths an attempt writes to. Derived, never caller-supplied. */
export function attemptArtifactPaths(
  artifactRoot: string,
  attemptId: string,
): {
  readonly briefFile: string;
  readonly checkpointFile: string;
  readonly resultPointer: string;
  readonly runnerLog: (evidenceId: string) => string;
} {
  const dir = join(artifactRoot, "attempts", attemptId);
  return {
    briefFile: join(dir, "brief.md"),
    checkpointFile: join(dir, "checkpoint.md"),
    resultPointer: join(dir, "result.md"),
    runnerLog: (evidenceId) => join(dir, `runner-${evidenceId}.log`),
  };
}

/** What a pane probe concluded, plus the record that proved it when live. */
interface ProbeResult {
  readonly outcome: ReconciliationOutcome;
  readonly paneId: string;
  readonly detail: string | null;
  readonly observed: AgentInfoView | null;
}

const DEFAULT_STEER_WAIT_MS = 5_000;
const DEFAULT_RUNNER_TIMEOUT_MS = 300_000;

export class InteractiveLaneController {
  private readonly runs = new Map<string, RunView>();
  /** One chain per run: every read and every mutation queues on it. */
  private readonly runTails = new Map<string, Promise<unknown>>();

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
    // Preflight FIRST: no tab, no pane, no event, no agent until the worktree
    // is proved to be a linked worktree of the declared repository. A write
    // lane is handed permission to change that directory.
    const isolation = await this.deps.isolation.verifyWriteWorktree({
      repoRoot: config.repoRoot,
      worktreePath: config.worktreePath,
    });
    if (!isolation.ok) {
      throw new WriteLaneIsolationError(config.worktreePath, isolation.reason);
    }
    // From here the caller's path is never used again. Verification resolved
    // symlinks to reach its verdict, so recording or executing against the
    // unresolved path would let a later re-point move the Agent somewhere
    // nothing was ever checked.
    const worktreePath = isolation.canonicalWorktreePath;
    const repoRoot = isolation.canonicalRepoRoot;
    const runId = this.deps.idgen();
    assertHandleId("runId", runId);
    const created = await this.deps.adapter.createTab({
      workspace: config.workspace,
      cwd: config.cwd,
      label: config.workflow,
    });
    return this.mutate(runId, async (commit) => {
      await commit({
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
      await commit({
        type: "lane_registered",
        actor: "runtime",
        laneId: config.laneId,
        data: {
          kind: "interactive",
          laneId: config.laneId,
          paneId: created.controllerPane.id,
          agentKind: config.agentKind,
          model: config.model,
          effort: config.effort,
          worktreePath,
          repoRoot,
          artifactRoot: join(this.deps.artifactRoot, runId, config.laneId),
          ...(config.role === undefined ? {} : { role: config.role }),
        },
      });
      return { runId, laneId: config.laneId };
    }, { creates: true });
  }

  /**
   * Start one attempt: the RUNTIME provisions the pane, then Herdr starts or
   * recognizes the interactive agent in it. `herdr agent start` never creates,
   * splits, or moves layout, so pane topology stays this side of the seam.
   *
   * The authorization check, the pane, and the attempt record are committed
   * inside ONE lease-held critical section, so two concurrent retries on one
   * authorization cannot both pass the check.
   */
  async startAttempt(
    runId: string,
    laneId: string,
    input: StartAttemptInput,
  ): Promise<StartAttemptOutcome> {
    const parentAttemptId = input.parentAttemptId ?? null;
    return this.mutate(runId, async (commit, run) => {
      const lane = this.lane(run, laneId);
      if (lane.kind !== "interactive") {
        throw new Error(`lane "${laneId}" is not an interactive write lane`);
      }
      // Checked INSIDE the critical section, immediately before the commit
      // that consumes it. One authorization can therefore buy one attempt.
      if (parentAttemptId !== null && pendingRetries(run, parentAttemptId) <= 0) {
        throw new RetryNotAuthorizedError(laneId);
      }
      const attemptId = this.deps.idgen();
      assertHandleId("attemptId", attemptId);
      const expectedAgentName = agentNameFor(laneId, attemptId);

      // A NEW pane per attempt: a retry never resumes, impersonates, or
      // replaces a prior session, so it never reuses that session's pane.
      const pane = await this.deps.adapter.splitPane({
        from: { id: run.controllerPaneId },
        direction: "right",
        cwd: lane.worktreePath ?? run.cwd,
      });
      const paths = attemptArtifactPaths(lane.artifactRoot!, attemptId);
      await this.write(paths.briefFile, input.brief);
      await commit({
        type: "interactive_attempt_started",
        actor: "runtime",
        laneId,
        data: {
          attemptId,
          ordinal: this.attemptsOf(run, laneId).length + 1,
          parentAttemptId,
          agentKind: lane.agentKind as InteractiveAgentKind,
          model: lane.model ?? "",
          effort: lane.effort ?? "",
          paneId: pane.id,
          expectedAgentName,
          worktreePath: lane.worktreePath ?? run.cwd,
          briefFile: paths.briefFile,
          checkpointFile: paths.checkpointFile,
          resultPointer: paths.resultPointer,
          authorization: { actor: "human", note: input.authorization.note },
        },
      });

      const agentKind = lane.agentKind as InteractiveAgentKind;
      const preassigned =
        agentKind === "codex" ? null : (this.deps.sessionIdgen?.() ?? null);
      const nativeArgs =
        input.nativeArgs ??
        buildNativeArgs({
          agentKind,
          model: lane.model ?? "",
          effort: lane.effort ?? "",
          sessionId: preassigned,
        });
      const name = expectedAgentName;
      const startedAt = this.deps.clock();
      let started;
      try {
        started = await this.deps.agentControl.startAgent({
          name,
          kind: agentKind,
          paneId: pane.id,
          timeoutMs: this.deps.startTimeoutMs ?? AGENT_START_TIMEOUT_DEFAULT_MS,
          nativeArgs,
        });
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        // A start failure is an END, with its cause. It is never a retry: only
        // a human authorization creates another attempt.
        await commit({
          type: "interactive_attempt_ended",
          actor: "runtime",
          laneId,
          data: { attemptId, endReason: "start-failed", cause, exitCode: null },
        });
        return { attemptId, started: false, startFailure: cause };
      }

      await commit({
        type: "interactive_attempt_bound",
        actor: "runtime",
        laneId,
        data: {
          attemptId,
          agentName: started.agent.name ?? name,
          session: sessionIdentityOf(
            agentKind,
            started.agent.sessionId,
            preassigned,
          ),
          argv: started.argv,
          readinessMs: this.deps.clock() - startedAt,
        },
      });

      // The brief is the first prompt, submitted under the SAME lease: an
      // interactive session has no one-shot prompt-file equivalent that also
      // leaves it steerable, and releasing here would expose an attempt that
      // is bound but has never been told what to do.
      const bound = this.attempt(this.runs.get(runId)!, attemptId);
      await this.submitSteer(commit, laneId, bound, input.brief);
      return { attemptId, started: true, startFailure: null };
    });
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
    return this.mutate(runId, async (commit, run) => {
      const attempt = this.targetAttempt(run, laneId, options.attemptId);
      this.assertNotTakenOver(run, laneId);
      this.assertControllable(attempt);
      return this.submitSteer(commit, laneId, attempt, text);
    });
  }

  /**
   * The one steer path, shared by `steer` and the brief the attempt starts
   * with. Submission is recorded BEFORE the call, so a controller that dies
   * mid-call still leaves the intent in the ledger; the transition afterwards
   * is a separate observation. Neither says the steer was applied and neither
   * says the work finished — `--wait` tracks lifecycle state, not turns.
   */
  private async submitSteer(
    commit: (input: NewRunEvent) => Promise<RunView>,
    laneId: string,
    attempt: InteractiveAttemptView,
    text: string,
  ): Promise<SteerObservation> {
    const target = this.targetOf(attempt);
    await commit({
      type: "lane_steer_submitted",
      actor: "human",
      laneId,
      data: { attemptId: attempt.attemptId, text, paneId: attempt.paneId, target },
    });
    const result = await this.deps.agentControl.promptAgent(target, text, {
      waitMs: this.deps.steerWaitMs ?? DEFAULT_STEER_WAIT_MS,
    });
    const observedStatus = result.agent?.status ?? null;
    await commit({
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
              source: "herdr-detection" as const,
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
    options: {
      readonly attemptId?: string;
      readonly keys?: readonly string[];
    } = {},
  ): Promise<AdvisoryAgentStatus | null> {
    return this.mutate(runId, async (commit, run) => {
      const attempt = this.targetAttempt(run, laneId, options.attemptId);
      this.assertNotTakenOver(run, laneId);
      this.assertControllable(attempt);
      const target = this.targetOf(attempt);
      const keys = options.keys ?? ["esc"];
      const controlId = this.deps.idgen();

      await commit({
        type: "lane_cancel_turn",
        actor: "human",
        laneId,
        data: {
          attemptId: attempt.attemptId,
          controlId,
          method: "send-keys",
          keys: [...keys],
        },
      });

      const { error, ...delivery } = await this.deliver(
        () => this.deps.agentControl.sendKeys(target, keys),
        target,
      );
      await commit({
        type: "lane_control_delivered",
        actor: "runtime",
        laneId,
        data: {
          attemptId: attempt.attemptId,
          controlId,
          control: "cancel-turn",
          method: "send-keys",
          ...delivery,
        },
      });
      if (error) throw error;
      return delivery.observedStatus;
    });
  }

  /**
   * End the session by signalling the pane's foreground process group — the
   * existing interrupt path, reused unchanged.
   *
   * The pane is PROBED first: an attempt whose pane is gone, reoccupied, or
   * unprobeable is refused before any signal is sent, because that signal
   * would reach a process group the runtime does not own.
   */
  async abortSession(
    runId: string,
    laneId: string,
    options: { readonly attemptId?: string } = {},
  ): Promise<void> {
    await this.mutate(runId, async (commit, run) => {
      const attempt = this.targetAttempt(run, laneId, options.attemptId);
      this.assertControllable(attempt);

      const controlId = this.deps.idgen();
      const probe = await this.probePane(attempt);
      if (probe.outcome !== "live") {
        await commit({
          type: "interactive_attempt_reconciled",
          actor: "runtime",
          laneId,
          data: {
            attemptId: attempt.attemptId,
            outcome: probe.outcome,
            paneId: probe.paneId,
            detail: probe.detail,
          },
        });
        throw new AttemptNotControllableError(
          attempt.attemptId,
          probe.detail ?? `pane probed ${probe.outcome}`,
        );
      }

      await commit({
        type: "lane_abort_session",
        actor: "human",
        laneId,
        data: {
          attemptId: attempt.attemptId,
          controlId,
          method: "signal-process-group",
        },
      });

      // An undelivered signal is an OBSERVATION, not a failure: the pane's
      // foreground group being back at the shell means the session was already
      // gone. The attempt still ends, and the cause says which of the two
      // happened, so `aborted` never implies a signal that was not sent.
      let signalDetail: string | null = null;
      const { error, ...delivery } = await this.deliver(async () => {
        const evidence = await this.deps.adapter.interruptPane({
          id: attempt.paneId,
        });
        if (!evidence.delivered) {
          signalDetail = `${evidence.signal} was not delivered: the pane had no foreground process group of its own`;
        }
      }, this.targetOf(attempt));
      await commit({
        type: "lane_control_delivered",
        actor: "runtime",
        laneId,
        data: {
          attemptId: attempt.attemptId,
          controlId,
          control: "abort-session",
          method: "signal-process-group",
          ...delivery,
          detail: signalDetail ?? delivery.detail,
        },
      });
      if (delivery.delivered) {
        await commit({
          type: "interactive_attempt_ended",
          actor: "runtime",
          laneId,
          data: {
            attemptId: attempt.attemptId,
            endReason: "aborted",
            cause: signalDetail,
            // No exit code is invented: the signal went to a process group,
            // and Herdr exposes no exit code on any surface.
            exitCode: null,
          },
        });
      }
      if (error) throw error;
    });
  }

  /** Human ownership of the lane's input channel. Reuses the shipped events. */
  async takeover(runId: string, laneId: string): Promise<void> {
    await this.mutate(runId, (commit) =>
      commit({ type: "lane_takeover", actor: "human", laneId, data: {} }),
    );
  }

  async release(runId: string, laneId: string): Promise<void> {
    await this.mutate(runId, (commit) =>
      commit({ type: "lane_release", actor: "human", laneId, data: {} }),
    );
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
    await this.mutate(runId, (commit) =>
      commit({
        type: "interactive_retry_authorized",
        actor: "human",
        laneId,
        data: { parentAttemptId, note },
      }),
    );
  }

  // ------------------------------------------------------------- observations

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
    return this.mutate(runId, async (commit, run) => {
      const attempt = this.targetAttempt(run, laneId, options.attemptId);
      const observed = await this.deps.agentControl.waitForState(
        this.targetOf(attempt),
        ["blocked"],
        timeoutMs,
      );
      if (observed === null) return false;
      await commit(this.advisoryEvent(laneId, attempt, observed.status, null));
      return observed.status === "blocked";
    });
  }

  /** Publish runtime-owned advisory state for the UI. Optional, never evidence. */
  async publishAdvisoryState(
    runId: string,
    laneId: string,
    state: "idle" | "working" | "blocked" | "unknown",
    message?: string,
  ): Promise<void> {
    await this.mutate(runId, async (commit, run) => {
      const attempt = this.targetAttempt(run, laneId);
      await this.deps.agentControl.reportAgentState({
        paneId: attempt.paneId,
        source: advisorySource(runId),
        agent: this.targetOf(attempt),
        state,
        ...(message === undefined ? {} : { message }),
      });
      await commit(
        this.advisoryEvent(
          laneId,
          attempt,
          state,
          message ?? null,
          "runtime-published",
        ),
      );
    });
  }

  async releaseAdvisoryState(runId: string, laneId: string): Promise<void> {
    await this.mutate(runId, async (_commit, run) => {
      const attempt = this.targetAttempt(run, laneId);
      await this.deps.agentControl.releaseAgentState({
        paneId: attempt.paneId,
        source: advisorySource(runId),
        agent: this.targetOf(attempt),
      });
    });
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Reconcile one attempt against the world. Four honest outcomes:
   *
   *   - `live`     — the pane hosts the expected kind; the attempt continues;
   *   - `reoccupied` — the pane hosts something else; fail closed;
   *   - `missing`  — the pane could not be resolved; fail closed, no exit code;
   *   - `unknown-probe` — the probe itself failed, so nothing is known.
   *
   * Repeating this on a LIVE attempt is fine: it is an observation, the
   * projection keeps the latest, and the event log keeps the history. It never
   * revives an ended attempt — the end is what `assertControllable` reads.
   */
  async reconcileAttempt(
    runId: string,
    laneId: string,
    attemptId: string,
  ): Promise<ReconciliationOutcome> {
    return this.mutate(runId, async (commit, run) => {
      const attempt = this.attempt(run, attemptId);
      const probe =
        attempt.agentName === null
          ? await this.probeStartingAttempt(attempt)
          : await this.probePane(attempt);
      await commit({
        type: "interactive_attempt_reconciled",
        actor: "runtime",
        laneId,
        data: {
          attemptId,
          outcome: probe.outcome,
          // Re-read rather than assumed: a pane moved between workspaces gets
          // a new workspace-qualified id.
          paneId: probe.paneId,
          detail: probe.detail,
        },
      });

      // ADOPTION. A controller can die after `agent start` returned and before
      // the bind landed, leaving a real Agent alive under an attempt that has
      // no name. The probe above just proved, by strict pane + kind + expected
      // deterministic name match, that the live agent IS this attempt's — so
      // the attempt is bound from that evidence rather than orphaned.
      if (probe.outcome === "live" && attempt.agentName === null) {
        const observed = probe.observed!;
        await commit({
          type: "interactive_attempt_bound",
          actor: "runtime",
          laneId,
          data: {
            attemptId,
            agentName: observed.name ?? attempt.expectedAgentName,
            session: sessionIdentityOf(
              attempt.agentKind,
              observed.sessionId,
              null,
            ),
            // Herdr does not report the argv of an agent it did not just
            // start, so this records the adoption rather than inventing one.
            argv: [],
            readinessMs: 0,
          },
        });
        // The brief may never have been submitted. It is delivered now, once:
        // an EXISTING submission is left alone even when its observation is
        // unconfirmed, because replaying it could double-instruct the Agent.
        const adopted = this.attempt(this.runs.get(runId)!, attemptId);
        if (adopted.steerSubmissions === 0) {
          const brief = await this.read(adopted.briefFile);
          await this.submitSteer(commit, laneId, adopted, brief);
        }
      }

      // Only a POSITIVE finding ends an attempt. `unknown-probe` means the
      // control plane failed, which is not evidence about the Agent.
      const ends = probe.outcome === "reoccupied" || probe.outcome === "missing";
      if (ends && attempt.endReason === null) {
        await commit({
          type: "interactive_attempt_ended",
          actor: "runtime",
          laneId,
          data: {
            attemptId,
            endReason: "lost",
            cause: probe.detail,
            exitCode: null,
          },
        });
      }
      return probe.outcome;
    });
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
    return this.mutate(runId, async (commit, run) => {
      const attempt = this.attempt(run, attemptId);
      const lane = this.lane(run, laneId);
      const evidenceId = this.deps.idgen();
      assertHandleId("evidenceId", evidenceId);
      const logFile =
        request.logFile ??
        attemptArtifactPaths(lane.artifactRoot!, attemptId).runnerLog(evidenceId);
      const cwd = request.cwd ?? attempt.worktreePath;
      const pane = await this.deps.adapter.splitPane({
        from: { id: run.controllerPaneId },
        direction: "down",
        cwd,
      });
      const command = buildRunnerCommand({
        runId,
        evidenceId,
        cwd,
        logFile,
        argv: request.argv,
      });
      const startedAt = this.deps.clock();
      await this.deps.adapter.runInPane(pane, command);
      await this.deps.adapter.waitForOutput(
        pane,
        sentinelRegex(runId, "RUNNER", evidenceId),
        this.deps.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS,
      );
      const output = await this.read(logFile);
      // The real exit code comes from the durable log's sentinel, never from
      // the wait: a matched pattern says the line was printed, nothing more.
      const exitCode = parseSentinelExit(runId, "RUNNER", evidenceId, output);
      await commit({
        type: "interactive_runner_evidence",
        actor: "runner",
        laneId,
        data: {
          evidenceId,
          attemptId,
          command,
          logFile,
          paneId: pane.id,
          exitCode,
          startedAt,
          endedAt: this.deps.clock(),
        },
      });
      return { evidenceId, exitCode };
    });
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
    return this.mutate(runId, async (commit, run) => {
      const attempt = this.attempt(run, attemptId);
      let text: string | null = null;
      try {
        text = await this.read(attempt.checkpointFile);
      } catch {
        text = null;
      }
      const parsed = text === null ? null : parseAgentStatus(text);
      // No checkpoint: the runtime records `unknown` under its OWN actor and
      // invents no Agent claim.
      await commit({
        type: "lane_checkpoint",
        actor: parsed === null ? "runtime" : "agent",
        laneId,
        data: {
          semanticState: parsed ?? "unknown",
          checkpointFile: attempt.checkpointFile,
          attemptId,
        },
      });
      return parsed === null ? "unknown" : "agent";
    });
  }

  // ------------------------------------------------------------------ readers

  async inspect(runId: string): Promise<RunView> {
    return this.load(runId);
  }

  async attempts(
    runId: string,
    laneId: string,
  ): Promise<readonly InteractiveAttemptView[]> {
    return this.attemptsOf(await this.load(runId), laneId);
  }

  // ---------------------------------------------------------------- internals

  /**
   * Probe the attempt's pane. Distinguishes a Herdr answer ("no such agent")
   * from a Herdr failure ("the probe broke"): only the first is evidence.
   */
  private async probePane(attempt: InteractiveAttemptView): Promise<ProbeResult> {
    let observed;
    try {
      observed = await this.deps.agentControl.getAgent(this.targetOf(attempt));
    } catch (error) {
      return {
        outcome: "unknown-probe",
        paneId: attempt.paneId,
        detail: `the pane could not be probed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        observed: null,
      };
    }
    if (observed !== null) {
      return observed.agent === attempt.agentKind
        ? { outcome: "live", paneId: observed.paneId, detail: null, observed }
        : {
            outcome: "reoccupied",
            paneId: observed.paneId,
            detail: `pane hosts ${observed.agent ?? "an unrecognized occupant"}, expected ${attempt.agentKind}`,
            observed: null,
          };
    }
    try {
      await this.deps.adapter.processInfo({ id: attempt.paneId });
    } catch {
      return {
        outcome: "missing",
        paneId: attempt.paneId,
        detail: "pane could not be resolved",
        observed: null,
      };
    }
    return {
      outcome: "reoccupied",
      paneId: attempt.paneId,
      detail: "the pane no longer hosts the expected agent",
      observed: null,
    };
  }

  /**
   * Probe an attempt that registered but never bound.
   *
   * The lookup is by the DETERMINISTIC name recorded at registration, and the
   * result is accepted only when pane, kind and name all match. Anything else
   * is a stranger's session or a pane that never ran one — never adopted,
   * never prompted, never signalled.
   */
  private async probeStartingAttempt(
    attempt: InteractiveAttemptView,
  ): Promise<ProbeResult> {
    let observed;
    try {
      observed = await this.deps.agentControl.getAgent(
        attempt.expectedAgentName,
      );
    } catch (error) {
      return {
        outcome: "unknown-probe",
        paneId: attempt.paneId,
        detail: `the expected agent could not be looked up: ${
          error instanceof Error ? error.message : String(error)
        }`,
        observed: null,
      };
    }
    if (observed === null) {
      // No agent under this attempt's own name. Ask the pane itself before
      // concluding: something else may be running there, and that is a
      // different fact from nothing having started.
      let occupant;
      try {
        occupant = await this.deps.agentControl.getAgent(attempt.paneId);
      } catch (error) {
        return {
          outcome: "unknown-probe",
          paneId: attempt.paneId,
          detail: `the pane could not be probed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          observed: null,
        };
      }
      if (occupant !== null) {
        return {
          outcome: "reoccupied",
          paneId: occupant.paneId,
          detail: `pane hosts agent "${occupant.name ?? "unnamed"}" (${occupant.agent ?? "unrecognized"}), expected "${attempt.expectedAgentName}"`,
          observed: null,
        };
      }
      // Nothing there. Saying the pane "no longer hosts" this attempt's Agent
      // would describe something that never happened.
      return {
        outcome: "missing",
        paneId: attempt.paneId,
        detail: "the expected agent never started in this pane",
        observed: null,
      };
    }
    if (observed.paneId !== attempt.paneId) {
      return {
        outcome: "reoccupied",
        paneId: attempt.paneId,
        detail: `the expected agent name resolves to pane ${observed.paneId}, not ${attempt.paneId}`,
        observed: null,
      };
    }
    if (observed.agent !== attempt.agentKind) {
      return {
        outcome: "reoccupied",
        paneId: observed.paneId,
        detail: `pane hosts ${observed.agent ?? "an unrecognized occupant"}, expected ${attempt.agentKind}`,
        observed: null,
      };
    }
    if (observed.name !== null && observed.name !== attempt.expectedAgentName) {
      return {
        outcome: "reoccupied",
        paneId: observed.paneId,
        detail: `pane hosts agent "${observed.name}", expected "${attempt.expectedAgentName}"`,
        observed: null,
      };
    }
    return { outcome: "live", paneId: observed.paneId, detail: null, observed };
  }

  /**
   * Carry out a control's effect and then try to observe it. The observation
   * is best-effort by construction: a failed read yields `observedStatus: null`
   * and never prevents the delivery fact from being recorded.
   */
  private async deliver(
    effect: () => Promise<void>,
    target: string,
  ): Promise<{
    readonly delivered: boolean;
    readonly detail: string | null;
    readonly observedStatus: AdvisoryAgentStatus | null;
    readonly error?: Error;
  }> {
    try {
      await effect();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return { delivered: false, detail: failure.message, observedStatus: null, error: failure };
    }
    try {
      const observed = await this.deps.agentControl.getAgent(target);
      return {
        delivered: true,
        detail: null,
        observedStatus: observed?.status ?? null,
      };
    } catch (error) {
      return {
        delivered: true,
        detail: `delivered, but not observed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        observedStatus: null,
      };
    }
  }

  private advisoryEvent(
    laneId: string,
    attempt: InteractiveAttemptView,
    status: AdvisoryAgentStatus,
    message: string | null,
    source: "herdr-detection" | "runtime-published" = "herdr-detection",
  ): NewRunEvent {
    return {
      type: "lane_advisory_state_observed",
      actor: "runtime",
      laneId,
      data: {
        attemptId: attempt.attemptId,
        status,
        source,
        paneId: attempt.paneId,
        message,
      },
    };
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

  /**
   * The single control gate. Terminality is checked FIRST and is permanent: a
   * later `live` observation is still recorded, but it never restores control
   * over an attempt that already ended.
   */
  private assertControllable(attempt: InteractiveAttemptView): void {
    // A registered-but-unbound attempt is STARTING. It is not probed and not
    // reconciled: no agent has been detected there yet, so "the pane does not
    // host the expected agent" would be a conclusion about a race, not a fact.
    if (attempt.agentName === null && attempt.endReason === null) {
      throw new AttemptNotBoundError(attempt.attemptId);
    }
    if (attempt.endReason !== null) {
      throw new AttemptNotControllableError(
        attempt.attemptId,
        `it ended as "${attempt.endReason}"${attempt.endCause === null ? "" : ` (${attempt.endCause})`}`,
      );
    }
    const reconciliation = attempt.reconciliation;
    if (reconciliation !== null && reconciliation.outcome !== "live") {
      throw new AttemptNotControllableError(
        attempt.attemptId,
        reconciliation.detail ?? `pane reconciled ${reconciliation.outcome}`,
      );
    }
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

  private targetAttempt(
    run: RunView,
    laneId: string,
    attemptId?: string,
  ): InteractiveAttemptView {
    if (attemptId !== undefined) return this.attempt(run, attemptId);
    const current = this.attemptsOf(run, laneId).at(-1);
    if (!current) throw new Error(`lane "${laneId}" has no attempt`);
    return current;
  }

  private lane(run: RunView, laneId: string): LaneView {
    const lane = run.lanes[laneId];
    if (!lane) throw new Error(`unknown laneId "${laneId}"`);
    return lane;
  }

  /**
   * Every mutating operation runs here: queued on the run's single chain, and
   * holding the run's controller lease for its whole duration. The `commit` it
   * hands the body appends without re-queueing, so a check and the commit it
   * authorizes are one indivisible step.
   */
  private mutate<T>(
    runId: string,
    body: (
      commit: (input: NewRunEvent) => Promise<RunView>,
      run: RunView,
    ) => Promise<T>,
    options: { readonly creates?: boolean } = {},
  ): Promise<T> {
    return this.serialize(runId, async () => {
      const lease = await this.deps.ledger.acquireLease(runId, {
        controllerId: `interactive-${process.pid}`,
        pid: process.pid,
      });
      try {
        const loaded = await this.deps.ledger.load(runId);
        if (loaded === null && options.creates !== true) {
          throw new Error(`run not found: "${runId}"`);
        }
        if (loaded) this.runs.set(runId, loaded);
        else this.runs.delete(runId);
        const commit = (input: NewRunEvent) => this.append(runId, input);
        return await body(commit, loaded as RunView);
      } finally {
        await lease.release();
      }
    });
  }

  private serialize<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.runTails.get(runId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.runTails.set(runId, tail);
    void tail.then(() => {
      if (this.runTails.get(runId) === tail) this.runTails.delete(runId);
    });
    return next;
  }

  /** Append one event. Only called from inside a `mutate` critical section. */
  private async append(runId: string, input: NewRunEvent): Promise<RunView> {
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
  }

  private load(runId: string): Promise<RunView> {
    return this.serialize(runId, async () => {
      const loaded = await this.deps.ledger.load(runId);
      if (!loaded) throw new Error(`run not found: "${runId}"`);
      this.runs.set(runId, loaded);
      return loaded;
    });
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
}

function advisorySource(runId: string): string {
  return `agent-flow-${runId}`;
}

/**
 * Session identity in the vocabulary the headless lane already uses. A
 * pre-assigned id counts as measured because the flag that carries it is what
 * ties it to this process; anything else says why it is unavailable.
 */
function sessionIdentityOf(
  agentKind: InteractiveAgentKind,
  observed: string | null,
  preassigned: string | null,
): SessionIdentity {
  if (observed !== null) {
    return {
      kind: "measured",
      id: observed,
      evidence: "herdr agent surface reported the session for this pane",
    };
  }
  if (preassigned !== null) {
    return {
      kind: "measured",
      id: preassigned,
      evidence: "pre-assigned via the session-id flag in this attempt's argv",
    };
  }
  return {
    kind: "unavailable",
    reason: `${agentKind} accepts no pre-assigned session id, and Herdr reported none for this pane`,
  };
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

const SEMANTIC_STATES: readonly SemanticState[] = [
  "working",
  "complete",
  "partial",
  "blocked",
  "unknown",
];

/** Read STATUS from an agent-authored checkpoint; null when it has none. */
function parseAgentStatus(text: string): SemanticState | null {
  const status = text.match(/^STATUS:\s*(\w+)/m)?.[1];
  return SEMANTIC_STATES.find((value) => value === status) ?? null;
}


/**
 * What is known about an attempt's latest control. Derived from the intent and
 * its delivery, never stored:
 *
 *   - `none`         — no control was ever requested;
 *   - `unconfirmed`  — a request is recorded and no delivery is; the effect may
 *                      or may not have reached the session, and NOTHING may
 *                      replay it on that basis;
 *   - `delivered`    — the effect landed;
 *   - `failed`       — the effect was attempted and did not land.
 */
export function controlDeliveryState(
  record: ControlRecord,
): ControlDeliveryState {
  if (record.delivery === null) return "unconfirmed";
  return record.delivery.delivered ? "delivered" : "failed";
}

/**
 * Controls whose delivery never landed. They are kept, never replayed, and
 * never erased by a later control: the effect may have reached the session,
 * and only a human can decide what to do about that.
 */
export function unresolvedControls(
  attempt: InteractiveAttemptView,
): readonly ControlRecord[] {
  return attempt.controls.filter((record) => record.delivery === null);
}

/** The most recent control, or null when none was ever requested. */
export function latestControl(
  attempt: InteractiveAttemptView,
): ControlRecord | null {
  return attempt.controls.at(-1) ?? null;
}
