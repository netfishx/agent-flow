// Smoke-internal controller-loss handoff. This is NOT part of the public
// runtime interface (it is not re-exported from index.ts): it exists only so the
// controller-loss smoke can hand a dispatched run from an exiting dispatcher to
// a fresh controller. It is a one-shot static topology, deliberately NOT the #5
// durable ledger, event stream, or work-resume model.

import { laneSentinelToken } from "../runtime/ids.ts";
import {
  type LaneRecord,
  type RunRecord,
  WorkflowRuntime,
} from "../runtime/runtime.ts";
import type { RunHandle } from "../runtime/types.ts";

interface RunTopology {
  readonly v: 1;
  readonly runId: string;
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly splitDirection: "right" | "down";
  readonly tabId: string;
  readonly controllerPaneId: string;
  readonly startedAt: number;
  readonly dispatchedAt: number | null;
  readonly lanes: readonly {
    readonly laneId: string;
    readonly paneId: string;
    readonly logFile: string;
    readonly steps: number;
    readonly stepDelaySeconds: number;
    readonly dispatchedAt: number | null;
    readonly liveAt: number | null;
  }[];
}

export class SmokeRuntime extends WorkflowRuntime {
  /** Serialize a dispatched run so a fresh controller can adopt it after this
   *  process exits. Opaque blob; callers never read the pane ids inside it. */
  exportRun(runId: string): string {
    const run = this.runRecord(runId);
    const topology: RunTopology = {
      v: 1,
      runId: run.runId,
      workflow: run.config.workflow,
      workspace: run.config.workspace,
      cwd: run.config.cwd,
      splitDirection: run.config.splitDirection ?? "down",
      tabId: run.tab.id,
      controllerPaneId: run.controllerPane.id,
      startedAt: run.startedAt,
      dispatchedAt: run.dispatchedAt,
      lanes: run.laneOrder.map((laneId) => {
        const lane = run.lanes.get(laneId)!;
        return {
          laneId: lane.laneId,
          paneId: lane.pane.id,
          logFile: lane.logFile,
          steps: lane.steps,
          stepDelaySeconds: lane.stepDelaySeconds,
          dispatchedAt: lane.dispatchedAt,
          liveAt: lane.liveAt,
        };
      }),
    };
    return JSON.stringify(topology);
  }

  /** Attach to a run dispatched by another (now-exited) controller. The lanes
   *  keep running because they are children of the Herdr server, not of the
   *  controller that dispatched them. */
  attachRun(serialized: string): RunHandle {
    const topology = JSON.parse(serialized) as RunTopology;
    if (topology.v !== 1) {
      throw new Error(`unsupported run topology version ${topology.v}`);
    }
    const lanes = new Map<string, LaneRecord>();
    const laneOrder: string[] = [];
    for (const lane of topology.lanes) {
      lanes.set(lane.laneId, {
        laneId: lane.laneId,
        pane: { id: lane.paneId },
        logFile: lane.logFile,
        sentinelToken: laneSentinelToken(topology.runId, lane.laneId),
        steps: lane.steps,
        stepDelaySeconds: lane.stepDelaySeconds,
        // Attached lanes were already dispatched by the exited controller.
        dispatchAccepted: true,
        dispatchedAt: lane.dispatchedAt,
        liveAt: lane.liveAt,
        completedAt: null,
        state: "running",
        exitCode: null,
        waitMatched: false,
        humanCoordinationMs: null,
      });
      laneOrder.push(lane.laneId);
    }
    const run: RunRecord = {
      runId: topology.runId,
      config: {
        workflow: topology.workflow,
        workspace: topology.workspace,
        cwd: topology.cwd,
        splitDirection: topology.splitDirection,
        lanes: topology.lanes.map((l) => ({
          laneId: l.laneId,
          steps: l.steps,
          stepDelaySeconds: l.stepDelaySeconds,
        })),
      },
      tab: { id: topology.tabId },
      controllerPane: { id: topology.controllerPaneId },
      startedAt: topology.startedAt,
      dispatchedAt: topology.dispatchedAt,
      checkpointAnnouncedAt: null,
      lanes,
      laneOrder,
    };
    this.registerRun(run);
    return { runId: run.runId, laneIds: [...laneOrder] };
  }
}
