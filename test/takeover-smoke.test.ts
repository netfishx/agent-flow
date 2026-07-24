import { describe, expect, test } from "bun:test";
import {
  summarizeInSliceAbort,
  summarizeInspectCollection,
  summarizePostReleaseDrive,
} from "../src/smoke/takeover-report.ts";

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

describe("takeover smoke live-drive proof", () => {
  test("accepts one active wait followed by ownership abort and sibling completion", () => {
    expect(
      summarizeInSliceAbort({
        waitStarted: true,
        targetWaitCount: 1,
        controllerThrew: false,
        ownedRuntimeState: "running",
        ownedControlMode: "human_owned",
        siblingComplete: true,
      }),
    ).toEqual({
      waitStarted: true,
      targetWaitCount: 1,
      noFurtherWait: true,
      controllerThrew: false,
      ownedRuntimeState: "running",
      ownedControlMode: "human_owned",
      siblingComplete: true,
    });
  });

  test("rejects a second owned-lane wait after takeover", () => {
    expect(() =>
      summarizeInSliceAbort({
        waitStarted: true,
        targetWaitCount: 2,
        controllerThrew: false,
        ownedRuntimeState: "running",
        ownedControlMode: "human_owned",
        siblingComplete: true,
      }),
    ).toThrow("smoke did not prove an in-slice ownership abort");
  });

  test("accepts release of a live lane followed by a real wait and exit", () => {
    expect(
      summarizePostReleaseDrive({
        wasRunningBeforeRelease: true,
        waitStarted: true,
        targetWaitCount: 3,
        controllerThrew: false,
        runtimeState: "exited",
        exitCode: 0,
      }),
    ).toEqual({
      wasRunningBeforeRelease: true,
      waitStarted: true,
      targetWaitCount: 3,
      controllerThrew: false,
      runtimeState: "exited",
      exitCode: 0,
    });
  });

  test("rejects a read-only resume after release", () => {
    expect(() =>
      summarizePostReleaseDrive({
        wasRunningBeforeRelease: false,
        waitStarted: false,
        targetWaitCount: 0,
        controllerThrew: false,
        runtimeState: "exited",
        exitCode: 0,
      }),
    ).toThrow("smoke did not prove post-release managed drive");
  });
});
