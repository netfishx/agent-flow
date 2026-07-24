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
