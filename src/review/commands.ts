// Agent lane command construction. Like the simulated lane, the dispatched
// command is ONE already-quoted line: a fixed wrapper script plus centrally
// quoted positional arguments, followed by the CLI's own argv executed as
// "$@" (no eval, no re-parsing). The wrapper routes streams so that:
//   - the raw-report file receives ONLY the CLI's stdout bytes (rawMode=tee),
//   - stderr reaches both the pane and the durable stderr artifact,
//   - the durable log receives banners, CLI stdout, and the sentinel,
//   - the sentinel carries the CLI's real exit code (SIGINT included).

import { shellSingleQuote } from "../herdr/argv.ts";
import type { ReviewAgentKind } from "./types.ts";

export interface AgentLaneCommandInput {
  readonly runId: string;
  readonly laneId: string;
  readonly agentKind: ReviewAgentKind;
  readonly model: string;
  readonly effort: string;
  /** The lane's detached review worktree — the reviewer's cwd. */
  readonly worktreePath: string;
  readonly promptFile: string;
  readonly rawReportFile: string;
  readonly logFile: string;
  readonly stderrFile: string;
  /** Pre-assigned session UUID; required for claude and grok lanes. */
  readonly sessionId: string | null;
}

// The permission allowlist for claude lanes. `--tools` only restricts which
// tools are REGISTERED; `--permission-mode dontAsk` silently denies anything
// not explicitly allowed, so the read tools themselves must be allowed too
// (rehearsal-proven: without these, every read is denied).
const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
];

/**
 * The exact CLI argv per agent family — the flag batteries verified on the
 * target machine and pinned by the executable spec (D6).
 */
export function buildAgentCliArgv(input: AgentLaneCommandInput): string[] {
  switch (input.agentKind) {
    case "claude": {
      if (input.sessionId === null) {
        throw new Error("a claude lane requires a pre-assigned session id");
      }
      return [
        "claude",
        "-p",
        "--model",
        input.model,
        "--effort",
        input.effort,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--session-id",
        input.sessionId,
        "--tools",
        "Bash,Read,Glob,Grep",
        "--allowedTools",
        ...CLAUDE_ALLOWED_TOOLS,
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--setting-sources",
        "",
      ];
    }
    case "codex":
      return [
        "codex",
        "exec",
        "-s",
        "read-only",
        "-c",
        `model=${input.model}`,
        "-c",
        `model_reasoning_effort=${input.effort}`,
        "-o",
        input.rawReportFile,
      ];
    case "grok": {
      if (input.sessionId === null) {
        throw new Error("a grok lane requires a pre-assigned session id");
      }
      return [
        "grok",
        "--no-leader",
        "--session-id",
        input.sessionId,
        "--prompt-file",
        input.promptFile,
        "-m",
        input.model,
        "--reasoning-effort",
        input.effort,
        "--disable-web-search",
        "--always-approve",
        "--output-format",
        // Plain output is the ratified surface; both rehearsals proved its
        // pre-completion visibility, so the streaming contingency never
        // activated and is deliberately not wired.
        "plain",
      ];
    }
  }
}

// First line is the marker the fake adapter uses to recognize agent lanes.
const AGENT_LANE_SCRIPT = [
  "# flow agent lane",
  "set -u",
  'runId="$1"; laneId="$2"; cwd="$3"; logFile="$4"; stderrFile="$5"; rawFile="$6"; promptFile="$7"; stdinMode="$8"; rawMode="$9"',
  "shift 9",
  'token="FLOW_${runId}_LANE_${laneId}_EXIT"',
  'mkdir -p -- "$(dirname -- "$logFile")" "$(dirname -- "$stderrFile")" "$(dirname -- "$rawFile")"',
  "run_lane() {",
  'if ! cd -- "$cwd"; then',
  '  printf "%s\\n" "LANE_CWD_FAILED cwd=${cwd}"',
  '  printf "%s=97\\n" "$token"',
  "  exit 97",
  "fi",
  'printf "%s\\n" "LANE_START run=${runId} lane=${laneId} agent=$1 pid=$$"',
  // A handler (not SIG_IGN) so the CLI child still receives a default SIGINT
  // while this shell survives to print the sentinel with the real exit code.
  "trap ':' INT",
  'if [ "$stdinMode" = "file" ]; then exec 3< "$promptFile"; else exec 3< /dev/null; fi',
  'if [ "$rawMode" = "tee" ]; then',
  // The raw file receives only CLI stdout bytes; stderr reaches the pane and
  // its own artifact. Both tees shield SIGINT so captured bytes survive an
  // interrupt; PIPESTATUS[0] preserves the CLI's own exit status.
  '  "$@" <&3 2> >(trap "" INT; exec tee -a "$stderrFile" >&2) | { trap "" INT; exec tee -a "$rawFile"; }',
  '  laneStatus="${PIPESTATUS[0]}"',
  "else",
  '  "$@" <&3 2> >(trap "" INT; exec tee -a "$stderrFile" >&2)',
  '  laneStatus="$?"',
  "fi",
  'printf "%s\\n" "LANE_CLI_EXIT code=${laneStatus}"',
  'printf "%s=%s\\n" "$token" "$laneStatus"',
  'exit "$laneStatus"',
  "}",
  'run_lane "$@" | { trap "" INT; exec tee -a "$logFile"; }',
  'exit "${PIPESTATUS[0]}"',
].join("\n");

export function buildAgentLaneCommand(input: AgentLaneCommandInput): string {
  const cli = buildAgentCliArgv(input);
  const stdinMode = input.agentKind === "grok" ? "none" : "file";
  const rawMode = input.agentKind === "codex" ? "harness" : "tee";
  return [
    "bash",
    "-c",
    shellSingleQuote(AGENT_LANE_SCRIPT),
    "flow-agent-lane",
    shellSingleQuote(input.runId),
    shellSingleQuote(input.laneId),
    shellSingleQuote(input.worktreePath),
    shellSingleQuote(input.logFile),
    shellSingleQuote(input.stderrFile),
    shellSingleQuote(input.rawReportFile),
    shellSingleQuote(input.promptFile),
    shellSingleQuote(stdinMode),
    shellSingleQuote(rawMode),
    ...cli.map(shellSingleQuote),
  ].join(" ");
}
