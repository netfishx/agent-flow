export type RunEventType =
  | "run_started"
  | "lane_registered"
  | "lane_dispatch_intent"
  | "lane_dispatched"
  | "lane_live"
  | "lane_checkpoint"
  | "lane_exited"
  | "lane_crashed"
  | "lane_lost"
  | "lane_failed_to_start"
  | "lane_contract_evaluated"
  | "lane_verification_recorded"
  | "checkpoint_announced"
  | "human_interrupt"
  | "lane_takeover"
  | "lane_release"
  | "controller_attached"
  | "run_finished";

export type RunEventActor =
  | "runtime"
  | "agent"
  | "validator"
  | "runner"
  | "human";

export type RuntimeState =
  | "pending"
  | "running"
  | "exited"
  | "crashed"
  | "lost"
  | "failed_to_start";

export type SemanticState =
  | "unknown"
  | "working"
  | "complete"
  | "partial"
  | "blocked";

export type ContractState = "unknown" | "satisfied" | "violated";
export type VerificationState = "unverified" | "verified" | "failed";
export type ControlMode = "managed" | "human_owned";
export type RunFinishStatus = "clean" | "degraded";

export interface FixedPoint {
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly diffHash: string;
  readonly dirtyStatePolicy: "reject" | "record-hash";
  readonly capturedAt: number;
}

export interface RunnerEvidence {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly laneId: string;
  readonly command: string | null;
  /** Durable stdout/stderr artifact; the lane tees all process output here. */
  readonly logFile: string;
  readonly dispatchedAt: number | null;
  readonly liveAt: number | null;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly failure: string | null;
  readonly environmentFailure: string | null;
  readonly termination:
    | "sentinel-exit"
    | "crashed"
    | "lost"
    | "failed_to_start"
    | "timeout";
}

export type EmptyEventData = Readonly<Record<string, never>>;

export interface RunStartedData {
  readonly workflow: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly splitDirection: "right" | "down";
  readonly tabId: string;
  readonly controllerPaneId: string;
  readonly fixedPoint: FixedPoint | null;
}

export interface LaneRegisteredData {
  readonly laneId: string;
  readonly paneId: string;
  readonly logFile: string;
  readonly sentinelToken: string;
  readonly steps: number;
  readonly stepDelaySeconds: number;
  readonly role?: string;
}

export interface LaneDispatchedData {
  readonly command: string;
}

export interface LaneCheckpointData {
  readonly semanticState: SemanticState;
  readonly checkpointFile: string;
}

export interface LaneExitedData {
  readonly exitCode: number;
  readonly signal?: string;
  readonly waitMatched?: boolean;
}

export interface LaneLostData {
  readonly cause: string;
}

export interface LaneFailedToStartData {
  readonly rejection: string;
  readonly command: string | null;
}

export interface LaneContractEvaluatedData {
  readonly contractState: ContractState;
  readonly resultFile: string;
  readonly errors: readonly string[];
}

export interface LaneVerificationRecordedData {
  readonly verificationState: VerificationState;
  readonly evidenceFile: string;
}

export interface HumanInterruptData {
  readonly laneId: string;
}

export interface ControllerAttachedData {
  readonly controllerId: string;
  readonly epoch: number;
  readonly pid: number;
}

export interface RunOutcomeBreakdown {
  readonly exitedZero: number;
  readonly exitedNonZero: number;
  readonly crashed: number;
  readonly lost: number;
  readonly failedToStart: number;
}

export interface RunFinishedData {
  readonly status: RunFinishStatus;
  readonly breakdown: RunOutcomeBreakdown;
}

export interface RunEventDataByType {
  readonly run_started: RunStartedData;
  readonly lane_registered: LaneRegisteredData;
  readonly lane_dispatch_intent: EmptyEventData;
  readonly lane_dispatched: LaneDispatchedData;
  readonly lane_live: EmptyEventData;
  readonly lane_checkpoint: LaneCheckpointData;
  readonly lane_exited: LaneExitedData;
  readonly lane_crashed: EmptyEventData;
  readonly lane_lost: LaneLostData;
  readonly lane_failed_to_start: LaneFailedToStartData;
  readonly lane_contract_evaluated: LaneContractEvaluatedData;
  readonly lane_verification_recorded: LaneVerificationRecordedData;
  readonly checkpoint_announced: EmptyEventData;
  readonly human_interrupt: HumanInterruptData;
  readonly lane_takeover: EmptyEventData;
  readonly lane_release: EmptyEventData;
  readonly controller_attached: ControllerAttachedData;
  readonly run_finished: RunFinishedData;
}

export interface RunEventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  readonly laneId?: string;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly at: number;
  readonly actor: RunEventActor;
  readonly controllerEpoch: number;
  readonly data: RunEventDataByType[RunEventType];
}

type EventFor<
  T extends RunEventType,
  A extends RunEventActor,
  Lane extends string | undefined = undefined,
> = Omit<RunEventEnvelope, "type" | "actor" | "laneId" | "data"> & {
  readonly type: T;
  readonly actor: A;
  readonly data: RunEventDataByType[T];
} & (Lane extends string ? { readonly laneId: string } : { readonly laneId?: never });

export type RunEvent =
  | EventFor<"run_started", "runtime">
  | EventFor<"lane_registered", "runtime", string>
  | EventFor<"lane_dispatch_intent", "runtime", string>
  | EventFor<"lane_dispatched", "runtime", string>
  | EventFor<"lane_live", "runtime", string>
  | EventFor<"lane_checkpoint", "agent", string>
  | EventFor<"lane_exited", "runtime", string>
  | EventFor<"lane_crashed", "runtime", string>
  | EventFor<"lane_lost", "runtime", string>
  | EventFor<"lane_failed_to_start", "runtime", string>
  | EventFor<"lane_contract_evaluated", "validator", string>
  | EventFor<"lane_verification_recorded", "runner", string>
  | EventFor<"checkpoint_announced", "runtime">
  | EventFor<"human_interrupt", "human", string>
  | EventFor<"lane_takeover", "human", string>
  | EventFor<"lane_release", "human", string>
  | EventFor<"controller_attached", "runtime">
  | EventFor<"run_finished", "runtime">;

export type NewRunEvent = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<
        E,
        | "schemaVersion"
        | "eventId"
        | "runId"
        | "sequence"
        | "at"
        | "controllerEpoch"
      >
    : never
  : never;
