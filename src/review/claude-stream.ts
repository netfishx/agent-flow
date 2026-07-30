// Mechanical extraction from a claude -p stream-json capture. The NDJSON
// stream is the immutable raw artifact; the report text is the `result` field
// of the final result event, copied verbatim — never rewritten.

export type ClaudeReportExtraction =
  | {
      readonly ok: true;
      readonly reportText: string;
      /** The session id echoed by the stream's events, when present. */
      readonly sessionId: string | null;
      readonly tokens: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      } | null;
    }
  | { readonly ok: false; readonly error: string };

interface ResultEventShape {
  readonly type?: unknown;
  readonly result?: unknown;
  readonly session_id?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
  };
}

export function extractClaudeReport(ndjson: string): ClaudeReportExtraction {
  let resultEvent: ResultEventShape | null = null;
  let lineNumber = 0;
  for (const line of ndjson.split("\n")) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return {
        ok: false,
        error: `raw stream line ${lineNumber} is not valid JSON`,
      };
    }
    if (
      typeof event === "object" &&
      event !== null &&
      (event as ResultEventShape).type === "result"
    ) {
      resultEvent = event as ResultEventShape;
    }
  }
  if (resultEvent === null) {
    return { ok: false, error: "raw stream contains no result event" };
  }
  if (typeof resultEvent.result !== "string") {
    return {
      ok: false,
      error: "result event carries no textual result field",
    };
  }
  const usage = resultEvent.usage;
  const tokens =
    usage &&
    typeof usage.input_tokens === "number" &&
    typeof usage.output_tokens === "number"
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        }
      : null;
  return {
    ok: true,
    reportText: resultEvent.result,
    sessionId:
      typeof resultEvent.session_id === "string"
        ? resultEvent.session_id
        : null,
    tokens,
  };
}
