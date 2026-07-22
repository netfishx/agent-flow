import type {
  ContractState,
  ControlMode,
  RunEvent,
  RunFinishStatus,
  RunOutcomeBreakdown,
  RuntimeState,
  SemanticState,
  VerificationState,
} from "./events.ts";

export interface LaneView {
  readonly laneId: string;
  readonly paneId: string;
  readonly logFile: string;
  readonly sentinelToken: string;
  readonly steps: number;
  readonly stepDelaySeconds: number;
  readonly role?: string;
  readonly runtimeState: RuntimeState;
  readonly semanticState: SemanticState;
  readonly contractState: ContractState;
  readonly verificationState: VerificationState;
  readonly controlMode: ControlMode;
  readonly registeredAt: number;
  readonly dispatchIntentAt: number | null;
  readonly dispatchedAt: number | null;
  readonly liveAt: number | null;
  readonly completedAt: number | null;
  readonly checkpointAt: number | null;
  readonly contractEvaluatedAt: number | null;
  readonly verificationRecordedAt: number | null;
  readonly humanInterruptAt: number | null;
  readonly humanCoordinationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly waitMatched: boolean;
  readonly checkpointFile: string | null;
  readonly resultFile: string | null;
  readonly contractErrors: readonly string[];
  readonly evidenceFile: string | null;
  readonly lostCause: string | null;
  readonly startRejection: string | null;
}

export interface RunView {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly splitDirection: "right" | "down";
  readonly tabId: string;
  readonly controllerPaneId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly checkpointAnnouncedAt: number | null;
  readonly finishedAt: number | null;
  readonly finishStatus: RunFinishStatus | null;
  readonly breakdown: RunOutcomeBreakdown | null;
  readonly controllerEpoch: number;
  readonly controller: {
    readonly controllerId: string;
    readonly pid: number;
  } | null;
  readonly lanes: Readonly<Record<string, LaneView>>;
  readonly laneOrder: readonly string[];
  readonly lastAppliedSequence: number;
}

function assertNever(value: never): never {
  throw new Error(`unhandled run event ${JSON.stringify(value)}`);
}

function laneFor(state: RunView, event: RunEvent): LaneView {
  if (event.laneId === undefined) {
    throw new Error(`event "${event.type}" requires laneId`);
  }
  const lane = state.lanes[event.laneId];
  if (!lane) {
    throw new Error(`unknown laneId "${event.laneId}" in run "${state.runId}"`);
  }
  return lane;
}

function withLane(
  state: RunView,
  event: RunEvent,
  update: (lane: LaneView) => LaneView,
): RunView {
  const lane = laneFor(state, event);
  return {
    ...state,
    updatedAt: event.at,
    lastAppliedSequence: event.sequence,
    lanes: { ...state.lanes, [lane.laneId]: update(lane) },
  };
}

function withRun(state: RunView, event: RunEvent, patch: Partial<RunView>): RunView {
  return {
    ...state,
    ...patch,
    updatedAt: event.at,
    lastAppliedSequence: event.sequence,
  };
}

