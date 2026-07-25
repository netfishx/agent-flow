import type { LabelTransition } from "../runtime/events.ts";
import { marker, type DueMilestone } from "./milestones.ts";

export interface RenderContext {
  readonly labelTransition: LabelTransition;
}

// This is a public-surface guard: over-redaction is safer than leaking a local
// path, credential, sentinel, marker, or real Herdr pane identifier.
const PUBLIC_SURFACE_PATTERNS: readonly RegExp[] = [
  /\b(?:cwd|repoRoot|dispatchedCommand)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
  /\b(?:GH_TOKEN|GITHUB_TOKEN)\s*=\s*[^\s]+/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bFLOW_[A-Za-z0-9_-]+\b/g,
  /\b[A-Za-z0-9_-]+:p[A-Za-z0-9]+\b/g,
  /\bfile:\/\/\/[^\s"'`)<>\]]+/gi,
  /<!--\s*agent-flow:delivery:[^>]*-->/gi,
];
const POSIX_ABSOLUTE_PATH =
  /(^|[^A-Za-z0-9_/])\/(?!\/)[^\s"'`)<>\]]+/g;
const WINDOWS_ABSOLUTE_PATH =
  /(^|[^A-Za-z0-9_])[A-Za-z]:\\[^\s"'`)<>\]]+/g;

function redactForPublicSurface(value: string): string {
  const pathsRedacted = value
    .replace(POSIX_ABSOLUTE_PATH, "$1[redacted]")
    .replace(WINDOWS_ABSOLUTE_PATH, "$1[redacted]");
  return PUBLIC_SURFACE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[redacted]"),
    pathsRedacted,
  );
}

function text(value: string): string {
  return redactForPublicSurface(value).replace(/\r?\n/g, " ");
}

function code(value: string): string {
  return `\`${text(value).replace(/`/g, "\\`")}\``;
}

function list(items: readonly string[]): string[] {
  return items.length === 0
    ? ["- none reported"]
    : items.map((item) => `- ${text(item)}`);
}

function markerAnd(deliveryId: string, lines: readonly string[]): string {
  return `${[marker(deliveryId), "", ...lines].join("\n")}\n`;
}

function renderStart(
  milestone: Extract<DueMilestone, { readonly kind: "start" }>,
): string {
  const { payload } = milestone;
  const lines = [
    `## Agent Flow run ${code(payload.runId)} started`,
    "",
    `- **Run:** ${code(payload.runId)}`,
    `- **Workflow:** ${text(payload.workflow)}`,
  ];
  if (payload.fixedPoint !== null) {
    lines.push(
      "",
      "### Fixed point",
      "",
      `- **Base commit:** ${code(payload.fixedPoint.baseCommit)}`,
      `- **Head commit:** ${code(payload.fixedPoint.headCommit)}`,
      `- **Diff hash:** ${code(payload.fixedPoint.diffHash)}`,
      `- **Dirty-state policy:** ${code(payload.fixedPoint.dirtyStatePolicy)}`,
    );
  }
  lines.push(
    "",
    "### Visible lanes",
    "",
    "| Lane | Role |",
    "| --- | --- |",
    ...payload.lanes.map(
      (lane) =>
        `| ${code(lane.laneId)} | ${
          lane.role === null ? "—" : text(lane.role).replace(/\|/g, "\\|")
        } |`,
    ),
  );
  return markerAnd(milestone.deliveryId, lines);
}

function labelOutcome(labelTransition: LabelTransition): string {
  switch (labelTransition) {
    case "applied":
      return "The triage label was moved to `needs-info`.";
    case "skipped":
      return "The triage label was left as a human set it.";
    case "failed":
      return "The label step was attempted but did not succeed.";
    case "not-applicable":
      return "No label step was called for this milestone.";
  }
}

