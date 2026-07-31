// Post-exit derivation for agent lanes. Everything here is a pure function
// over the lane's own captured bytes: the raw report is the first-class
// artifact, and the report text, contract outcome, checkpoint, session
// identity, and token counts are derived copies — never rewrites. A
// derivation failure loses nothing: errors point back at the raw artifact.

import type { RawReportOutcome } from "../runtime/events.ts";
import { extractClaudeReport } from "./claude-stream.ts";
import { validateReportContract } from "./contract.ts";
import { parseCodexSessionId, parseCodexTokensUsed } from "./session.ts";
import type { ReviewAgentKind, SessionIdentity } from "./types.ts";

/** How a lane reached its terminal state, as the runtime observed it. */
export type LaneTermination = "exited" | "crashed" | "lost";

export interface AgentLaneCapture {
  readonly agentKind: ReviewAgentKind;
  /** The raw report bytes, or null when the artifact is unreadable. */
  readonly raw: string | null;
  /** Absolute path of the raw artifact, for error pointers. */
  readonly rawPath: string;
  /** The lane's durable stderr bytes, or null when unreadable. */
  readonly stderr: string | null;
  readonly preassignedSessionId: string | null;
  /** The exit code parsed from the sentinel; null when there was none. */
  readonly exitCode: number | null;
  readonly termination: LaneTermination;
  /** Whether a human interrupt was recorded against this lane. */
  readonly interrupted: boolean;
  /** Terminal context such as the lost cause; null when there is none. */
  readonly terminationDetail: string | null;
}

