// Parsers for Herdr's agent responses. Same discipline as `./json.ts`: one
// place, loud failure, no coercion. An unrecognized `agent_status` is an error
// rather than a silent `unknown`, because a misparsed advisory state that
// looked plausible would be worse than one that stops the call.

import { HerdrParseError } from "./json.ts";
import type { AdvisoryAgentStatus } from "../interactive/types.ts";

/** What `agent get` / `agent start` / `agent prompt` report about an agent. */
export interface AgentInfoView {
  readonly paneId: string;
  readonly name: string | null;
  /** The detected agent kind label, e.g. "claude"; null when unclassified. */
  readonly agent: string | null;
  readonly status: AdvisoryAgentStatus;
  readonly interactiveReady: boolean;
  readonly launchPending: boolean;
  /** Session id when a source published one; explicitly null otherwise. */
  readonly sessionId: string | null;
}

export interface AgentStartedView {
  readonly agent: AgentInfoView;
  /** The argv Herdr actually launched; recorded verbatim as a start fact. */
  readonly argv: readonly string[];
}

const STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(command: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HerdrParseError(command, raw);
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function agentInfoFrom(
  command: string,
  raw: string,
  value: unknown,
): AgentInfoView {
  if (!isRecord(value)) throw new HerdrParseError(command, raw);
  const paneId = value.pane_id;
  const status = value.agent_status;
  if (typeof paneId !== "string" || typeof status !== "string") {
    throw new HerdrParseError(command, raw);
  }
  if (!STATUSES.has(status)) throw new HerdrParseError(command, raw);
  const session = value.agent_session;
  return {
    paneId,
    name: nullableString(value.name),
    agent: nullableString(value.agent),
    status: status as AdvisoryAgentStatus,
    interactiveReady: value.interactive_ready === true,
    launchPending: value.launch_pending === true,
    sessionId: isRecord(session) ? nullableString(session.value) : null,
  };
}

function resultOf(command: string, raw: string, expected: string): unknown {
  const root = parseJson(command, raw);
  const result = isRecord(root) ? root.result : undefined;
  if (!isRecord(result) || result.type !== expected) {
    throw new HerdrParseError(command, raw);
  }
  return result;
}

export function parseAgentInfo(raw: string): AgentInfoView {
  const result = resultOf("agent get", raw, "agent_info");
  return agentInfoFrom(
    "agent get",
    raw,
    (result as Record<string, unknown>).agent,
  );
}

export function parseAgentPrompted(raw: string): AgentInfoView {
  const result = resultOf("agent prompt", raw, "agent_prompted");
  return agentInfoFrom(
    "agent prompt",
    raw,
    (result as Record<string, unknown>).agent,
  );
}

export function parseAgentStarted(raw: string): AgentStartedView {
  const result = resultOf("agent start", raw, "agent_started") as Record<
    string,
    unknown
  >;
  const argv = result.argv;
  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) {
    throw new HerdrParseError("agent start", raw);
  }
  return {
    agent: agentInfoFrom("agent start", raw, result.agent),
    argv: argv as string[],
  };
}

export function parseAgentList(raw: string): readonly AgentInfoView[] {
  const result = resultOf("agent list", raw, "agent_list") as Record<
    string,
    unknown
  >;
  const agents = result.agents;
  if (!Array.isArray(agents)) throw new HerdrParseError("agent list", raw);
  return agents.map((entry) => agentInfoFrom("agent list", raw, entry));
}
