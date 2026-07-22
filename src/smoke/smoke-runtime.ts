// Smoke-internal controller-loss handoff. The blob is opaque to callers, but
// its contents are now committed RunEvents and attach rebuilds through reduce.

import type { RunEvent } from "../runtime/events.ts";
import {
  InMemoryLedger,
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
  exportRun(runId: string): string {
    this.runView(runId);
    const history: RunHistory = {
      v: 1,
      events: internalCommittedEvents(this.deps.ledger, runId),
    };
    return JSON.stringify(history);
  }

  /** Commit and reduce the exported history into this ephemeral controller. */
  attachRun(serialized: string): RunHandle {
    const history = JSON.parse(serialized) as Partial<RunHistory>;
    if (history.v !== 1) {
      throw new Error(`unsupported run topology version ${history.v}`);
    }
    if (!Array.isArray(history.events) || history.events.length === 0) {
      throw new Error("unsupported run topology: missing committed event history");
    }
    if (!(this.deps.ledger instanceof InMemoryLedger)) {
      throw new Error("synchronous smoke attach requires an InMemoryLedger");
    }

    let state: RunView | undefined;
    for (const event of history.events) {
      // InMemoryLedger performs its ephemeral append synchronously before
      // returning the already-resolved Promise, preserving attachRun's #4 API.
      const committed = this.deps.ledger.commit(event);
      void committed.catch(() => {});
      state = reduce(state, event);
    }
    this.registerReducedView(state!);
    return { runId: state!.runId, laneIds: [...state!.laneOrder] };
  }
}
