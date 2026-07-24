import { describe, expect, test } from "bun:test";
import { FakeHerdrAdapter } from "../src/herdr/fake-adapter.ts";
import type { PaneRef, WaitOutcome } from "../src/herdr/types.ts";
import {
  summarizeControllerLossResume,
  summarizeInSliceAbort,
  summarizeInspectCollection,
  summarizePostReleaseDrive,
} from "../src/smoke/takeover-report.ts";
import { TrackingHerdrAdapter } from "../src/smoke/tracking-adapter.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ControlledWaitAdapter extends FakeHerdrAdapter {
  readonly entered = deferred<void>();
  private readonly outcome = deferred<WaitOutcome>();

  constructor(private readonly order: string[]) {
    super();
  }

  release(outcome: WaitOutcome): void {
    this.outcome.resolve(outcome);
  }

  override waitForOutput(
    _pane: PaneRef,
    _regex: string,
    _timeoutMs: number,
  ): Promise<WaitOutcome> {
    this.order.push("entered");
    this.entered.resolve();
    return this.outcome.promise;
  }
}

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
  test("publishes the marker only after the base wait has started", async () => {
    const order: string[] = [];
    const base = new ControlledWaitAdapter(order);
    const markerPublished = deferred<void>();
    const adapter = new TrackingHerdrAdapter(
      base,
      "pane-owned",
      async () => {
        order.push("marker");
        markerPublished.resolve();
      },
    );
    const expected = { matched: false, timedOut: true } as const;

    const pending = adapter.waitForOutput(
      { id: "pane-owned" },
      "sentinel",
      2_000,
    );
    await markerPublished.promise;
    await base.entered.promise;
    base.release(expected);

    expect(order).toEqual(["entered", "marker"]);
    expect(await pending).toEqual(expected);
    await adapter.interruptPane({ id: "pane-owned" });
    expect(adapter.waitCount("pane-owned")).toBe(1);
    expect(adapter.interruptCount("pane-owned")).toBe(1);
    expect(adapter.waitCount("pane-other")).toBe(0);
    expect(adapter.interruptCount("pane-other")).toBe(0);
  });

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

  test("accepts controller-loss resume with zero drive on both owned lanes", () => {
    expect(
      summarizeControllerLossResume({
        controllerThrew: false,
        ownedLanes: [
          {
            laneId: "long-owned",
            waitForOutputCount: 0,
            interruptPaneCount: 0,
            controlMode: "human_owned",
            runtimeState: "running",
            processLive: true,
          },
          {
            laneId: "long-release",
            waitForOutputCount: 0,
            interruptPaneCount: 0,
            controlMode: "human_owned",
            runtimeState: "running",
            processLive: true,
          },
        ],
      }),
    ).toEqual({
      controllerThrew: false,
      ownedLanes: [
        {
          laneId: "long-owned",
          waitForOutputCount: 0,
          interruptPaneCount: 0,
          controlMode: "human_owned",
          runtimeState: "running",
          processLive: true,
        },
        {
          laneId: "long-release",
          waitForOutputCount: 0,
          interruptPaneCount: 0,
          controlMode: "human_owned",
          runtimeState: "running",
          processLive: true,
        },
      ],
      reconciledWithoutDrive: true,
    });
  });

  test("rejects controller-loss resume after any owned-lane wait", () => {
    expect(() =>
      summarizeControllerLossResume({
        controllerThrew: false,
        ownedLanes: [
          {
            laneId: "long-owned",
            waitForOutputCount: 1,
            interruptPaneCount: 0,
            controlMode: "human_owned",
            runtimeState: "running",
            processLive: true,
          },
          {
            laneId: "long-release",
            waitForOutputCount: 0,
            interruptPaneCount: 0,
            controlMode: "human_owned",
            runtimeState: "running",
            processLive: true,
          },
        ],
      }),
    ).toThrow("smoke did not prove controller-loss reconcile without drive");
  });

  test("rejects controller-loss resume after any owned-lane interrupt", () => {
    expect(() =>
      summarizeControllerLossResume({
        controllerThrew: false,
        ownedLanes: [
          {
            laneId: "long-owned",
            waitForOutputCount: 0,
            interruptPaneCount: 0,
            controlMode: "human_owned",
            runtimeState: "running",
            processLive: true,
          },
          {
            laneId: "long-release",
            waitForOutputCount: 0,
            interruptPaneCount: 1,
            controlMode: "human_owned",
            runtimeState: "running",
            processLive: true,
          },
        ],
      }),
    ).toThrow("smoke did not prove controller-loss reconcile without drive");
  });

  test("rejects controller-loss resume when ownership or liveness is lost", () => {
    const validLane = {
      laneId: "long-release",
      waitForOutputCount: 0,
      interruptPaneCount: 0,
      controlMode: "human_owned" as const,
      runtimeState: "running" as const,
      processLive: true,
    };
    for (const invalidLane of [
      {
        ...validLane,
        laneId: "managed",
        controlMode: "managed" as const,
      },
      {
        ...validLane,
        laneId: "terminal",
        runtimeState: "exited" as const,
        processLive: false,
      },
    ]) {
      expect(() =>
        summarizeControllerLossResume({
          controllerThrew: false,
          ownedLanes: [invalidLane, validLane],
        }),
      ).toThrow("smoke did not prove controller-loss reconcile without drive");
    }
  });
});
