import { describe, expect, test } from "bun:test";
import {
  assertHandleId,
  laneSentinelRegex,
  laneSentinelToken,
  parseExitFromSentinel,
} from "../src/runtime/ids.ts";

describe("sentinel tokens", () => {
  test("are specific to both run and lane", () => {
    expect(laneSentinelToken("run1", "lane-2")).toBe("FLOW_run1_LANE_lane-2_EXIT");
    // distinct lane
    expect(laneSentinelToken("run1", "lane-2")).not.toBe(
      laneSentinelToken("run1", "lane-3"),
    );
    // distinct run
    expect(laneSentinelToken("run1", "lane-2")).not.toBe(
      laneSentinelToken("run2", "lane-2"),
    );
  });

  test("regex escapes the token and matches an exit line", () => {
    const re = new RegExp(laneSentinelRegex("run1", "lane-2"));
    expect(re.test("FLOW_run1_LANE_lane-2_EXIT=0")).toBe(true);
    expect(re.test("FLOW_run1_LANE_lane-2_EXIT=130")).toBe(true);
    expect(re.test("FLOW_run1_LANE_lane-3_EXIT=0")).toBe(false);
  });
});

describe("parseExitFromSentinel", () => {
  test("reads the exit code from durable output", () => {
    const out = "STEP=5/5\nSTEP=5 EVENT=done\nFLOW_run1_LANE_lane-2_EXIT=0";
    expect(parseExitFromSentinel("run1", "lane-2", out)).toBe(0);
  });
  test("reads a non-zero (interrupted) exit code", () => {
    const out = "STEP=9 EVENT=interrupted-SIGINT\nFLOW_run1_LANE_lane-2_EXIT=130";
    expect(parseExitFromSentinel("run1", "lane-2", out)).toBe(130);
  });
  test("returns null when its own sentinel is absent", () => {
    const out = "STEP=1\nFLOW_run1_LANE_lane-3_EXIT=0";
    expect(parseExitFromSentinel("run1", "lane-2", out)).toBeNull();
  });
  test("takes the last occurrence", () => {
    const out = "FLOW_run1_LANE_lane-2_EXIT=0\nFLOW_run1_LANE_lane-2_EXIT=130";
    expect(parseExitFromSentinel("run1", "lane-2", out)).toBe(130);
  });
});

describe("assertHandleId", () => {
  test("accepts letters, digits, and dashes", () => {
    expect(() => assertHandleId("laneId", "lane-2")).not.toThrow();
    expect(() => assertHandleId("runId", "flow-abc123")).not.toThrow();
  });
  test("rejects underscores and other separators", () => {
    expect(() => assertHandleId("laneId", "lane_2")).toThrow();
    expect(() => assertHandleId("laneId", "lane 2")).toThrow();
    expect(() => assertHandleId("laneId", "lane/2")).toThrow();
  });
});
