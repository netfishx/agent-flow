// Real implementation of the agent-control port. Deliberately does not reuse
// `RealHerdrAdapter`'s private spawn helper: the read-only adapter is accepted
// work this ticket does not modify, so the fifteen lines are duplicated rather
// than refactored across that boundary.

import {
  agentGetArgv,
  agentPromptArgv,
  agentSendKeysArgv,
  agentStartArgv,
  agentWaitArgv,
  paneReleaseAgentArgv,
  paneReportAgentArgv,
  type AgentPromptOptions,
  type AgentStartOptions,
  type PaneReportAgentOptions,
} from "./agent-argv.ts";
import {
  parseAgentInfo,
  parseAgentPrompted,
  parseAgentStarted,
  type AgentInfoView,
  type AgentStartedView,
} from "./agent-json.ts";
import type { AgentPromptResult, HerdrAgentControl } from "./agent-control.ts";
import { parseHerdrError } from "./json.ts";
import type { AdvisoryAgentStatus } from "../interactive/types.ts";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RealHerdrAgentControlOptions {
  readonly binary?: string;
}

/**
 * The only Herdr error codes this port interprets rather than raises. Each one
 * is observed, not assumed:
 *
 *   - `agent_prompt_stalled` and `timeout` are documented in
 *     `herdr agent prompt --help` on the installed 0.8.0 binary;
 *   - `agent_not_found` is what `herdr agent get <missing>` actually returns:
 *     `{"error":{"code":"agent_not_found","message":"agent target … not found"}}`.
 *
 * Anything else is a control-plane failure and is thrown. An unclassified
 * error must never be read as "the Agent is gone": a broken probe knows
 * nothing about the session, and pretending otherwise would let a socket
 * hiccup end an attempt that is still running.
 */
const STALLED = "agent_prompt_stalled";
const TIMEOUT = "timeout";
const AGENT_ABSENT = "agent_not_found";

export class RealHerdrAgentControl implements HerdrAgentControl {
  private readonly binary: string;

  constructor(options: RealHerdrAgentControlOptions = {}) {
    this.binary = options.binary ?? "herdr";
  }

  private async run(argv: readonly string[]): Promise<CommandResult> {
    const proc = Bun.spawn([this.binary, ...argv], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  private async runOk(argv: readonly string[]): Promise<string> {
    const { stdout, stderr, exitCode } = await this.run(argv);
    if (exitCode !== 0) {
      const error = parseHerdrError(stderr);
      throw new Error(
        `herdr ${argv.join(" ")} failed (exit ${exitCode}): ${
          error
            ? `${error.code}: ${error.message}`
            : stderr.trim() || stdout.trim() || "no output"
        }`,
      );
    }
    return stdout;
  }

  async startAgent(options: AgentStartOptions): Promise<AgentStartedView> {
    return parseAgentStarted(await this.runOk(agentStartArgv(options)));
  }

  async promptAgent(
    target: string,
    text: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentPromptResult> {
    const { stdout, stderr, exitCode } = await this.run(
      agentPromptArgv(target, text, options),
    );
    if (exitCode === 0) {
      // Without --wait there is nothing to observe: submission happened, and
      // that is all this call may be read as.
      if (options.waitMs === undefined) {
        return { outcome: "not-observed", agent: null };
      }
      return { outcome: "state-observed", agent: parseAgentPrompted(stdout) };
    }
    const error = parseHerdrError(stderr);
    if (error?.code === STALLED) return { outcome: "stalled", agent: null };
    if (error?.code === TIMEOUT) return { outcome: "timeout", agent: null };
    throw new Error(
      `herdr agent prompt failed (exit ${exitCode}): ${
        error ? `${error.code}: ${error.message}` : stderr.trim() || "no output"
      }`,
    );
  }

  async sendKeys(target: string, keys: readonly string[]): Promise<void> {
    await this.runOk(agentSendKeysArgv(target, keys));
  }

  async waitForState(
    target: string,
    until: readonly AdvisoryAgentStatus[],
    timeoutMs: number,
  ): Promise<AgentInfoView | null> {
    const { stdout, stderr, exitCode } = await this.run(
      agentWaitArgv(target, until, timeoutMs),
    );
    if (exitCode === 0) return parseAgentInfo(stdout);
    const error = parseHerdrError(stderr);
    if (error?.code === TIMEOUT) return null;
    throw new Error(
      `herdr agent wait failed (exit ${exitCode}): ${
        error ? `${error.code}: ${error.message}` : stderr.trim() || "no output"
      }`,
    );
  }

  async getAgent(target: string): Promise<AgentInfoView | null> {
    const { stdout, stderr, exitCode } = await this.run(agentGetArgv(target));
    if (exitCode === 0) return parseAgentInfo(stdout);
    const error = parseHerdrError(stderr);
    // A dead session simply has no record: agent state is live-only. Only
    // Herdr SAYING so counts; a failure to ask counts as nothing.
    if (error?.code === AGENT_ABSENT) return null;
    throw new Error(
      `herdr agent get failed (exit ${exitCode}): ${
        error ? `${error.code}: ${error.message}` : stderr.trim() || "no output"
      }`,
    );
  }

  async reportAgentState(options: PaneReportAgentOptions): Promise<void> {
    await this.runOk(paneReportAgentArgv(options));
  }

  async releaseAgentState(options: {
    readonly paneId: string;
    readonly source: string;
    readonly agent: string;
  }): Promise<void> {
    // MEASURED on the installed 0.8.2, not inferred from `agent get`: releasing
    // a source for an agent Herdr has no record of exits 0 with empty stdout
    // and empty stderr, and repeating it exits 0 again. So the idempotence this
    // needs is the plain success path, and there is no absent-agent error code
    // to classify. A nonexistent PANE is a different answer and stays a
    // failure: it returns `pane_not_found`, which this must not swallow.
    await this.runOk(paneReleaseAgentArgv(options));
  }
}
