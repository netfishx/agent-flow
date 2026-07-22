// Structured types at the Herdr seam. These are internal to the adapter layer:
// the runtime uses them, but they never appear in the public runtime interface,
// so pane identifiers and raw Herdr JSON cannot leak to callers.

/** A Herdr pane. Its `id` (e.g. "w2:pD") is an implementation detail. */
export interface PaneRef {
  readonly id: string;
}

/** A Herdr tab. Its `id` (e.g. "w2:t5") is an implementation detail. */
export interface TabRef {
  readonly id: string;
}

/** A freshly created tab and the initial (controller) pane it contains. */
export interface CreatedTab {
  readonly tab: TabRef;
  readonly controllerPane: PaneRef;
}

export interface CreateTabOptions {
  readonly workspace: string;
  readonly cwd: string;
  readonly label: string;
}

export interface SplitPaneOptions {
  readonly from: PaneRef;
  readonly direction: "right" | "down";
  readonly cwd: string;
  readonly ratio?: number;
}

/**
 * Parsed view of `herdr pane process-info`. The foreground process group is the
 * key liveness signal: while a lane runs it differs from `shellPid`; once the
 * lane exits the foreground group returns to the pane's shell.
 */
export interface ProcessInfo {
  readonly paneId: string;
  readonly shellPid: number;
  readonly foregroundProcessGroupId: number;
  readonly foregroundPids: readonly number[];
  readonly foregroundNames: readonly string[];
}

/**
 * Outcome of `herdr pane wait-output`. `matched` reports only whether the
 * pattern appeared — it is deliberately NOT a process exit code. A matched wait
 * says "the sentinel line was printed", never "the lane succeeded".
 */
export interface WaitOutcome {
  readonly matched: boolean;
}

/** Evidence from sending an interrupt to a pane's foreground process group. */
export interface InterruptEvidence {
  readonly signal: string;
  readonly processGroupId: number | null;
  readonly delivered: boolean;
}
