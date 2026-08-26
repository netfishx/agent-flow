// Two command surfaces for the interactive write lane.
//
//  1. The NATIVE argv each CLI family is started with. These are passed to
//     `herdr agent start ... -- <native args>`; Herdr owns the executable.
//  2. The RUNNER command, which is an ordinary headless command in its own
//     pane and keeps the contract the read-only lane already proved: exact
//     argv, durable log, a sentinel carrying the real exit code.

import { shellSingleQuote } from "../herdr/argv.ts";
import type { InteractiveAgentKind } from "./types.ts";

export interface NativeArgsInput {
  readonly agentKind: InteractiveAgentKind;
  readonly model: string;
  readonly effort: string;
  /** Pre-assigned session UUID for families that accept one; null otherwise. */
  readonly sessionId: string | null;
}

/**
 * The native argv each family is launched with. Model and effort come from the
 * lane; the approval boundary is PINNED here, per invocation.
 *
 * Stage 1 measured why it has to be pinned: a launch inherits whatever the host
 * machine configured, and on the rehearsal machine that silently removed the
 * human approval boundary in three different ways — grok read
 * `permission_mode = "always-approve"` from its user config, codex read
 * `approvals_reviewer = "guardian_subagent"` and routed approval requests to an
 * automatic reviewer, and claude was launched by this function with
 * `acceptEdits`, which auto-approves file edits and common file commands.
 *
 * What the pins guarantee, stated exactly:
 *
 *   - `claude --permission-mode default` keeps claude's own documented
 *     human-approval mode. A CLI flag beats user config for that process, so
 *     the lane no longer inherits the host's setting.
 *   - `grok` has NO default argv here. Stage 2 measured 1.0.10 writing a file
 *     in `default` mode with no approval UI, and its `ask` rules cannot be set
 *     per invocation, so the default attempt fails closed instead.
 *   - `codex -a on-request` leaves the MODEL deciding when to raise a request,
 *     and `-c approvals_reviewer=user` sends every raised request to the person
 *     rather than the guardian subagent. `user` is the value that means a human
 *     reviewer; codex 0.149.1 accepts only `user`, `auto_review` and
 *     `guardian_subagent`, and refuses to start on anything else. This is NOT a
 *     claim that codex asks before each worktree write: `-s workspace-write` is
 *     the sandbox axis, and writes inside that sandbox need no request.
 *
 * Nothing here reads a vendor config file, and no family gets an
 * approval-suppressing flag (`dontAsk`, `--always-approve`, `--approve-for-me`,
 * `bypassPermissions`). `claude` also does NOT get `--setting-sources ""`: that
 * flag loads no user settings, which is exactly why a headless claude lane
 * never registers the Herdr integration hook and never publishes a session id,
 * and an interactive lane wants the hook.
 *
 * A caller may still override the whole array via `nativeArgs` on the attempt
 * input. That is an explicit operator act, and it replaces these safe defaults.
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
        "default",
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
        "-a",
        "on-request",
        "-c",
        "approvals_reviewer=user",
      ];
    case "grok":
      // Stage 2 measured grok 1.0.10 writing a file under
      // `--permission-mode default` with no approval UI, and its documented
      // `ask` rules cannot be set per invocation: there is no `--ask` flag, and
      // the `GROK_CONFIG` / `GROK_CONFIG_PATH` overlay silently drops
      // `permission.*`. A `--deny` rule is a hard rejection, not a human
      // approval, so it cannot stand in for the gate. With no way to guarantee
      // the gate, the default attempt does not start.
      throw new Error(
        "the default grok interactive write lane is disabled: grok offers no " +
          "per-invocation human approval, so a default attempt cannot keep the " +
          "gate this lane exists to provide. grok remains supported for " +
          "headless and read-only lanes. An owner may still start one by " +
          "passing explicit nativeArgs, which replaces these defaults whole.",
      );
  }
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
