// Two command surfaces for the interactive write lane.
//
//  1. The NATIVE argv each CLI family is started with. These are passed to
//     `herdr agent start ... -- <native args>`; Herdr owns the executable.
//  2. The RUNNER command, which is an ordinary headless command in its own
//     pane and keeps the contract the read-only lane already proved: exact
//     argv, durable log, a sentinel carrying the real exit code.

import { escapeRegex, shellSingleQuote } from "../herdr/argv.ts";
import type { InteractiveAgentKind } from "./types.ts";

export interface NativeArgsInput {
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  /** Pre-assigned session UUID for families that accept one; null otherwise. */
  readonly sessionId: string | null;
}

/**
 * REHEARSAL-PENDING. Every entry below is derived from the flags the headless
 * lane already proved on this machine (`src/review/commands.ts`) minus the
 * one-shot switch, plus the documented sandbox/permission value that lets the
 * session write. None of it has been run: #49's rehearsal is what turns these
 * from a reasoned default into a measured fact, and until then a caller may
 * override them wholesale via `nativeArgs` on the attempt input.
 *
 * Two differences from the headless batteries are deliberate and load-bearing:
 *
 *   - `claude` does NOT get `--setting-sources ""` here. That flag loads no
 *     user settings, which is exactly why a headless claude lane never
 *     registers the Herdr integration hook and never publishes a session id.
 *     An interactive lane wants the hook, so the flag is absent.
 *   - No family gets an approval-suppressing flag (`dontAsk`, `read-only`,
 *     `--always-approve`). Suppressing the question would delete the human
 *     approval gate this lane exists to provide.
 */
export function buildNativeArgs(input: NativeArgsInput): string[] {
  switch (input.agentKind) {
    case "claude": {
      if (input.sessionId === null) {
        throw new Error("an interactive claude attempt requires a session id");
      }
      return [
        "--model",
        input.model,
        "--effort",
        input.effort,
        "--permission-mode",
        "acceptEdits",
        "--session-id",
        input.sessionId,
      ];
    }
    case "codex":
      // Session id comes from the codex integration hook, not from a flag.
      return [
        "-c",
        `model=${input.model}`,
        "-c",
        `model_reasoning_effort=${input.effort}`,
        "-s",
        "workspace-write",
      ];
    case "grok": {
      if (input.sessionId === null) {
        throw new Error("an interactive grok attempt requires a session id");
      }
      return [
        "--no-leader",
        "--session-id",
        input.sessionId,
        "-m",
        input.model,
        "--reasoning-effort",
        input.effort,
      ];
    }
  }
}

/** The runner sentinel: same shape as the lane's, scoped to one evidence record. */
export function runnerSentinelToken(runId: string, evidenceId: string): string {
  return `FLOW_${runId}_RUNNER_${evidenceId}_EXIT`;
}

export function runnerSentinelRegex(runId: string, evidenceId: string): string {
  return `${escapeRegex(runnerSentinelToken(runId, evidenceId))}=[0-9]+`;
}

export function parseRunnerExit(
  runId: string,
  evidenceId: string,
  output: string,
): number | null {
  const re = new RegExp(
    `${escapeRegex(runnerSentinelToken(runId, evidenceId))}=([0-9]+)`,
    "g",
  );
  let last: number | null = null;
  for (const match of output.matchAll(re)) {
    const digits = match[1];
    if (digits !== undefined) last = Number.parseInt(digits, 10);
  }
  return last;
}

export interface RunnerCommandInput {
  readonly runId: string;
  readonly evidenceId: string;
  readonly cwd: string;
  readonly logFile: string;
  /** The verification argv, run as "$@" — never re-parsed by a shell. */
  readonly argv: readonly string[];
}

// First line is the marker the fake adapter recognizes a runner pane by.
const RUNNER_SCRIPT = [
  "# flow interactive runner",
  "set -u",
  'runId="$1"; evidenceId="$2"; cwd="$3"; logFile="$4"',
  "shift 4",
  'token="FLOW_${runId}_RUNNER_${evidenceId}_EXIT"',
  'mkdir -p -- "$(dirname -- "$logFile")"',
  "run_runner() {",
  'if ! cd -- "$cwd"; then',
  '  printf "%s\\n" "RUNNER_CWD_FAILED cwd=${cwd}"',
  '  printf "%s=97\\n" "$token"',
  "  exit 97",
  "fi",
  'printf "%s\\n" "RUNNER_START run=${runId} evidence=${evidenceId} cmd=$1"',
  '"$@"',
  'runnerStatus="$?"',
  'printf "%s=%s\\n" "$token" "$runnerStatus"',
  'exit "$runnerStatus"',
  "}",
  'run_runner "$@" | { trap "" INT; exec tee -a "$logFile"; }',
  'exit "${PIPESTATUS[0]}"',
].join("\n");

export function buildRunnerCommand(input: RunnerCommandInput): string {
  if (input.argv.length === 0) {
    throw new Error("a runner command requires at least one argv entry");
  }
  return [
    "bash",
    "-c",
    shellSingleQuote(RUNNER_SCRIPT),
    "flow-interactive-runner",
    shellSingleQuote(input.runId),
    shellSingleQuote(input.evidenceId),
    shellSingleQuote(input.cwd),
    shellSingleQuote(input.logFile),
    ...input.argv.map(shellSingleQuote),
  ].join(" ");
}
