import { describe, expect, test } from "bun:test";
import { summarizeInspectCollection } from "../src/smoke/takeover-report.ts";

describe("takeover smoke inspect collection", () => {
  test("reports the terminal and runner evidence collected by inspect", () => {
    const summary = summarizeInspectCollection({
      exitCode: 0,
      runId: "run-smoke",
      laneId: "long",
      runtimeState: "exited",
      controlMode: "human_owned",
      contractState: "satisfied",
      verificationState: "verified",
      evidenceFile: "/tmp/long-evidence.json",
      evidence: {
        schemaVersion: 1,
        runId: "run-smoke",
        laneId: "long",
        command: "run long",
        stdoutArtifact: "/tmp/long.log",
        stderrArtifact: "/tmp/long.stderr.log",
        dispatchedAt: 10,
        liveAt: 20,
        completedAt: 30,
        exitCode: 0,
        signal: null,
        failure: null,
        environmentFailure: null,
        executionTimeout: null,
        termination: "sentinel-exit",
      },
    });

    expect(summary).toEqual({
      exitCode: 0,
      runtimeState: "exited",
      controlMode: "human_owned",
      contractState: "satisfied",
      verificationState: "verified",
      evidenceFile: "/tmp/long-evidence.json",
      evidence: {
        runId: "run-smoke",
        laneId: "long",
        exitCode: 0,
        completedAt: 30,
        termination: "sentinel-exit",
      },
    });
  });

  test("rejects a live lane because inspect has not collected terminal evidence", () => {
    expect(() =>
      summarizeInspectCollection({
        exitCode: 0,
        runId: "run-smoke",
        laneId: "long",
        runtimeState: "running",
        controlMode: "human_owned",
        contractState: "unknown",
        verificationState: "unverified",
        evidenceFile: null,
        evidence: null,
      }),
    ).toThrow("inspect did not collect terminal facts for human-owned lane");
  });
});
