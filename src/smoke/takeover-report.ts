import type {
  ContractState,
  ControlMode,
  RunnerEvidence,
  RuntimeState,
  VerificationState,
} from "../runtime/events.ts";

interface InspectCollectionInput {
  readonly exitCode: number;
  readonly runId: string;
  readonly laneId: string;
  readonly runtimeState: RuntimeState;
  readonly controlMode: ControlMode;
  readonly contractState: ContractState;
  readonly verificationState: VerificationState;
  readonly evidenceFile: string | null;
  readonly evidence: RunnerEvidence | null;
}

export interface InspectCollectionSummary {
  readonly exitCode: number;
  readonly runtimeState: RuntimeState;
  readonly controlMode: ControlMode;
  readonly contractState: ContractState;
  readonly verificationState: VerificationState;
  readonly evidenceFile: string;
  readonly evidence: {
    readonly runId: string;
    readonly laneId: string;
    readonly exitCode: number | null;
    readonly completedAt: number | null;
    readonly termination: RunnerEvidence["termination"];
  };
}

export function summarizeInspectCollection(
  input: InspectCollectionInput,
): InspectCollectionSummary {
  if (
    input.exitCode !== 0 ||
    input.controlMode !== "human_owned" ||
    input.runtimeState !== "exited" ||
    input.contractState !== "satisfied" ||
    input.verificationState !== "verified" ||
    input.evidenceFile === null ||
    input.evidence === null ||
    input.evidence.runId !== input.runId ||
    input.evidence.laneId !== input.laneId ||
    input.evidence.exitCode !== 0 ||
    input.evidence.termination !== "sentinel-exit"
  ) {
    throw new Error(
      "inspect did not collect terminal facts for human-owned lane",
    );
  }
  return {
    exitCode: input.exitCode,
    runtimeState: input.runtimeState,
    controlMode: input.controlMode,
    contractState: input.contractState,
    verificationState: input.verificationState,
    evidenceFile: input.evidenceFile,
    evidence: {
      runId: input.evidence.runId,
      laneId: input.evidence.laneId,
      exitCode: input.evidence.exitCode,
      completedAt: input.evidence.completedAt,
      termination: input.evidence.termination,
    },
  };
}

interface InSliceAbortInput {
  readonly waitStarted: boolean;
  readonly targetWaitCount: number;
  readonly controllerThrew: boolean;
  readonly ownedRuntimeState: RuntimeState;
  readonly ownedControlMode: ControlMode;
  readonly siblingComplete: boolean;
}

export interface InSliceAbortSummary extends InSliceAbortInput {
  readonly noFurtherWait: true;
}

export function summarizeInSliceAbort(
  input: InSliceAbortInput,
): InSliceAbortSummary {
  if (
    !input.waitStarted ||
    input.targetWaitCount !== 1 ||
    input.controllerThrew ||
    input.ownedRuntimeState !== "running" ||
    input.ownedControlMode !== "human_owned" ||
    !input.siblingComplete
  ) {
    throw new Error("smoke did not prove an in-slice ownership abort");
  }
  return {
    ...input,
    noFurtherWait: true,
  };
}

interface PostReleaseDriveInput {
  readonly wasRunningBeforeRelease: boolean;
  readonly waitStarted: boolean;
  readonly targetWaitCount: number;
  readonly controllerThrew: boolean;
  readonly runtimeState: RuntimeState;
  readonly exitCode: number | null;
}

export type PostReleaseDriveSummary = PostReleaseDriveInput;

export function summarizePostReleaseDrive(
  input: PostReleaseDriveInput,
): PostReleaseDriveSummary {
  if (
    !input.wasRunningBeforeRelease ||
    !input.waitStarted ||
    input.targetWaitCount < 1 ||
    input.controllerThrew ||
    input.runtimeState !== "exited" ||
    input.exitCode !== 0
  ) {
    throw new Error("smoke did not prove post-release managed drive");
  }
  return { ...input };
}

export interface OwnedLaneResumeObservation {
  readonly laneId: string;
  readonly waitForOutputCount: number;
  readonly interruptPaneCount: number;
  readonly controlMode: ControlMode;
  readonly runtimeState: RuntimeState;
  readonly processLive: boolean;
}

interface ControllerLossResumeInput {
  readonly controllerThrew: boolean;
  readonly ownedLanes: readonly OwnedLaneResumeObservation[];
}

export interface ControllerLossResumeSummary
  extends ControllerLossResumeInput {
  readonly reconciledWithoutDrive: true;
}

export function summarizeControllerLossResume(
  input: ControllerLossResumeInput,
): ControllerLossResumeSummary {
  const laneIds = new Set(input.ownedLanes.map((lane) => lane.laneId));
  if (
    input.controllerThrew ||
    input.ownedLanes.length !== 2 ||
    laneIds.size !== 2 ||
    input.ownedLanes.some(
      (lane) =>
        lane.waitForOutputCount !== 0 ||
        lane.interruptPaneCount !== 0 ||
        lane.controlMode !== "human_owned" ||
        lane.runtimeState !== "running" ||
        !lane.processLive,
    )
  ) {
    throw new Error(
      "smoke did not prove controller-loss reconcile without drive",
    );
  }
  return {
    ...input,
    reconciledWithoutDrive: true,
  };
}