export function reduce(state: RunView | undefined, event: RunEvent): RunView {
  const expectedSequence = (state?.lastAppliedSequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(
      `run "${event.runId}" sequence ${event.sequence} does not follow ${expectedSequence - 1}`,
    );
  }
  if (event.eventId !== `${event.runId}#${event.sequence}`) {
    throw new Error(`invalid eventId "${event.eventId}" for run sequence`);
  }
  if (state && event.runId !== state.runId) {
    throw new Error(`event runId "${event.runId}" does not match "${state.runId}"`);
  }

  if (event.type === "run_started") {
    if (state) throw new Error(`run "${event.runId}" is already started`);
    return {
      schemaVersion: 1,
      runId: event.runId,
      workflow: event.data.workflow,
      workspace: event.data.workspace,
      cwd: event.data.cwd,
      splitDirection: event.data.splitDirection,
      tabId: event.data.tabId,
      controllerPaneId: event.data.controllerPaneId,
      startedAt: event.at,
      updatedAt: event.at,
      checkpointAnnouncedAt: null,
      finishedAt: null,
      finishStatus: null,
      breakdown: null,
      controllerEpoch: event.controllerEpoch,
      controller: null,
      lanes: {},
      laneOrder: [],
      lastAppliedSequence: event.sequence,
    };
  }

  if (!state) {
    throw new Error(`first event for run "${event.runId}" must be run_started`);
  }

  switch (event.type) {
    case "lane_registered": {
      if (event.data.laneId !== event.laneId) {
        throw new Error("lane_registered laneId does not match its envelope");
      }
      if (state.lanes[event.laneId]) {
        throw new Error(`lane "${event.laneId}" is already registered`);
      }
      const lane: LaneView = {
        ...event.data,
        runtimeState: "pending",
        semanticState: "unknown",
        contractState: "unknown",
        verificationState: "unverified",
        controlMode: "managed",
        registeredAt: event.at,
        dispatchIntentAt: null,
        dispatchedAt: null,
        liveAt: null,
        completedAt: null,
        checkpointAt: null,
        contractEvaluatedAt: null,
        verificationRecordedAt: null,
        humanInterruptAt: null,
        humanCoordinationMs: null,
        exitCode: null,
        signal: null,
        waitMatched: false,
        checkpointFile: null,
        resultFile: null,
        contractErrors: [],
        evidenceFile: null,
        lostCause: null,
        startRejection: null,
      };
      return withRun(state, event, {
        lanes: { ...state.lanes, [event.laneId]: lane },
        laneOrder: [...state.laneOrder, event.laneId],
      });
    }
    case "lane_dispatch_intent":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "pending",
        dispatchIntentAt: event.at,
      }));
    case "lane_dispatched":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "pending",
        dispatchedAt: event.at,
      }));
    case "lane_live":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "running",
        liveAt: lane.liveAt ?? event.at,
      }));
    case "lane_checkpoint":
      return withLane(state, event, (lane) => ({
        ...lane,
        semanticState: event.data.semanticState,
        checkpointFile: event.data.checkpointFile,
        checkpointAt: event.at,
      }));
    case "lane_exited":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "exited",
        completedAt: event.at,
        exitCode: event.data.exitCode,
        signal: event.data.signal ?? null,
        waitMatched: event.data.waitMatched ?? lane.waitMatched,
      }));
    case "lane_crashed":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "crashed",
        completedAt: event.at,
        exitCode: null,
      }));
    case "lane_lost":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "lost",
        completedAt: event.at,
        lostCause: event.data.cause,
      }));
    case "lane_failed_to_start":
      return withLane(state, event, (lane) => ({
        ...lane,
        runtimeState: "failed_to_start",
        completedAt: event.at,
        startRejection: event.data.rejection,
      }));
    case "lane_contract_evaluated":
      return withLane(state, event, (lane) => ({
        ...lane,
        contractState: event.data.contractState,
        resultFile: event.data.resultFile,
        contractErrors: [...event.data.errors],
        contractEvaluatedAt: event.at,
      }));
    case "lane_verification_recorded":
      return withLane(state, event, (lane) => ({
        ...lane,
        verificationState: event.data.verificationState,
        evidenceFile: event.data.evidenceFile,
        verificationRecordedAt: event.at,
      }));
    case "checkpoint_announced":
      return withRun(state, event, { checkpointAnnouncedAt: event.at });
    case "human_interrupt":
      if (event.data.laneId !== event.laneId) {
        throw new Error("human_interrupt laneId does not match its envelope");
      }
      return withLane(state, event, (lane) => ({
        ...lane,
        humanInterruptAt: event.at,
        humanCoordinationMs:
          state.checkpointAnnouncedAt === null
            ? null
            : event.at - state.checkpointAnnouncedAt,
      }));
    case "lane_takeover":
      return withLane(state, event, (lane) => ({
        ...lane,
        controlMode: "human_owned",
      }));
    case "lane_release":
      return withLane(state, event, (lane) => ({
        ...lane,
        controlMode: "managed",
      }));
    case "controller_attached":
      return withRun(state, event, {
        controllerEpoch: event.data.epoch,
        controller: {
          controllerId: event.data.controllerId,
          pid: event.data.pid,
        },
      });
    case "run_finished":
      return withRun(state, event, {
        finishedAt: event.at,
        finishStatus: event.data.status,
        breakdown: { ...event.data.breakdown },
      });
    default:
      return assertNever(event);
  }
}
