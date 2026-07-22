// Constructors and canonical reasons for the measured/unavailable metrics.
// Keeping the "unavailable" reasons here makes it a single edit to sharpen the
// language, and keeps every call site honest: a metric is either a real number
// or a stated reason, never an absent field.

import type { TimingMetric, TokenMetric } from "./types.ts";

export function measured(ms: number): TimingMetric {
  return { kind: "measured", ms };
}

export function unavailable(reason: string): TimingMetric {
  return { kind: "unavailable", reason };
}

export function tokensUnavailable(reason: string): TokenMetric {
  return { kind: "unavailable", reason };
}

export const REASONS = {
  simulatedNoModel: "simulated lane runs no model",
  simulatedNoTokens:
    "simulated lanes run no model; headless agent CLIs expose no token counts",
  laneNotComplete: "lane has not completed",
  laneNotStarted: "lane process not yet observed live",
  noCheckpoint: "no human checkpoint touched this lane",
  runNotDispatched: "run not fully dispatched",
} as const;
