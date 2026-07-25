import type {
  ContractState,
  ControlMode,
  DeliveryState,
  FixedPoint,
  IssueRef,
  LabelTransition,
  MilestoneKind,
  OwnerDecision,
  RunEvent,
  RunFinishStatus,
  RunOutcomeBreakdown,
  RuntimeState,
  SemanticState,
  VerificationState,
} from "./events.ts";

export interface DeliveryView {
  readonly deliveryId: string;
  readonly kind: MilestoneKind;
  readonly laneId: string | null;
  readonly payloadHash: string;
  readonly state: DeliveryState;
  readonly intents: number;
  readonly intendedAt: number;
  readonly settledAt: number | null;
  readonly commentId: number | null;
  readonly commentUrl: string | null;
  /** "not-applicable" until a confirmation records the label outcome. */
  readonly labelTransition: LabelTransition;
  readonly lastFailure: {
    readonly reason: string;
    readonly retryable: boolean;
  } | null;
}

export interface DecisionView {
  readonly sequence: number;
  readonly at: number;
  readonly decision: OwnerDecision;
  readonly note: string;
  readonly resultingIssueState: string | null;
}

export interface BlockedAnchor {
  readonly sequence: number;
  readonly checkpointFile: string;
  readonly blockers: readonly string[];
  readonly next: readonly string[];
  readonly gaps: readonly string[];
}

export interface LaneView {
  readonly laneId: string;
  readonly paneId: string;
  readonly logFile: string;
  readonly stderrFile: string;
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
  readonly dispatchedCommand: string | null;
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
  readonly blockedAnchor: BlockedAnchor | null;
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
  readonly fixedPoint: FixedPoint | null;
  readonly issue: IssueRef | null;
  readonly issueNodeId: string | null;
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
  readonly deliveries: Readonly<Record<string, DeliveryView>>;
  readonly deliveryOrder: readonly string[];
  readonly decisions: readonly DecisionView[];
  readonly startAnchorSequence: number | null;
  readonly finishedSequence: number | null;
  readonly lastAppliedSequence: number;
}

export type RunState =
  | "dispatched"
  | "running"
  | "incomplete"
  | "complete"
  | "partial";

function assertNever(value: never): never {
  throw new Error(`unhandled run event ${JSON.stringify(value)}`);
}

const TERMINAL_RUNTIME: ReadonlySet<RuntimeState> = new Set([
  "exited",
  "crashed",
  "lost",
  "failed_to_start",
]);

export function projectRunState(run: RunView): RunState {
  if (run.finishStatus !== null) {
    return run.finishStatus === "clean" ? "complete" : "partial";
  }
  const lanes = run.laneOrder.map((laneId) => run.lanes[laneId]!);
  if (
    lanes.length > 0 &&
    lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))
  ) {
    return "incomplete";
  }
  if (
    lanes.some(
      (lane) =>
        lane.runtimeState === "running" ||
        (lane.runtimeState === "pending" && lane.dispatchedAt !== null),
    )
  ) {
    return "running";
  }
  return "dispatched";
}

