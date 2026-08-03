// The Pi command adapter: a second ENTRY to the runtime, never a second
// runtime. Each command maps its argument text to the exact argv the shell
// entry would receive and calls the same `runFlowCli` function object, so
// "the Pi command invokes the same runtime" is a structural fact rather than
// an asserted equivalence.
//
// The adapter decides nothing. It routes no work, spawns no Agent, holds no
// run state, and never calls a model: a handler's only outward effect is one
// `ui.notify` carrying the runtime's own bytes. Herdr keeps hosting execution
// and the ledger stays the single source of run state, exactly as before.

import { runFlowCli, type FlowCliOptions, type TextSink } from "../cli/flow.ts";

/**
 * Pi's extension surface, narrowed to what this adapter uses. Structural
 * typing lets the real `ExtensionAPI` satisfy it without this package taking
 * a dependency on the Pi host — the same port discipline the Herdr adapter
 * and the review-isolation port already follow.
 */
export type PiNotifyLevel = "info" | "warning" | "error";

export interface PiUi {
  notify(message: string, level?: PiNotifyLevel): void;
}

export interface PiCommandContext {
  readonly ui: PiUi;
}

export interface PiCommandOptions {
  readonly description: string;
  readonly handler: (args: string, ctx: PiCommandContext) => Promise<void>;
}

export interface PiExtensionApi {
  registerCommand(name: string, options: PiCommandOptions): void;
}

export interface FlowCommandSpec {
  /** Invoked as `/<name>`. */
  readonly name: string;
  /** The `flow` subcommand this maps to, verbatim. */
  readonly subcommand: string;
  readonly description: string;
}

/**
 * The closed set of commands the adapter publishes: the six the shell entry
 * already accepts, and nothing else. Starting a cross-review is deliberately
 * absent — it spends real model budget and lives behind the smoke's owner
 * gate, so putting it on a prompt line would move a funded action to a
 * keystroke.
 */
export const FLOW_COMMANDS: readonly FlowCommandSpec[] = [
  {
    name: "flow-status",
    subcommand: "status",
    description: "List every run in the ledger with its state",
  },
  {
    name: "flow-inspect",
    subcommand: "inspect",
    description: "Inspect one run: flow-inspect <runId>",
  },
  {
    name: "flow-resume",
    subcommand: "resume",
    description: "Resume observation and collection: flow-resume <runId>",
  },
  {
    name: "flow-takeover",
    subcommand: "takeover",
    description: "Take a lane under human ownership: flow-takeover <runId> <laneId>",
  },
  {
    name: "flow-release",
    subcommand: "release",
    description: "Release a lane back to automatic driving: flow-release <runId> <laneId>",
  },
  {
    name: "flow-decide",
    subcommand: "decide",
    description:
      "Record an owner decision: flow-decide <runId> --decision <accepted|rejected|changes-requested> --note <text>",
  },
];

/**
 * Split a Pi argument line into argv the way a shell would for the quoting
 * this CLI actually needs. `--note "two words"` is the reason this is not a
 * whitespace split: a decision note is free text and losing its second word
 * would silently record a different decision.
 */
export function splitArguments(text: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const character of text) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n") {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/** The argv the shell entry would receive for this command and argument line. */
export function flowArgvFor(
  spec: FlowCommandSpec,
  args: string,
): readonly string[] {
  return [spec.subcommand, ...splitArguments(args)];
}

export interface FlowCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

class StringSink implements TextSink {
  text = "";
  write(chunk: string): void {
    this.text += chunk;
  }
}

/**
 * Run one flow command and capture what the shell entry would have printed.
 * Output is captured, never rewritten: the adapter must not become a place
 * where the runtime's own bytes are summarised.
 */
export async function runFlowCommand(
  argv: readonly string[],
  options: FlowCliOptions = {},
): Promise<FlowCommandResult> {
  const stdout = new StringSink();
  const stderr = new StringSink();
  const exitCode = await runFlowCli(argv, stdout, stderr, options);
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

/**
 * What the user sees. A non-zero exit surfaces stderr as an error rather than
 * a quiet empty panel, and a zero exit with no output still says so — an
 * adapter that shows nothing is indistinguishable from one that did nothing.
 */
export function notificationFor(
  spec: FlowCommandSpec,
  result: FlowCommandResult,
): { readonly message: string; readonly level: PiNotifyLevel } {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      message: detail || `${spec.name} failed with exit ${result.exitCode}`,
      level: "error",
    };
  }
  const detail = result.stdout.trim() || result.stderr.trim();
  return {
    message: detail || `${spec.name}: no runs in the ledger`,
    level: "info",
  };
}

/**
 * Register the flow commands on a Pi extension API. Called by the project's
 * `.pi/extensions` entry; injectable options exist so tests drive the real
 * handler against an in-memory ledger.
 */
export function registerFlowCommands(
  pi: PiExtensionApi,
  options: FlowCliOptions = {},
): void {
  for (const spec of FLOW_COMMANDS) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      handler: async (args, ctx) => {
        const result = await runFlowCommand(flowArgvFor(spec, args), options);
        const notification = notificationFor(spec, result);
        ctx.ui.notify(notification.message, notification.level);
      },
    });
  }
}
