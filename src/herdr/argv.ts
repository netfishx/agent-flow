// The single place where Herdr command lines and shell fragments are built.
// Every `herdr` invocation is expressed as an argv array (never a joined shell
// string), and any value that must be embedded inside a shell command is quoted
// through `shellSingleQuote` here — so quoting and the argv boundary have one
// tested home.

import type {
  CreateTabOptions,
  PaneRef,
  SplitPaneOptions,
  TabRef,
} from "./types.ts";

/**
 * POSIX single-quote a value for safe embedding in a shell command string.
 * Wraps in single quotes and rewrites each embedded `'` as `'\''`.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Escape a literal string for use inside a Rust/PCRE-style regex. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tabCreateArgv(o: CreateTabOptions): string[] {
  return [
    "tab",
    "create",
    "--workspace",
    o.workspace,
    "--cwd",
    o.cwd,
    "--label",
    o.label,
    "--no-focus",
  ];
}

export function paneSplitArgv(o: SplitPaneOptions): string[] {
  const argv = [
    "pane",
    "split",
    o.from.id,
    "--direction",
    o.direction,
    "--cwd",
    o.cwd,
    "--no-focus",
  ];
  if (o.ratio !== undefined) {
    argv.push("--ratio", String(o.ratio));
  }
  return argv;
}

/**
 * `herdr pane run <pane> <command>`. Herdr joins the command words with spaces
 * and re-parses them through the pane's shell, so the runtime hands us one
 * already-quoted line and we pass it as a single argument — no per-word argv
 * survives the shell round-trip.
 */
export function paneRunArgv(pane: PaneRef, shellCommand: string): string[] {
  return ["pane", "run", pane.id, shellCommand];
}

export function waitOutputArgv(
  pane: PaneRef,
  regex: string,
  timeoutMs: number,
): string[] {
  return [
    "pane",
    "wait-output",
    pane.id,
    "--regex",
    regex,
    "--source",
    "recent-unwrapped",
    "--timeout",
    String(timeoutMs),
  ];
}

export function processInfoArgv(pane: PaneRef): string[] {
  return ["pane", "process-info", "--pane", pane.id];
}

export function tabFocusArgv(tab: TabRef): string[] {
  return ["tab", "focus", tab.id];
}

export function paneZoomOnArgv(pane: PaneRef): string[] {
  return ["pane", "zoom", "--pane", pane.id, "--on"];
}
