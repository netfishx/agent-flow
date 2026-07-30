import { describe, expect, test } from "bun:test";
import { extractClaudeReport, parseCodexSessionId, parseCodexTokensUsed } from "../src/index.ts";

const RESULT_EVENT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "VERDICT: approve\nCONFIDENCE: high\nFINDINGS: none\n",
  session_id: "f48e2d54-236d-4da6-9e03-893d5ea40eb8",
  usage: { input_tokens: 21, output_tokens: 8 },
};

describe("extractClaudeReport", () => {
  test("copies the result field verbatim with session id and tokens", () => {
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
      JSON.stringify({ type: "stream_event", session_id: "x" }),
      JSON.stringify(RESULT_EVENT),
      "",
    ].join("\n");
    expect(extractClaudeReport(ndjson)).toEqual({
      ok: true,
      reportText: RESULT_EVENT.result,
      sessionId: RESULT_EVENT.session_id,
      tokens: { inputTokens: 21, outputTokens: 8 },
    });
  });

  test("a stream without a result event is a derivation failure", () => {
    const ndjson = `${JSON.stringify({ type: "system" })}\n`;
    expect(extractClaudeReport(ndjson)).toEqual({
      ok: false,
      error: "raw stream contains no result event",
    });
  });

  test("a non-JSON line is a derivation failure naming the line", () => {
    const ndjson = `${JSON.stringify({ type: "system" })}\nnot-json\n`;
    expect(extractClaudeReport(ndjson)).toEqual({
      ok: false,
      error: "raw stream line 2 is not valid JSON",
    });
  });

  test("a result event without a textual result field fails", () => {
    const ndjson = `${JSON.stringify({ type: "result", result: 42 })}\n`;
    expect(extractClaudeReport(ndjson)).toEqual({
      ok: false,
      error: "result event carries no textual result field",
    });
  });
});

describe("codex stderr parsing", () => {
  const STDERR = `Reading additional input from stdin...
OpenAI Codex v0.146.0
--------
workdir: /tmp/wt
model: gpt-5.6-sol
sandbox: read-only
session id: 019fb080-9dc7-7173-8893-97f6f777329b
--------
codex
ok
tokens used
25,512
`;

  test("parses the session id from the lane's own stderr banner", () => {
    expect(parseCodexSessionId(STDERR)).toBe(
      "019fb080-9dc7-7173-8893-97f6f777329b",
    );
  });

  test("returns null when the banner line is absent", () => {
    expect(parseCodexSessionId("no banner here\n")).toBeNull();
  });

  test("parses the tokens-used counter", () => {
    expect(parseCodexTokensUsed(STDERR)).toBe(25512);
    expect(parseCodexTokensUsed("tokens used\n")).toBeNull();
  });
});
