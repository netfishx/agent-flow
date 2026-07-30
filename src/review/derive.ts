// Post-exit derivation for agent lanes. Everything here is a pure function
// over the lane's own captured bytes: the raw report is the first-class
// artifact, and the report text, contract outcome, checkpoint, session
// identity, and token counts are derived copies — never rewrites. A
// derivation failure loses nothing: errors point back at the raw artifact.

import { extractClaudeReport } from "./claude-stream.ts";
import type { ReviewAgentKind } from "./commands.ts";
import { validateReportContract } from "./contract.ts";
import {
  parseCodexSessionId,
  parseCodexTokensUsed,
  type SessionIdentity,
} from "./session.ts";

export interface AgentLaneCapture {
  readonly agentKind: ReviewAgentKind;
  /** The raw report bytes, or null when the artifact is unreadable. */
  readonly raw: string | null;
  /** Absolute path of the raw artifact, for error pointers. */
  readonly rawPath: string;
  /** The lane's durable stderr bytes, or null when unreadable. */
  readonly stderr: string | null;
  readonly preassignedSessionId: string | null;
  /** The exit code parsed from the sentinel; null when the lane crashed. */
  readonly exitCode: number | null;
}

export interface LaneTokenFacts {
  readonly source: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AgentLaneDerivation {
  /** The reviewer's report text; null when derivation failed. */
  readonly reportText: string | null;
  /** Contract and derivation errors; empty means the contract is satisfied. */
  readonly contractErrors: readonly string[];
  /** Derived checkpoint markdown; null leaves the semantic dimension unknown. */
  readonly checkpointText: string | null;
  readonly session: SessionIdentity;
  readonly tokens: LaneTokenFacts | null;
}

function deriveReport(capture: AgentLaneCapture): {
  reportText: string | null;
  errors: string[];
  sessionEcho: string | null;
  tokens: LaneTokenFacts | null;
} {
  if (capture.raw === null) {
    return {
      reportText: null,
      errors: [`raw report unavailable: ${capture.rawPath}`],
      sessionEcho: null,
      tokens: null,
    };
  }
  if (capture.agentKind === "claude") {
    const extraction = extractClaudeReport(capture.raw);
    if (!extraction.ok) {
      return {
        reportText: null,
        errors: [`${extraction.error} (raw artifact: ${capture.rawPath})`],
        sessionEcho: null,
        tokens: null,
      };
    }
    return {
      reportText: extraction.reportText,
      errors: [],
      sessionEcho: extraction.sessionId,
      tokens:
        extraction.tokens === null
          ? null
          : {
              source: "claude result event",
              inputTokens: extraction.tokens.inputTokens,
              outputTokens: extraction.tokens.outputTokens,
              totalTokens:
                extraction.tokens.inputTokens + extraction.tokens.outputTokens,
            },
    };
  }
  const tokens =
    capture.agentKind === "codex" && capture.stderr !== null
      ? parseCodexTokensUsed(capture.stderr)
      : null;
  return {
    reportText: capture.raw,
    errors: [],
    sessionEcho: null,
    tokens:
      tokens === null
        ? null
        : {
            source: "codex stderr tokens-used line",
            inputTokens: null,
            outputTokens: null,
            totalTokens: tokens,
          },
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

function checkpoint(
  status: "complete" | "partial",
  blockers: string,
  gaps: readonly string[],
  artifacts: readonly string[],
): string {
  const gapLines =
    gaps.length === 0 ? "- none" : gaps.map((gap) => `- ${gap}`).join("\n");
  const artifactLines = artifacts.map((path) => `- ${path}`).join("\n");
  return `STATUS: ${status}
PHASE: review
COMPLETED:
- reviewer report captured
NEXT:
- none
BLOCKERS:
${blockers}
ARTIFACTS:
${artifactLines}
VERIFICATION_CLAIMS:
- report contract validated mechanically
GAPS:
${gapLines}
`;
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

  let checkpointText: string | null = null;
  const artifacts = [capture.rawPath];
  if (capture.exitCode === 0) {
    checkpointText =
      contractErrors.length === 0
        ? checkpoint("complete", "- none", [], artifacts)
        : checkpoint("partial", "- none", contractErrors, artifacts);
  } else if (capture.exitCode === 130) {
    checkpointText = checkpoint(
      "partial",
      "- interrupted by SIGINT",
      contractErrors,
      artifacts,
    );
  }

  return {
    reportText: report.reportText,
    contractErrors,
    checkpointText,
    session: deriveSession(capture, report.sessionEcho),
    tokens: report.tokens,
  };
}
