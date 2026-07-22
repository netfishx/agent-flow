import type { RunEvent } from "./events.ts";
import { reduce, type RunView } from "./reducer.ts";

export interface LeaseHandle {
  release(): Promise<void>;
}

export interface Ledger {
  commit(event: RunEvent): Promise<void>;
  load(runId: string): Promise<RunView | null>;
  list(): Promise<{ runId: string }[]>;
  acquireLease(
    runId: string,
    controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle>;
}

const histories = new WeakMap<InMemoryLedger, Map<string, RunEvent[]>>();
const liveViews = new WeakMap<InMemoryLedger, Map<string, RunView>>();
const committedEventReaders = new WeakMap<
  Ledger,
  (runId: string) => Promise<readonly RunEvent[]>
>();
const synchronousCommit = Symbol("InMemoryLedger.synchronousCommit");

function historyFor(ledger: InMemoryLedger): Map<string, RunEvent[]> {
  const history = histories.get(ledger);
  if (!history) throw new Error("uninitialized InMemoryLedger");
  return history;
}

function replay(events: readonly RunEvent[]): RunView | null {
  let state: RunView | undefined;
  for (const event of events) state = reduce(state, event);
  return state ?? null;
}

function cloneEvent(event: RunEvent): RunEvent {
  return structuredClone(event);
}

/**
 * Explicitly ephemeral, single-process ledger for tests.
 * It provides no durability and intentionally has only trivial lease behavior.
 */
export class InMemoryLedger implements Ledger {
  constructor() {
    histories.set(this, new Map());
    liveViews.set(this, new Map());
    internalRegisterCommittedEventReader(this, async (runId) =>
      (historyFor(this).get(runId) ?? []).map(cloneEvent),
    );
  }

  commit(event: RunEvent): Promise<void> {
    try {
      this[synchronousCommit](event);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async load(runId: string): Promise<RunView | null> {
    return replay(historyFor(this).get(runId) ?? []);
  }

  async list(): Promise<{ runId: string }[]> {
    return [...historyFor(this).keys()].map((runId) => ({ runId }));
  }

  async acquireLease(
    _runId: string,
    _controller: { controllerId: string; pid: number },
  ): Promise<LeaseHandle> {
    return { release: async () => {} };
  }

  /** Test/smoke failure-injection hook; not part of the Ledger capability port. */
  protected beforeCommit(_event: RunEvent): void {}

  [synchronousCommit](event: RunEvent): void {
    this.beforeCommit(event);
    commitSynchronously(this, event);
  }
}

// Smoke-only implementation details. They are deliberately absent from the
// package entry point and from Ledger: raw history/replay are not public ports.
export async function internalCommittedEvents(
  ledger: Ledger,
  runId: string,
): Promise<readonly RunEvent[]> {
  const read = committedEventReaders.get(ledger);
  if (read) return read(runId);
  throw new Error("smoke event export requires a supported Ledger");
}

/** Module-internal registration for smoke history; absent from src/index.ts. */
export function internalRegisterCommittedEventReader(
  ledger: Ledger,
  read: (runId: string) => Promise<readonly RunEvent[]>,
): void {
  committedEventReaders.set(ledger, read);
}

function commitSynchronously(ledger: InMemoryLedger, event: RunEvent): void {
  const history = historyFor(ledger);
  const views = liveViews.get(ledger)!;
  const events = history.get(event.runId) ?? [];
  const next = reduce(views.get(event.runId), event);
  const committed = cloneEvent(event);
  if (events.length === 0) history.set(event.runId, [committed]);
  else events.push(committed);
  views.set(event.runId, next);
}
