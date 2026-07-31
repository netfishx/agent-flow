import { join } from "node:path";
import type { SemanticState } from "./events.ts";

export interface ParsedCheckpoint {
  readonly status: "complete" | "partial" | "blocked" | "unknown" | null;
  readonly blockers: readonly string[];
  readonly next: readonly string[];
  readonly gaps: readonly string[];
  readonly artifacts: readonly string[];
  readonly verificationClaims: readonly string[];
}

export function checkpointSemanticSignature(input: {
  readonly status: SemanticState;
  readonly blockers?: readonly string[];
  readonly next?: readonly string[];
  readonly gaps?: readonly string[];
}): string {
  return JSON.stringify([
    input.status,
    input.blockers ?? [],
    input.next ?? [],
    input.gaps ?? [],
  ]);
}

export function laneCheckpointFile(
  cwd: string,
  runId: string,
  laneId: string,
): string {
  return join(cwd, runId, "checkpoints", `${laneId}.md`);
}

type CheckpointSection =
  | "BLOCKERS"
  | "NEXT"
  | "GAPS"
  | "ARTIFACTS"
  | "VERIFICATION_CLAIMS";

const SECTIONS: Readonly<Record<CheckpointSection, keyof ParsedCheckpoint>> = {
  BLOCKERS: "blockers",
  NEXT: "next",
  GAPS: "gaps",
  ARTIFACTS: "artifacts",
  VERIFICATION_CLAIMS: "verificationClaims",
};

function normalizedItems(items: readonly string[]): readonly string[] {
  return items.length === 1 && items[0]!.toLowerCase() === "none" ? [] : items;
}

export function parseCheckpoint(text: string): ParsedCheckpoint {
  const statusMatch = text.match(
    // `unknown` is the runtime-derived terminal record's honest status for a
    // crashed or lost lane. The runtime writes it, so the parser must read it:
    // a record our own parser cannot classify is not a durable record.
    /^STATUS:\s*(complete|partial|blocked|unknown)\s*$/m,
  );
  const collected: Record<CheckpointSection, string[]> = {
    BLOCKERS: [],
    NEXT: [],
    GAPS: [],
    ARTIFACTS: [],
    VERIFICATION_CLAIMS: [],
  };
  let section: CheckpointSection | null = null;

  for (const line of text.split(/\r?\n/)) {
    const header = line.trim().match(/^([A-Z_]+):$/);
    if (header) {
      section =
        header[1] !== undefined && header[1] in SECTIONS
          ? (header[1] as CheckpointSection)
          : null;
      continue;
    }
    const item = line.match(/^\s*-\s+(.+?)\s*$/);
    if (section !== null && item?.[1] !== undefined) {
      collected[section].push(item[1]);
    }
  }

  const parsedStatus = statusMatch?.[1]?.toLowerCase();
  return {
    status:
      parsedStatus === "complete" ||
      parsedStatus === "partial" ||
      parsedStatus === "blocked" ||
      parsedStatus === "unknown"
        ? parsedStatus
        : null,
    blockers: normalizedItems(collected.BLOCKERS),
    next: normalizedItems(collected.NEXT),
    gaps: normalizedItems(collected.GAPS),
    artifacts: normalizedItems(collected.ARTIFACTS),
    verificationClaims: normalizedItems(collected.VERIFICATION_CLAIMS),
  };
}
