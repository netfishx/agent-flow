// Herdr's agent surface, expressed as argv arrays. Same rule as `./argv.ts`:
// nothing here builds a shell string, so a prompt's text — which is arbitrary
// human input — is passed as one argument and never re-parsed by a shell.

import type {
  AdvisoryAgentStatus,
  InteractiveAgentKind,
} from "../interactive/types.ts";

/** Herdr's documented agent-name grammar. A name is not a durable handle. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** `herdr agent start --timeout` accepts 1..300000ms; the default is 30000. */
export const AGENT_START_TIMEOUT_CEILING_MS = 300_000;
export const AGENT_START_TIMEOUT_DEFAULT_MS = 30_000;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME.test(name);
}

/**
 * Derive a Herdr agent name from a lane and attempt. The name is only a
 * live-lookup convenience: the ledger keys work on runId/laneId/attemptId, and
 * Herdr clears the name when the agent exits, is released, or is replaced.
 */
export function agentNameFor(laneId: string, attemptId: string): string {
  const slug = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  const lane = slug(laneId).slice(0, 14);
  const attempt = slug(attemptId).slice(0, 14);
  const name = `f-${lane}-${attempt}`.replace(/-+/g, "-").slice(0, 32);
  const trimmed = name.replace(/-+$/, "");
  if (!isValidAgentName(trimmed)) {
    throw new Error(`cannot derive a valid agent name from "${laneId}"/"${attemptId}"`);
  }
  return trimmed;
}

function requireName(name: string): string {
  if (!isValidAgentName(name)) {
    throw new Error(
      `invalid agent name "${name}": expected ${AGENT_NAME.source}`,
    );
  }
  return name;
}

export interface AgentStartOptions {
  readonly name: string;
  readonly kind: InteractiveAgentKind;
  readonly paneId: string;
  /** Readiness window; Herdr defaults to 30000ms and caps at 300000ms. */
  readonly timeoutMs?: number;
  /** The CLI's own argv, passed after `--`. */
  readonly nativeArgs?: readonly string[];
}

export function agentStartArgv(options: AgentStartOptions): string[] {
  const argv = [
    "agent",
    "start",
    requireName(options.name),
    "--kind",
    options.kind,
    "--pane",
    options.paneId,
  ];
  if (options.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > AGENT_START_TIMEOUT_CEILING_MS
    ) {
      throw new Error(
        `agent start timeout must be 1..${AGENT_START_TIMEOUT_CEILING_MS}ms`,
      );
    }
    argv.push("--timeout", String(options.timeoutMs));
  }
  const nativeArgs = options.nativeArgs ?? [];
  if (nativeArgs.length > 0) argv.push("--", ...nativeArgs);
  return argv;
}

export interface AgentPromptOptions {
  /**
   * Wait for the first state observed after submission, capped at this many
   * milliseconds. The return is an observation of a lifecycle transition — it
   * is NOT evidence the instruction was applied, and never that work finished.
   */
  readonly waitMs?: number;
  readonly until?: readonly AdvisoryAgentStatus[];
}

export function agentPromptArgv(
  target: string,
  text: string,
  options: AgentPromptOptions = {},
): string[] {
  const argv = ["agent", "prompt", target, text];
  if (options.waitMs === undefined) return argv;
  argv.push("--wait");
  for (const status of options.until ?? []) argv.push("--until", status);
  argv.push("--timeout", String(options.waitMs));
  return argv;
}

export function agentSendKeysArgv(
  target: string,
  keys: readonly string[],
): string[] {
  if (keys.length === 0) throw new Error("send-keys requires at least one key");
  return ["agent", "send-keys", target, ...keys];
}

export function agentWaitArgv(
  target: string,
  until: readonly AdvisoryAgentStatus[],
  timeoutMs: number,
): string[] {
  const argv = ["agent", "wait", target];
  for (const status of until) argv.push("--until", status);
  argv.push("--timeout", String(timeoutMs));
  return argv;
}

export function agentGetArgv(target: string): string[] {
  return ["agent", "get", target];
}

/**
 * State the runtime PUBLISHES for the Herdr UI. `done` is deliberately absent
 * from Herdr's own accepted values here: it is a human-attention fact the UI
 * derives, not a state any source may assert.
 */
export type PublishableAgentStatus = Exclude<AdvisoryAgentStatus, "done">;

export interface PaneReportAgentOptions {
  readonly paneId: string;
  readonly source: string;
  readonly agent: string;
  readonly state: PublishableAgentStatus;
  readonly message?: string;
}

export function paneReportAgentArgv(
  options: PaneReportAgentOptions,
): string[] {
  const argv = [
    "pane",
    "report-agent",
    "--source",
    options.source,
    "--agent",
    options.agent,
    "--state",
    options.state,
  ];
  if (options.message !== undefined) argv.push("--message", options.message);
  argv.push(options.paneId);
  return argv;
}

export function paneReleaseAgentArgv(options: {
  readonly paneId: string;
  readonly source: string;
  readonly agent: string;
}): string[] {
  return [
    "pane",
    "release-agent",
    "--source",
    options.source,
    "--agent",
    options.agent,
    options.paneId,
  ];
}
