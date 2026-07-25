import { describe, expect, test } from "bun:test";
import {
  renderMilestone,
  type DueMilestone,
  type RenderContext,
} from "../src/index.ts";

const start: DueMilestone = {
  kind: "start",
  deliveryId: "run-25:3:start",
  laneId: null,
  payload: {
    hashVersion: 1,
    runId: "run-25",
    workflow: "cross-review",
    lanes: [
      { laneId: "codex", role: "standards" },
      { laneId: "grok", role: null },
    ],
    fixedPoint: {
      baseCommit: "base",
      headCommit: "head",
      diffHash: "diff",
      dirtyStatePolicy: "reject",
    },
  },
};

const blocked: DueMilestone = {
  kind: "blocked",
  deliveryId: "run-25:7:blocked:codex",
  laneId: "codex",
  payload: {
    hashVersion: 1,
    runId: "run-25",
    laneId: "codex",
    role: "standards",
    blockers: ["owner decision required"],
    next: ["record the ruling"],
    gaps: ["verification pending"],
    checkpointPointer: "checkpoints/codex.md",
  },
};

const complete: DueMilestone = {
  kind: "complete",
  deliveryId: "run-25:14:complete",
  laneId: null,
  payload: {
    hashVersion: 1,
    runId: "run-25",
    finishStatus: "degraded",
    breakdown: {
      exitedZero: 0,
      exitedNonZero: 1,
      crashed: 0,
      lost: 0,
      failedToStart: 0,
    },
    lanes: [
      {
        laneId: "codex",
        role: "standards",
        runtimeState: "exited",
        exitCode: 1,
        signal: null,
        semanticState: "partial",
        contractState: "violated",
        contractErrors: ["missing VERDICT"],
        verificationState: "failed",
        gaps: [],
        resultPointer: "results/codex-result.txt",
        evidencePointer: "evidence/codex-evidence.json",
        checkpointPointer: "checkpoints/codex.md",
      },
    ],
  },
};

const decision: DueMilestone = {
  kind: "decision",
  deliveryId: "run-25:18:decision",
  laneId: null,
  payload: {
    hashVersion: 1,
    runId: "run-25",
    decision: "changes-requested",
    note: "Add objective evidence.",
    resultingIssueState: "ready-for-agent",
  },
};

const notApplicable: RenderContext = {
  labelTransition: "not-applicable",
};

describe("renderMilestone", () => {
  test("renders the start milestone exactly", () => {
    expect(renderMilestone(start, notApplicable)).toBe(`<!-- agent-flow:delivery:run-25:3:start -->

## Agent Flow run \`run-25\` started

- **Run:** \`run-25\`
- **Workflow:** cross-review

### Fixed point

- **Base commit:** \`base\`
- **Head commit:** \`head\`
- **Diff hash:** \`diff\`
- **Dirty-state policy:** \`reject\`

### Visible lanes

| Lane | Role |
| --- | --- |
| \`codex\` | standards |
| \`grok\` | — |
`);
  });

  test.each([
    [
      "applied",
      "The triage label was moved to `needs-info`.",
    ],
    [
      "skipped",
      "The triage label was left as a human set it.",
    ],
  ] as const)(
    "renders the blocked milestone exactly when the label transition is %s",
    (labelTransition, labelLine) => {
      expect(renderMilestone(blocked, { labelTransition })).toBe(`<!-- agent-flow:delivery:run-25:7:blocked:codex -->

## Lane \`codex\` is blocked

- **Run:** \`run-25\`
- **Role:** standards

### Blockers

- owner decision required

### Next

- record the ruling

### Gaps

- verification pending

- **Checkpoint:** \`checkpoints/codex.md\`
- **Triage label:** ${labelLine}
`);
    },
  );

  test.each(["failed", "not-applicable"] as const)(
    "does not claim a blocked label outcome when the transition is %s",
    (labelTransition) => {
      expect(renderMilestone(blocked, { labelTransition })).toContain(
        "**Triage label:** The label step did not complete.",
      );
    },
  );

  test("renders completion with runtime, Agent claim, and runner evidence in distinct blocks", () => {
    expect(renderMilestone(complete, notApplicable)).toBe(`<!-- agent-flow:delivery:run-25:14:complete -->

## Agent Flow run \`run-25\` completed

- **Finish status:** \`degraded\`
- **Outcome breakdown:** exitedZero=0, exitedNonZero=1, crashed=0, lost=0, failedToStart=0

### Lane \`codex\` — standards

#### Runtime facts

- **Runtime state:** \`exited\`
- **Exit code:** \`1\`
- **Signal:** none

#### Agent checkpoint claim

- **Semantic state:** \`partial\`
- **Gaps:** none reported
- **Checkpoint:** \`checkpoints/codex.md\`

#### Runner evidence

- **Verification state:** \`failed\`
- **Contract state:** \`violated\`
- **Contract errors:**
  - missing VERDICT
- **Result:** \`results/codex-result.txt\`
- **Evidence:** \`evidence/codex-evidence.json\`
`);
  });

  test("renders the owner decision exactly without implying enactment", () => {
    expect(renderMilestone(decision, notApplicable)).toBe(`<!-- agent-flow:delivery:run-25:18:decision -->

## Owner decision for Agent Flow run \`run-25\`

- **Decision:** \`changes-requested\`
- **Owner note:** Add objective evidence.
- **Resulting issue state stated by the owner:** ready-for-agent

Recorded from the owner through the trusted local CLI. The runtime recorded this decision but did not enact the issue state.
`);
  });

  test.each([start, blocked, complete, decision])(
    "puts the delivery marker first and exactly once",
    (milestone) => {
      const body = renderMilestone(milestone, {
        labelTransition: milestone.kind === "blocked" ? "applied" : "not-applicable",
      });
      expect(body.split("\n", 1)[0]).toBe(
        `<!-- agent-flow:delivery:${milestone.deliveryId} -->`,
      );
      expect(body.match(/<!-- agent-flow:delivery:/g)).toHaveLength(1);
    },
  );

  test("redacts public-surface secrets even when supplied in free text", () => {
    const unsafe: DueMilestone = {
      ...decision,
      payload: {
        ...decision.payload,
        note: [
          "cwd=/Users/owner/private",
          "repoRoot=/private/repository",
          "dispatchedCommand=GH_TOKEN=top-secret",
          "FLOW_run_secret",
          "agent-flow:p9",
          "github_pat_1234567890abcdef",
        ].join(" "),
      },
    };

    const body = renderMilestone(unsafe, notApplicable);
    for (const secret of [
      "/Users/owner/private",
      "/private/repository",
      "GH_TOKEN",
      "top-secret",
      "FLOW_run_secret",
      "agent-flow:p9",
      "github_pat_1234567890abcdef",
      "cwd=",
      "repoRoot=",
      "dispatchedCommand=",
    ]) {
      expect(body).not.toContain(secret);
    }
  });
});
