// Smoke-internal controller-loss handoff. The blob is opaque to callers, but
// its contents are now committed RunEvents and attach rebuilds through reduce.

import type { RunEvent } from "../runtime/events.ts";
import {
  internalCommittedEvents,
} from "../runtime/ledger.ts";
import { reduce, type RunView } from "../runtime/reducer.ts";
import { WorkflowRuntime } from "../runtime/runtime.ts";
import type { RunHandle } from "../runtime/types.ts";

interface RunHistory {
  readonly v: 1;
  readonly events: readonly RunEvent[];
}

export class SmokeRuntime extends WorkflowRuntime {
  /** Serialize the committed event history for this run as an opaque blob. */
  async exportRun(runId: string): Promise<string> {
    this.runView(runId);
    if (this.hasPendingTransition(runId)) {
      throw new Error(
        `run "${runId}" has a pending transition; await an async public operation before exportRun`,
      );
    }
    const history: RunHistory = {
      v: 1,
      events: await internalCommittedEvents(this.deps.ledger, runId),
    };
    return JSON.stringify(history);
  }

  /** Commit and reduce the exported history into this ephemeral controller. */
  async attachRun(serialized: string): Promise<RunHandle> {
    const history = JSON.parse(serialized) as Partial<RunHistory>;
    if (history.v !== 1) {
      throw new Error(`unsupported run topology version ${history.v}`);
    }
    if (!Array.isArray(history.events) || history.events.length === 0) {
      throw new Error("unsupported run topology: missing committed event history");
    }
    const runId = history.events[0]!.runId;
    await this.acquireControllerLease(runId);
    let state: RunView | undefined;
    try {
      for (const event of history.events) {
        await this.deps.ledger.commit(event);
        state = reduce(state, event);
      }
    } catch (error) {
      await this.releaseControllerLease(runId);
      throw error;
    }
    this.registerReducedView(state!);
    return { runId: state!.runId, laneIds: [...state!.laneOrder] };
  }

  /** Smoke handoff boundary: relinquish single-writer ownership, not the lanes. */
  async releaseForHandoff(runId: string): Promise<void> {
    await this.releaseControllerLease(runId);
  }
}
