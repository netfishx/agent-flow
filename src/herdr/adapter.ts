// The narrow seam between the runtime and Herdr. The runtime depends on this
// interface alone: it never assembles pane layouts, parses Herdr JSON, or shells
// out directly. Two implementations satisfy it — a real CLI adapter and a fake
// in-memory adapter that drives every deterministic test.

import type {
  CreatedTab,
  CreateTabOptions,
  InterruptEvidence,
  PaneRef,
  ProcessInfo,
  SplitPaneOptions,
  TabRef,
  WaitOutcome,
} from "./types.ts";

export interface HerdrAdapter {
  /** Create a dedicated tab; returns the tab and its initial controller pane. */
  createTab(opts: CreateTabOptions): Promise<CreatedTab>;

  /** Split a pane; returns the new pane. */
  splitPane(opts: SplitPaneOptions): Promise<PaneRef>;

  /**
   * Dispatch a command into a pane as its own process group. `shellCommand` is
   * a single, already-quoted line run by the pane's shell (Herdr joins its
   * command words and re-parses them through that shell). The resulting process
   * is a child of the Herdr server, not of the caller, so the caller may exit
   * without ending it.
   */
  runInPane(pane: PaneRef, shellCommand: string): Promise<void>;

  /**
   * Block until `regex` appears in the pane, or the timeout elapses. The result
   * reports match success only — never a lane's exit code.
   */
  waitForOutput(
    pane: PaneRef,
    regex: string,
    timeoutMs: number,
  ): Promise<WaitOutcome>;

  /** Read the pane's process facts (liveness via the foreground process group). */
  processInfo(pane: PaneRef): Promise<ProcessInfo>;

  /** Bring a pane into the human's view (focus its tab and zoom the pane). */
  focusPane(pane: PaneRef, tab: TabRef): Promise<void>;

  /** Send SIGINT to the pane's foreground process group. */
  interruptPane(pane: PaneRef): Promise<InterruptEvidence>;
}
