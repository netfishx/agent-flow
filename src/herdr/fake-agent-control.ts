// Deterministic in-memory agent-control adapter for tests: no real Herdr, no
// CLI, no model call. Every observable is scriptable so the fail-closed paths
// — a start that times out, a prompt that stalls, a pane taken over by another
// process, a pane that is simply gone — are reachable without a real session.

import type { AgentPromptResult, HerdrAgentControl } from "./agent-control.ts";
import type {
  AgentInfoView,
  AgentStartedView,
} from "./agent-json.ts";
import type {
  AgentPromptOptions,
  AgentStartOptions,
  PaneReportAgentOptions,
} from "./agent-argv.ts";
import type {
  AdvisoryAgentStatus,
  SteerObservationOutcome,
} from "../interactive/types.ts";

export interface FakeAgentProgram {
  /** Reject `agent start` with this cause instead of starting. */
  readonly startFailure?: string;
  readonly sessionId?: string | null;
  /** Statuses returned by `getAgent`, consumed in order then repeated. */
  readonly statuses?: readonly AdvisoryAgentStatus[];
  /** Outcomes returned by `promptAgent`, consumed in order then repeated. */
  readonly promptOutcomes?: readonly SteerObservationOutcome[];
  /** What `waitForState` resolves to; null models a window that elapsed. */
  readonly waitResult?: AdvisoryAgentStatus | null;
}

export interface FakeAgentControlOptions {
  /** Programs keyed by the agent name the controller derives. */
  readonly programs?: Readonly<Record<string, FakeAgentProgram>>;
  readonly defaultProgram?: FakeAgentProgram;
  /**
   * The pane fake to mark occupied when an agent starts. `herdr agent start`
   * puts a real process in the pane, so without this the adapter would report
   * every interactive pane as idle and a signal to it as undelivered.
   */
  readonly panes?: { occupyPane(paneId: string): void };
}

interface LiveAgent {
  readonly name: string;
  readonly paneId: string;
  /** The detected kind label; a DIFFERENT value models a reoccupied pane. */
  agent: string;
  sessionId: string | null;
  statusIndex: number;
  promptIndex: number;
  readonly program: FakeAgentProgram;
}

export class FakeHerdrAgentControl implements HerdrAgentControl {
  private readonly programs: Readonly<Record<string, FakeAgentProgram>>;
  private readonly defaultProgram: FakeAgentProgram;
  private readonly panes: { occupyPane(paneId: string): void } | null;
  private readonly live = new Map<string, LiveAgent>();

  // Observability for assertions.
  readonly startCalls: AgentStartOptions[] = [];
  readonly promptCalls: { target: string; text: string }[] = [];
  readonly sendKeysCalls: { target: string; keys: readonly string[] }[] = [];
  readonly reportCalls: PaneReportAgentOptions[] = [];
  readonly releaseCalls: { paneId: string; source: string; agent: string }[] = [];

  constructor(options: FakeAgentControlOptions = {}) {
    this.programs = options.programs ?? {};
    this.defaultProgram = options.defaultProgram ?? {};
    this.panes = options.panes ?? null;
  }

  /** Model a pane whose agent died: Herdr keeps no record of a dead session. */
  killAgent(name: string): void {
    this.live.delete(name);
  }

  /** Model a pane another process now occupies. */
  reoccupy(name: string, occupant: string): void {
    const agent = this.live.get(name);
    if (!agent) throw new Error(`fake: no live agent ${name}`);
    agent.agent = occupant;
  }

  private program(name: string): FakeAgentProgram {
    return this.programs[name] ?? this.defaultProgram;
  }

  private resolve(target: string): LiveAgent | null {
    const byName = this.live.get(target);
    if (byName) return byName;
    for (const agent of this.live.values()) {
      if (agent.paneId === target) return agent;
    }
    return null;
  }

  private infoOf(agent: LiveAgent, status: AdvisoryAgentStatus): AgentInfoView {
    return {
      paneId: agent.paneId,
      name: agent.name,
      agent: agent.agent,
      status,
      interactiveReady: true,
      launchPending: false,
      sessionId: agent.sessionId,
    };
  }

  private nextStatus(agent: LiveAgent): AdvisoryAgentStatus {
    const statuses = agent.program.statuses ?? ["working"];
    const status = statuses[Math.min(agent.statusIndex, statuses.length - 1)]!;
    agent.statusIndex += 1;
    return status;
  }

  async startAgent(options: AgentStartOptions): Promise<AgentStartedView> {
    this.startCalls.push(options);
    const program = this.program(options.name);
    if (program.startFailure !== undefined) {
      throw new Error(program.startFailure);
    }
    const agent: LiveAgent = {
      name: options.name,
      paneId: options.paneId,
      agent: options.kind,
      sessionId: program.sessionId ?? null,
      statusIndex: 0,
      promptIndex: 0,
      program,
    };
    this.live.set(options.name, agent);
    this.panes?.occupyPane(options.paneId);
    return {
      agent: this.infoOf(agent, "idle"),
      argv: [options.kind, ...(options.nativeArgs ?? [])],
    };
  }

  async promptAgent(
    target: string,
    text: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentPromptResult> {
    this.promptCalls.push({ target, text });
    const agent = this.resolve(target);
    if (!agent) throw new Error(`fake: no live agent for target ${target}`);
    const outcomes = agent.program.promptOutcomes ?? ["state-observed"];
    const outcome =
      outcomes[Math.min(agent.promptIndex, outcomes.length - 1)]!;
    agent.promptIndex += 1;
    if (options.waitMs === undefined) {
      return { outcome: "not-observed", agent: null };
    }
    if (outcome !== "state-observed") return { outcome, agent: null };
    return {
      outcome,
      agent: this.infoOf(agent, this.nextStatus(agent)),
    };
  }

  async sendKeys(target: string, keys: readonly string[]): Promise<void> {
    this.sendKeysCalls.push({ target, keys });
    if (!this.resolve(target)) {
      throw new Error(`fake: no live agent for target ${target}`);
    }
  }

  async waitForState(
    target: string,
    _until: readonly AdvisoryAgentStatus[],
    _timeoutMs: number,
  ): Promise<AgentInfoView | null> {
    const agent = this.resolve(target);
    if (!agent) return null;
    const result = agent.program.waitResult;
    if (result === undefined) return this.infoOf(agent, this.nextStatus(agent));
    return result === null ? null : this.infoOf(agent, result);
  }

  async getAgent(target: string): Promise<AgentInfoView | null> {
    const agent = this.resolve(target);
    if (!agent) return null;
    return this.infoOf(agent, this.nextStatus(agent));
  }

  async reportAgentState(options: PaneReportAgentOptions): Promise<void> {
    this.reportCalls.push(options);
  }

  async releaseAgentState(options: {
    readonly paneId: string;
    readonly source: string;
    readonly agent: string;
  }): Promise<void> {
    this.releaseCalls.push(options);
  }
}