function renderBlocked(
  milestone: Extract<DueMilestone, { readonly kind: "blocked" }>,
  context: RenderContext,
): string {
  const { payload } = milestone;
  const lines = [
    `## Lane ${code(payload.laneId)} is blocked`,
    "",
    `- **Run:** ${code(payload.runId)}`,
    `- **Role:** ${payload.role === null ? "—" : text(payload.role)}`,
    "",
    "### Blockers",
    "",
    ...list(payload.blockers),
  ];
  if (payload.next.length > 0) {
    lines.push("", "### Next", "", ...list(payload.next));
  }
  if (payload.gaps.length > 0) {
    lines.push("", "### Gaps", "", ...list(payload.gaps));
  }
  lines.push(
    "",
    `- **Checkpoint:** ${code(payload.checkpointPointer)}`,
    `- **Triage label:** ${labelOutcome(context.labelTransition)}`,
  );
  return markerAnd(milestone.deliveryId, lines);
}

function renderComplete(
  milestone: Extract<DueMilestone, { readonly kind: "complete" }>,
): string {
  const { payload } = milestone;
  const lines = [
    `## Agent Flow run ${code(payload.runId)} completed`,
    "",
    `- **Finish status:** ${code(payload.finishStatus)}`,
    `- **Outcome breakdown:** exitedZero=${payload.breakdown.exitedZero}, exitedNonZero=${payload.breakdown.exitedNonZero}, crashed=${payload.breakdown.crashed}, lost=${payload.breakdown.lost}, failedToStart=${payload.breakdown.failedToStart}`,
  ];
  for (const lane of payload.lanes) {
    lines.push(
      "",
      `### Lane ${code(lane.laneId)} — ${
        lane.role === null ? "—" : text(lane.role)
      }`,
      "",
      "#### Runtime facts",
      "",
      `- **Runtime state:** ${code(lane.runtimeState)}`,
      `- **Exit code:** ${
        lane.exitCode === null ? "none" : code(String(lane.exitCode))
      }`,
      `- **Signal:** ${lane.signal === null ? "none" : code(lane.signal)}`,
      "",
      "#### Agent checkpoint claim",
      "",
      `- **Semantic state:** ${code(lane.semanticState)}`,
      ...(lane.gaps.length === 0
        ? ["- **Gaps:** not collected in this run"]
        : ["- **Gaps:**", ...lane.gaps.map((gap) => `  - ${text(gap)}`)]),
      `- **Checkpoint:** ${
        lane.checkpointPointer === null
          ? "none"
          : code(lane.checkpointPointer)
      }`,
      "",
      "#### Runner evidence",
      "",
      `- **Verification state:** ${code(lane.verificationState)}`,
      `- **Contract state:** ${code(lane.contractState)}`,
      ...(lane.contractErrors.length === 0
        ? ["- **Contract errors:** none"]
        : [
            "- **Contract errors:**",
            ...lane.contractErrors.map((error) => `  - ${text(error)}`),
          ]),
      `- **Result:** ${code(lane.resultPointer)}`,
      `- **Evidence:** ${code(lane.evidencePointer)}`,
    );
  }
  return markerAnd(milestone.deliveryId, lines);
}

function renderDecision(
  milestone: Extract<DueMilestone, { readonly kind: "decision" }>,
): string {
  const { payload } = milestone;
  return markerAnd(milestone.deliveryId, [
    `## Owner decision for Agent Flow run ${code(payload.runId)}`,
    "",
    `- **Decision:** ${code(payload.decision)}`,
    `- **Owner note:** ${text(payload.note)}`,
    `- **Resulting issue state stated by the owner:** ${
      payload.resultingIssueState === null
        ? "not stated"
        : text(payload.resultingIssueState)
    }`,
    "",
    "Recorded from the owner through the trusted local CLI. The runtime recorded this decision but did not enact the issue state.",
  ]);
}

export function renderMilestone(
  milestone: DueMilestone,
  context: RenderContext,
): string {
  switch (milestone.kind) {
    case "start":
      return renderStart(milestone);
    case "blocked":
      return renderBlocked(milestone, context);
    case "complete":
      return renderComplete(milestone);
    case "decision":
      return renderDecision(milestone);
  }
}
