// Run/lane identifiers and the completion sentinels derived from them. Each lane
// gets a token that is unique to BOTH its run and its lane, so a wait can never
// match a stale run's output or a sibling lane's sentinel.

import { escapeRegex } from "../herdr/argv.ts";

// Handles use "_" as the token separator, so handle ids must exclude it.
const HANDLE_PATTERN = /^[A-Za-z0-9-]+$/;

export function assertHandleId(kind: string, value: string): void {
  if (!HANDLE_PATTERN.test(value)) {
    throw new Error(
      `invalid ${kind} "${value}": only letters, digits, and "-" are allowed`,
    );
  }
}

/**
 * The one sentinel contract. `kind` names what the token belongs to — `LANE`
 * for a dispatched lane, `RUNNER` for an interactive lane's independent
 * verification run — so both share this shape and neither can match the
 * other's output.
 */
export function sentinelToken(
  runId: string,
  kind: string,
  id: string,
): string {
  return `FLOW_${runId}_${kind}_${id}_EXIT`;
}

export function sentinelRegex(
  runId: string,
  kind: string,
  id: string,
): string {
  return `${escapeRegex(sentinelToken(runId, kind, id))}=[0-9]+`;
}

/** Parse the last `<token>=<digits>` occurrence from durable output. */
export function parseSentinelExit(
  runId: string,
  kind: string,
  id: string,
  output: string,
): number | null {
  const re = new RegExp(
    `${escapeRegex(sentinelToken(runId, kind, id))}=([0-9]+)`,
    "g",
  );
  let last: number | null = null;
  for (const match of output.matchAll(re)) {
    const digits = match[1];
    if (digits !== undefined) last = Number.parseInt(digits, 10);
  }
  return last;
}

export function laneSentinelToken(runId: string, laneId: string): string {
  return sentinelToken(runId, "LANE", laneId);
}

export function laneSentinelRegex(runId: string, laneId: string): string {
  return sentinelRegex(runId, "LANE", laneId);
}

export function parseExitFromSentinel(
  runId: string,
  laneId: string,
  output: string,
): number | null {
  return parseSentinelExit(runId, "LANE", laneId, output);
}
