import type { HerdrAdapter } from "../herdr/adapter.ts";
import type {
  CreatedTab,
  CreateTabOptions,
  InterruptEvidence,
  PaneRef,
  ProcessInfo,
  SplitPaneOptions,
  TabRef,
  WaitOutcome,
} from "../herdr/types.ts";

export interface TargetWaitStarted {
  readonly paneId: string;
  readonly targetWaitCount: number;
}

export class TrackingHerdrAdapter implements HerdrAdapter {
  targetWaitCount = 0;
  private markerWritten = false;
  private readonly waitCounts = new Map<string, number>();
  private readonly interruptCounts = new Map<string, number>();

  constructor(
    private readonly base: HerdrAdapter,
    private readonly targetPaneId: string,
    private readonly markTargetWaitStarted: (
      started: TargetWaitStarted,
    ) => Promise<void>,
  ) {}

  createTab(opts: CreateTabOptions): Promise<CreatedTab> {
    return this.base.createTab(opts);
  }

  splitPane(opts: SplitPaneOptions): Promise<PaneRef> {
    return this.base.splitPane(opts);
  }

  runInPane(pane: PaneRef, shellCommand: string): Promise<void> {
    return this.base.runInPane(pane, shellCommand);
  }

  waitCount(paneId: string): number {
    return this.waitCounts.get(paneId) ?? 0;
  }

  interruptCount(paneId: string): number {
    return this.interruptCounts.get(paneId) ?? 0;
  }

  async waitForOutput(
    pane: PaneRef,
    regex: string,
    timeoutMs: number,
  ): Promise<WaitOutcome> {
    // RealHerdrAdapter starts Bun.spawn before returning this promise, so the
    // marker below cannot be observed before `herdr pane wait-output` starts.
    const pending = this.base.waitForOutput(pane, regex, timeoutMs);
    this.waitCounts.set(pane.id, this.waitCount(pane.id) + 1);
    if (pane.id === this.targetPaneId) {
      this.targetWaitCount += 1;
      if (!this.markerWritten) {
        this.markerWritten = true;
        await this.markTargetWaitStarted({
          paneId: pane.id,
          targetWaitCount: this.targetWaitCount,
        });
      }
    }
    return await pending;
  }

  processInfo(pane: PaneRef): Promise<ProcessInfo> {
    return this.base.processInfo(pane);
  }

  focusPane(pane: PaneRef, tab: TabRef): Promise<void> {
    return this.base.focusPane(pane, tab);
  }

  interruptPane(pane: PaneRef): Promise<InterruptEvidence> {
    this.interruptCounts.set(
      pane.id,
      this.interruptCount(pane.id) + 1,
    );
    return this.base.interruptPane(pane);
  }
}