function assertNonTerminal(lane: LaneView, eventType: RunEvent["type"]): void {
  if (TERMINAL_RUNTIME.has(lane.runtimeState)) {
    throw new Error(
      `${eventType} cannot follow terminal lane state "${lane.runtimeState}"`,
    );
  }
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

function assertIssueBound(state: RunView, eventType: RunEvent["type"]): void {
  if (state.issue === null) {
    throw new Error(`${eventType} cannot apply to an unbound run`);
  }
}

function deliveryFor(state: RunView, deliveryId: string): DeliveryView {
  const delivery = state.deliveries[deliveryId];
  if (!delivery) {
    throw new Error(`unknown deliveryId "${deliveryId}"`);
  }
  return delivery;
}

export function projectRunOutcomeBreakdown(
  state: RunView,
): RunOutcomeBreakdown {
  const lanes = state.laneOrder.map((laneId) => state.lanes[laneId]!);
  return {
    exitedZero: lanes.filter(
      (lane) => lane.runtimeState === "exited" && lane.exitCode === 0,
    ).length,
    exitedNonZero: lanes.filter(
      (lane) => lane.runtimeState === "exited" && lane.exitCode !== 0,
    ).length,
    crashed: lanes.filter((lane) => lane.runtimeState === "crashed").length,
    lost: lanes.filter((lane) => lane.runtimeState === "lost").length,
    failedToStart: lanes.filter(
      (lane) => lane.runtimeState === "failed_to_start",
    ).length,
  };
}

function sameBreakdown(
  left: RunOutcomeBreakdown,
  right: RunOutcomeBreakdown,
): boolean {
  const keys = [
    "exitedZero",
    "exitedNonZero",
    "crashed",
    "lost",
    "failedToStart",
  ] as const;
  const actualKeys = Object.keys(left);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => actualKeys.includes(key)) &&
    left.exitedZero === right.exitedZero &&
    left.exitedNonZero === right.exitedNonZero &&
    left.crashed === right.crashed &&
    left.lost === right.lost &&
    left.failedToStart === right.failedToStart
  );
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
    if (!("issue" in event.data)) {
      throw new Error('run_started event is missing required "issue" field');
    }
    const issue = event.data.issue;
    return {
      schemaVersion: 1,
      runId: event.runId,
      workflow: event.data.workflow,
      workspace: event.data.workspace,
      cwd: event.data.cwd,
      splitDirection: event.data.splitDirection,
      tabId: event.data.tabId,
      controllerPaneId: event.data.controllerPaneId,
      fixedPoint: event.data.fixedPoint,
      issue: issue === null ? null : { ...issue },
      issueNodeId: null,
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
      deliveries: {},
      deliveryOrder: [],
      decisions: [],
      startAnchorSequence: null,
      finishedSequence: null,
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
        dispatchedCommand: null,
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
        blockedAnchor: null,
      };
      return withRun(state, event, {
        lanes: { ...state.lanes, [event.laneId]: lane },
        laneOrder: [...state.laneOrder, event.laneId],
      });
    }
    case "lane_dispatch_intent": {
      const next = withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        if (lane.dispatchIntentAt !== null) {
          throw new Error("duplicate lane_dispatch_intent");
        }
        return {
          ...lane,
          runtimeState: "pending",
          dispatchIntentAt: event.at,
        };
      });
      return {
        ...next,
        startAnchorSequence: state.startAnchorSequence ?? event.sequence,
      };
    }
    case "lane_dispatched":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        if (lane.dispatchedAt !== null) {
          throw new Error("duplicate lane_dispatched");
        }
        return {
          ...lane,
          runtimeState: "pending",
          dispatchedAt: event.at,
          dispatchedCommand: event.data.command,
        };
      });
    case "lane_live":
      return withLane(state, event, (lane) => {
        if (lane.runtimeState !== "pending") {
          throw new Error(
            `lane_live requires pending lane state, received "${lane.runtimeState}"`,
          );
        }
        return {
          ...lane,
          runtimeState: "running",
          liveAt: event.at,
        };
      });
    case "lane_checkpoint":
      return withLane(state, event, (lane) => {
        const blockedAnchor =
          lane.blockedAnchor === null && event.data.semanticState === "blocked"
            ? {
                sequence: event.sequence,
                checkpointFile: event.data.checkpointFile,
                blockers: [...(event.data.blockers ?? [])],
                next: [...(event.data.next ?? [])],
                gaps: [...(event.data.gaps ?? [])],
              }
            : lane.blockedAnchor;
        return {
          ...lane,
          semanticState: event.data.semanticState,
          checkpointFile: event.data.checkpointFile,
          checkpointAt: event.at,
          blockedAnchor,
        };
      });
    case "lane_exited":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "exited",
          completedAt: event.at,
          exitCode: event.data.exitCode,
          signal: event.data.signal ?? null,
          waitMatched: event.data.waitMatched ?? lane.waitMatched,
        };
      });
    case "lane_crashed":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "crashed",
          completedAt: event.at,
          exitCode: null,
        };
      });
    case "lane_lost":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "lost",
          completedAt: event.at,
          lostCause: event.data.cause,
        };
      });
    case "lane_failed_to_start":
      return withLane(state, event, (lane) => {
        assertNonTerminal(lane, event.type);
        return {
          ...lane,
          runtimeState: "failed_to_start",
          completedAt: event.at,
          startRejection: event.data.rejection,
          dispatchedCommand: event.data.command,
        };
      });
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
    case "human_interrupt": {
      if (event.data.laneId !== event.laneId) {
        throw new Error("human_interrupt laneId does not match its envelope");
      }
      const firstCoordination =
        state.checkpointAnnouncedAt === null
          ? null
          : event.at - state.checkpointAnnouncedAt;
      return withLane(state, event, (lane) => ({
        ...lane,
        humanInterruptAt: lane.humanInterruptAt ?? event.at,
        humanCoordinationMs:
          lane.humanInterruptAt !== null
            ? lane.humanCoordinationMs
            : firstCoordination,
      }));
    }
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
    case "issue_binding_resolved":
      assertIssueBound(state, event.type);
      if (
        state.issueNodeId !== null &&
        state.issueNodeId !== event.data.issueNodeId
      ) {
        throw new Error(
          "issue_binding_resolved cannot replace a different issue node id",
        );
      }
      return withRun(state, event, { issueNodeId: event.data.issueNodeId });
    case "issue_delivery_intended": {
      assertIssueBound(state, event.type);
      const delivery = state.deliveries[event.data.deliveryId];
      if (!delivery) {
        const intended: DeliveryView = {
          ...event.data,
          state: "pending",
          intents: 1,
          intendedAt: event.at,
          settledAt: null,
          commentId: null,
          commentUrl: null,
          labelTransition: "not-applicable",
          lastFailure: null,
        };
        return withRun(state, event, {
          deliveries: {
            ...state.deliveries,
            [event.data.deliveryId]: intended,
          },
          deliveryOrder: [...state.deliveryOrder, event.data.deliveryId],
        });
      }
      if (delivery.payloadHash !== event.data.payloadHash) {
        throw new Error(
          `issue_delivery_intended payloadHash differs for delivery "${delivery.deliveryId}"`,
        );
      }
      if (delivery.kind !== event.data.kind) {
        throw new Error(
          `issue_delivery_intended kind differs for delivery "${delivery.deliveryId}"`,
        );
      }
      if (delivery.laneId !== event.data.laneId) {
        throw new Error(
          `issue_delivery_intended laneId differs for delivery "${delivery.deliveryId}"`,
        );
      }
      if (delivery.state !== "failed") {
        throw new Error(
          `issue_delivery_intended requires absent or failed delivery, received "${delivery.state}"`,
        );
      }
      return withRun(state, event, {
        deliveries: {
          ...state.deliveries,
          [delivery.deliveryId]: {
            ...delivery,
            state: "pending",
            intents: delivery.intents + 1,
            intendedAt: event.at,
            settledAt: null,
            labelTransition: "not-applicable",
          },
        },
      });
    }
    case "issue_delivery_confirmed": {
      assertIssueBound(state, event.type);
      const delivery = deliveryFor(state, event.data.deliveryId);
      if (delivery.state !== "pending") {
        throw new Error(
          `issue_delivery_confirmed requires pending delivery, received "${delivery.state}"`,
        );
      }
      return withRun(state, event, {
        deliveries: {
          ...state.deliveries,
          [delivery.deliveryId]: {
            ...delivery,
            state: "delivered",
            settledAt: event.at,
            commentId: event.data.commentId,
            commentUrl: event.data.commentUrl,
            labelTransition: event.data.labelTransition,
          },
        },
      });
    }
    case "issue_delivery_failed": {
      assertIssueBound(state, event.type);
      const delivery = deliveryFor(state, event.data.deliveryId);
      if (delivery.state !== "pending") {
        throw new Error(
          `issue_delivery_failed requires pending delivery, received "${delivery.state}"`,
        );
      }
      return withRun(state, event, {
        deliveries: {
          ...state.deliveries,
          [delivery.deliveryId]: {
            ...delivery,
            state: "failed",
            settledAt: event.at,
            labelTransition: "not-applicable",
            lastFailure: {
              reason: event.data.reason,
              retryable: event.data.retryable,
            },
          },
        },
      });
    }
    case "owner_decision_recorded":
      return withRun(state, event, {
        decisions: [
          ...state.decisions,
          {
            sequence: event.sequence,
            at: event.at,
            ...event.data,
          },
        ],
      });
    case "run_finished": {
      if (state.finishStatus !== null) {
        throw new Error("duplicate run_finished");
      }
      if (state.laneOrder.length === 0) {
        throw new Error("run_finished requires at least one lane");
      }
      const lanes = state.laneOrder.map((laneId) => state.lanes[laneId]!);
      if (!lanes.every((lane) => TERMINAL_RUNTIME.has(lane.runtimeState))) {
        throw new Error("run_finished requires every lane to be runtime-terminal");
      }
      const breakdown = projectRunOutcomeBreakdown(state);
      if (!sameBreakdown(event.data.breakdown, breakdown)) {
        throw new Error("run_finished breakdown does not match current lane states");
      }
      const expectedStatus =
        breakdown.exitedZero === lanes.length ? "clean" : "degraded";
      if (event.data.status !== expectedStatus) {
        throw new Error(
          `run_finished status must be "${expectedStatus}" for current lane states`,
        );
      }
      return withRun(state, event, {
        finishedAt: event.at,
        finishStatus: event.data.status,
        breakdown: { ...event.data.breakdown },
        finishedSequence: event.sequence,
      });
    }
    default:
      return assertNever(event);
  }
}
