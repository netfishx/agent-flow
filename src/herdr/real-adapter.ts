// Real Herdr adapter: every method shells out to the `herdr` CLI with an argv
// array (no shell interpolation) and routes the response through the central
// JSON parsers. Interrupt is delivered as a real SIGINT to the lane's foreground
// process group — the faithful programmatic equivalent of a tty Ctrl+C, not a
// synthetic `send-keys` keystroke.

import type { HerdrAdapter } from "./adapter.ts";
import {
  paneRunArgv,
  paneSplitArgv,
  paneZoomOnArgv,
  processInfoArgv,
  tabCreateArgv,
  tabFocusArgv,
  waitOutputArgv,
} from "./argv.ts";
import {
  parseCreatedTab,
  parseProcessInfo,
  parseSplitPane,
} from "./json.ts";
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

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RealHerdrAdapterOptions {
  /** Path to the herdr binary. Defaults to "herdr" on PATH. */
  readonly binary?: string;
  /** Injectable process-group signaller (for testing the interrupt path). */
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
}

export class RealHerdrAdapter implements HerdrAdapter {
  private readonly binary: string;
  private readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void;

  constructor(options: RealHerdrAdapterOptions = {}) {
    this.binary = options.binary ?? "herdr";
    this.signalGroup =
      options.signalGroup ??
      ((pgid, signal) => {
        // A negative pid signals the whole process group on POSIX.
        process.kill(-pgid, signal);
      });
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
      throw new Error(
        `herdr ${argv.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    return stdout;
  }

  async createTab(opts: CreateTabOptions): Promise<CreatedTab> {
    return parseCreatedTab(await this.runOk(tabCreateArgv(opts)));
  }

  async splitPane(opts: SplitPaneOptions): Promise<PaneRef> {
    return parseSplitPane(await this.runOk(paneSplitArgv(opts)));
  }

  async runInPane(pane: PaneRef, shellCommand: string): Promise<void> {
    await this.runOk(paneRunArgv(pane, shellCommand));
  }

  async waitForOutput(
    pane: PaneRef,
    regex: string,
    timeoutMs: number,
  ): Promise<WaitOutcome> {
    // Exit 0 = the pattern appeared; any non-zero (timeout or error) = no match.
    // This is deliberately decoupled from the lane's own exit code.
    const { exitCode } = await this.run(waitOutputArgv(pane, regex, timeoutMs));
    return { matched: exitCode === 0 };
  }

  async processInfo(pane: PaneRef): Promise<ProcessInfo> {
    return parseProcessInfo(await this.runOk(processInfoArgv(pane)));
  }

  async focusPane(pane: PaneRef, tab: TabRef): Promise<void> {
    await this.runOk(tabFocusArgv(tab));
    await this.runOk(paneZoomOnArgv(pane));
  }

  async interruptPane(pane: PaneRef): Promise<InterruptEvidence> {
    const info = await this.processInfo(pane);
    const pgid = info.foregroundProcessGroupId;
    // The foreground group returning to the shell means nothing is running.
    if (pgid === info.shellPid) {
      return { signal: "SIGINT", processGroupId: null, delivered: false };
    }
    try {
      this.signalGroup(pgid, "SIGINT");
      return { signal: "SIGINT", processGroupId: pgid, delivered: true };
    } catch {
      return { signal: "SIGINT", processGroupId: pgid, delivered: false };
    }
  }
}