export interface LaneTokenFacts {
  readonly source: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/** Token counts are measured from the lane's own output, or explicitly not. */
export type LaneTokens =
  | LaneTokenFacts
  | { readonly unavailable: string };

export interface AgentLaneDerivation {
  /** The reviewer's report text; null when derivation failed. */
  readonly reportText: string | null;
  /** Contract and derivation errors; empty means the contract is satisfied. */
  readonly contractErrors: readonly string[];
  /**
   * The runtime-derived terminal record. Every lane that ran gets one, whatever
   * its terminal state, and the text says plainly that the runtime wrote it.
   */
  readonly checkpointText: string;
  /**
   * `unknown` where the runtime genuinely cannot tell how far the reviewer got:
   * a crashed or lost lane left no evidence of progress, and claiming `partial`
   * would assert progress nobody observed.
   */
  readonly checkpointStatus: "complete" | "partial" | "unknown";
  readonly session: SessionIdentity;
  readonly tokens: LaneTokens;
  /** The runner's objective fact about the raw artifact. */
  readonly rawOutcome: RawReportOutcome;
}

function deriveReport(capture: AgentLaneCapture): {
  reportText: string | null;
  errors: string[];
  sessionEcho: string | null;
  tokens: LaneTokens;
  rawOutcome: RawReportOutcome;
} {
  if (capture.raw === null) {
    return {
      reportText: null,
      errors: [`raw report unavailable: ${capture.rawPath}`],
      sessionEcho: null,
      tokens: { unavailable: "raw report unavailable" },
      rawOutcome: "missing",
    };
  }
  if (capture.agentKind === "claude") {
    const extraction = extractClaudeReport(capture.raw);
    if (!extraction.ok) {
      return {
        reportText: null,
        errors: [`${extraction.error} (raw artifact: ${capture.rawPath})`],
        sessionEcho: null,
        tokens: { unavailable: "raw stream not derivable" },
        rawOutcome: "underivable",
      };
    }
    return {
      reportText: extraction.reportText,
      errors: [],
      sessionEcho: extraction.sessionId,
      rawOutcome: "captured",
      tokens:
        extraction.tokens === null
          ? { unavailable: "result event carried no usage" }
          : {
              source: "claude result event",
              inputTokens: extraction.tokens.inputTokens,
              outputTokens: extraction.tokens.outputTokens,
              totalTokens:
                extraction.tokens.inputTokens + extraction.tokens.outputTokens,
            },
    };
  }
  if (capture.agentKind === "codex") {
    const tokens =
      capture.stderr === null ? null : parseCodexTokensUsed(capture.stderr);
    return {
      reportText: capture.raw,
      errors: [],
      sessionEcho: null,
      rawOutcome: "captured",
      tokens:
        tokens === null
          ? {
              unavailable:
                capture.stderr === null
                  ? "lane stderr artifact is unreadable"
                  : "no tokens-used line in the lane's stderr",
            }
          : {
              source: "codex stderr tokens-used line",
              inputTokens: null,
              outputTokens: null,
              totalTokens: tokens,
            },
    };
  }
  return {
    reportText: capture.raw,
    errors: [],
    sessionEcho: null,
    rawOutcome: "captured",
    tokens: { unavailable: "grok plain output carries no token counts" },
  };
}

function deriveSession(
  capture: AgentLaneCapture,
  sessionEcho: string | null,
): SessionIdentity {
  switch (capture.agentKind) {
    case "claude": {
      if (sessionEcho !== null) {
        return {
          kind: "measured",
          id: sessionEcho,
          evidence:
            sessionEcho === capture.preassignedSessionId
              ? "pre-assigned via --session-id; echoed by the lane's raw stream"
              : "echoed by the lane's raw stream (differs from the pre-assigned id)",
        };
      }
      if (capture.preassignedSessionId !== null) {
        return {
          kind: "measured",
          id: capture.preassignedSessionId,
          evidence: "pre-assigned via --session-id in the dispatched command",
        };
      }
      return {
        kind: "unavailable",
        reason: "no pre-assigned id and no echo in the lane's raw stream",
      };
    }
    case "grok": {
      if (capture.preassignedSessionId !== null) {
        return {
          kind: "measured",
          id: capture.preassignedSessionId,
          evidence: "pre-assigned via --session-id in the dispatched command",
        };
      }
      return { kind: "unavailable", reason: "no pre-assigned session id" };
    }
    case "codex": {
      const parsed =
        capture.stderr === null ? null : parseCodexSessionId(capture.stderr);
      if (parsed !== null) {
        return {
          kind: "measured",
          id: parsed,
          evidence: "parsed from the lane's own stderr `session id:` line",
        };
      }
      return {
        kind: "unavailable",
        reason:
          capture.stderr === null
            ? "lane stderr artifact is unreadable"
            : "no `session id:` line in the lane's stderr",
      };
    }
  }
}

/**
 * The runtime-derived terminal record. It is NOT the Agent's voice: the phase
 * names its mechanical origin, it claims no verification, and it never invents
 * a verdict, a finding, or a semantic claim the lane's own bytes do not carry.
 * The raw artifact is listed whatever became of it, so a lost report stays a
 * recorded fact rather than an absence.
 */
function terminalRecord(input: {
  readonly status: "complete" | "partial" | "unknown";
  readonly completed: string;
  readonly blockers: readonly string[];
  readonly gaps: readonly string[];
  readonly rawPath: string;
  readonly rawOutcome: RawReportOutcome;
}): string {
  const list = (items: readonly string[]): string =>
    items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");
  const rawNote =
    input.rawOutcome === "captured"
      ? ""
      : input.rawOutcome === "missing"
        ? " (not produced)"
        : " (present, but no report text could be derived from it)";
  return `STATUS: ${input.status}
PHASE: runtime-derived-terminal-record
COMPLETED:
- ${input.completed}
NEXT:
- none
BLOCKERS:
${list(input.blockers)}
ARTIFACTS:
- ${input.rawPath}${rawNote}
VERIFICATION_CLAIMS:
- none
GAPS:
${list(input.gaps)}
`;
}

function exitedRecord(
  capture: AgentLaneCapture,
  contractErrors: readonly string[],
): { status: "complete" | "partial"; completed: string; blockers: string[] } {
  if (capture.exitCode === 0) {
    return contractErrors.length === 0
      ? {
          status: "complete",
          completed: "the lane exited 0 and its report satisfied the contract",
          blockers: [],
        }
      : {
          status: "partial",
          completed:
            "the lane exited 0; its report did not satisfy the contract",
          blockers: [],
        };
  }
  const code = capture.exitCode === null ? "an unknown code" : `${capture.exitCode}`;
  // A CLI may catch SIGINT and exit with its own status, so the interrupt fact
  // comes from the ledger, never from guessing at the exit code.
  return capture.interrupted
    ? {
        status: "partial",
        completed: `the lane was interrupted and exited ${code}`,
        blockers: [`interrupted by SIGINT; the CLI exited ${code}`],
      }
    : {
        status: "partial",
        completed: `the lane exited ${code}`,
        blockers: [`the CLI exited ${code}`],
      };
}

/** Derive every post-exit fact of an agent lane from its captured bytes. */
export function deriveAgentLaneFacts(
  capture: AgentLaneCapture,
): AgentLaneDerivation {
  const report = deriveReport(capture);
  const contractErrors = [...report.errors];
  if (report.reportText !== null) {
    contractErrors.push(
      ...validateReportContract(report.reportText).errors,
    );
  }

  // Every terminal state gets an honest record. Exit code 130 is not a
  // precondition: real CLIs catch SIGINT and exit with codes of their own,
  // and a crashed or lost lane still owes the ledger a terminal record.
  const outcome =
    capture.termination === "exited"
      ? exitedRecord(capture, contractErrors)
      : capture.termination === "crashed"
        ? {
            // No evidence of progress survives, so the semantic state stays
            // unknown; the record itself is still written and still honest.
            status: "unknown" as const,
            completed: "the lane process is gone",
            blockers: [
              capture.terminationDetail ??
                "no completion sentinel was found in the lane's durable log",
            ],
          }
        : {
            status: "unknown" as const,
            completed: "the lane was lost before it could report",
            blockers: [
              `lane lost: ${capture.terminationDetail ?? "cause unrecorded"}`,
            ],
          };

  return {
    reportText: report.reportText,
    contractErrors,
    checkpointStatus: outcome.status,
    checkpointText: terminalRecord({
      status: outcome.status,
      completed: outcome.completed,
      blockers: outcome.blockers,
      gaps: contractErrors,
      rawPath: capture.rawPath,
      rawOutcome: report.rawOutcome,
    }),
    session: deriveSession(capture, report.sessionEcho),
    tokens: report.tokens,
    rawOutcome: report.rawOutcome,
  };
}
