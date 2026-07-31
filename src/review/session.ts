// Session identity for reviewer lanes. Only causally-tied evidence is
// admissible: a pre-assigned UUID in the lane's own dispatched command, or an
// id parsed from that lane's own captured output. Scanning session directories
// for the newest file is forbidden — concurrent lanes would cross-attribute.

const CODEX_SESSION_LINE = /^session id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m;
const CODEX_TOKENS_LINE = /^tokens used\r?\n([\d,]+)\s*$/m;

/** Parse the `session id: <uuid>` banner line from a codex lane's stderr. */
export function parseCodexSessionId(stderr: string): string | null {
  return stderr.match(CODEX_SESSION_LINE)?.[1] ?? null;
}

/** Parse the trailing `tokens used` counter from a codex lane's stderr. */
export function parseCodexTokensUsed(stderr: string): number | null {
  const digits = stderr.match(CODEX_TOKENS_LINE)?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits.replaceAll(",", ""), 10);
}
