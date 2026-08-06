// The seam between the interactive write lane and Herdr's agent surface.
//
// It is a SEPARATE port from `HerdrAdapter` on purpose: the read-only lane's
// adapter is accepted work (#7) and this ticket adds a lane kind rather than
// rewriting one, so nothing here widens the interface the headless path
// depends on. A real implementation satisfies both; the runtime takes them as
// two dependencies.

import type {
  AdvisoryAgentStatus,
  SteerObservationOutcome,
} from "../interactive/types.ts";
import type { AgentInfoView, AgentStartedView } from "./agent-json.ts";
import type {
  AgentPromptOptions,
  AgentStartOptions,
  PaneReportAgentOptions,
} from "./agent-argv.ts";

/**
 * The outcome of one prompt submission.
 *
 * It is deliberately NOT a boolean and deliberately not named "applied":
 * `--wait` tracks lifecycle state, not turns. An already-working agent's
 * active turn can satisfy the wait, and a prompt from a non-working state that
 * produces no observed change within 5000ms returns `agent_prompt_stalled`. So
 * this reports what was observed, and the caller records that observation as a
 * separate fact from the submission itself.
 */
export interface AgentPromptResult {
  readonly outcome: SteerObservationOutcome;
  readonly agent: AgentInfoView | null;
}

export interface HerdrAgentControl {
  /**
   * Start an interactive agent in a pane the RUNTIME already provisioned.
   * `herdr agent start` never creates, splits, or moves layout, so pane
   * topology stays the runtime's job. Returning means Herdr detected the
   * expected agent in that pane and considers it ready for input; a timeout or
   * rejection is a lane start failure, never an implicit retry.
   */
  startAgent(options: AgentStartOptions): Promise<AgentStartedView>;

  /** Submit text to a live session. See `AgentPromptResult` for what it proves. */
  promptAgent(
    target: string,
    text: string,
    options?: AgentPromptOptions,
  ): Promise<AgentPromptResult>;

  /** Send key presses; `esc` is the canonical cancel-turn key. */
  sendKeys(target: string, keys: readonly string[]): Promise<void>;

  /** Wait for one of `until`; null when the window elapsed without a match. */
  waitForState(
    target: string,
    until: readonly AdvisoryAgentStatus[],
    timeoutMs: number,
  ): Promise<AgentInfoView | null>;

  /**
   * Read an agent's live record. Null when Herdr has no such live agent —
   * which is the normal answer for a dead session, since agent state is
   * live-only and carries no history and no exit code.
   */
  getAgent(target: string): Promise<AgentInfoView | null>;

  /** Publish advisory state for the UI. Never evidence; released on lane end. */
  reportAgentState(options: PaneReportAgentOptions): Promise<void>;

  releaseAgentState(options: {
    readonly paneId: string;
    readonly source: string;
    readonly agent: string;
  }): Promise<void>;
}
