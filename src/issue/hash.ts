import { createHash } from "node:crypto";
import type { MilestonePayload } from "./milestones.ts";

function serializeCanonical(
  value: unknown,
  ancestors: Set<object>,
): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      throw new TypeError("canonical JSON does not support bigint");
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON does not support circular values");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(
        value,
        (item) => serializeCanonical(item, ancestors) ?? "null",
      ).join(",")}]`;
    }

    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const serialized = serializeCanonical(
        (value as Record<string, unknown>)[key],
        ancestors,
      );
      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const serialized = serializeCanonical(value, new Set());
  if (serialized === undefined) {
    throw new TypeError("canonical JSON requires a JSON value");
  }
  return serialized;
}

function canonicalPayload(payload: MilestonePayload): unknown {
  if ("workflow" in payload) {
    return {
      hashVersion: payload.hashVersion,
      runId: payload.runId,
      workflow: payload.workflow,
      lanes: payload.lanes.map((lane) => ({
        laneId: lane.laneId,
        role: lane.role,
      })),
      fixedPoint:
        payload.fixedPoint === null
          ? null
          : {
              baseCommit: payload.fixedPoint.baseCommit,
              headCommit: payload.fixedPoint.headCommit,
              diffHash: payload.fixedPoint.diffHash,
              dirtyStatePolicy: payload.fixedPoint.dirtyStatePolicy,
            },
    };
  }
  if ("blockers" in payload) {
    return {
      hashVersion: payload.hashVersion,
      runId: payload.runId,
      laneId: payload.laneId,
      role: payload.role,
      blockers: payload.blockers,
      next: payload.next,
      gaps: payload.gaps,
      checkpointPointer: payload.checkpointPointer,
    };
  }
  if ("finishStatus" in payload) {
    return {
      hashVersion: payload.hashVersion,
      runId: payload.runId,
      finishStatus: payload.finishStatus,
      breakdown: {
        exitedZero: payload.breakdown.exitedZero,
        exitedNonZero: payload.breakdown.exitedNonZero,
        crashed: payload.breakdown.crashed,
        lost: payload.breakdown.lost,
        failedToStart: payload.breakdown.failedToStart,
      },
      lanes: payload.lanes.map((lane) => ({
        laneId: lane.laneId,
        role: lane.role,
        runtimeState: lane.runtimeState,
        exitCode: lane.exitCode,
        signal: lane.signal,
        semanticState: lane.semanticState,
        contractState: lane.contractState,
        contractErrors: lane.contractErrors,
        verificationState: lane.verificationState,
        gaps: lane.gaps,
        resultPointer: lane.resultPointer,
        evidencePointer: lane.evidencePointer,
        checkpointPointer: lane.checkpointPointer,
        // Who authored the checkpoint changes the rendered public claim, so it
        // is part of the payload's identity: a changed attribution is drift.
        checkpointOrigin: lane.checkpointOrigin,
      })),
    };
  }
  if ("decision" in payload) {
    return {
      hashVersion: payload.hashVersion,
      runId: payload.runId,
      decision: payload.decision,
      note: payload.note,
      resultingIssueState: payload.resultingIssueState,
    };
  }
  throw new TypeError("unknown milestone payload shape");
}

export function canonicalPayloadHash(payload: MilestonePayload): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalPayload(payload)), "utf8")
    .digest("hex");
}
