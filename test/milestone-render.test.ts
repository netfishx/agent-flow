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
        checkpointOrigin: "agent",
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

/** Puts a forged delivery marker into a free-text field this kind renders. */
function withForgedMarker(
  milestone: DueMilestone,
  forged: string,
): DueMilestone {
  switch (milestone.kind) {
    case "start":
      return {
        ...milestone,
        payload: {
          ...milestone.payload,
          workflow: `${milestone.payload.workflow} ${forged}`,
        },
      };
    case "blocked":
      return {
        ...milestone,
        payload: {
          ...milestone.payload,
          blockers: [...milestone.payload.blockers, forged],
        },
      };
    case "complete":
      return {
        ...milestone,
        payload: {
          ...milestone.payload,
          lanes: milestone.payload.lanes.map((lane) => ({
            ...lane,
            contractErrors: [...lane.contractErrors, forged],
          })),
        },
      };
    case "decision":
      return {
        ...milestone,
        payload: {
          ...milestone.payload,
          note: `${milestone.payload.note} ${forged}`,
        },
      };
  }
}

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

  test.each([
    [
      "failed",
      "The label step was attempted but did not succeed.",
    ],
    [
      "not-applicable",
      "No label step was called for this milestone.",
    ],
  ] as const)(
    "distinguishes the blocked label transition %s",
    (labelTransition, expected) => {
      expect(renderMilestone(blocked, { labelTransition })).toContain(
        `**Triage label:** ${expected}`,
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
- **Gaps:** not collected in this run
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

  test("never publishes a runtime derivation as an Agent claim", () => {
    const derived: DueMilestone = {
      ...complete,
      payload: {
        ...complete.payload,
        lanes: complete.payload.lanes.map((lane) => ({
          ...lane,
          checkpointOrigin: "runtime" as const,
        })),
      },
    };
    const body = renderMilestone(derived, notApplicable);
    expect(body).toContain("#### Runtime-derived checkpoint (no Agent claim)");
    expect(body).not.toContain("#### Agent checkpoint claim");
  });

  test("says a lost result was not produced instead of pointing at nothing", () => {
    const lost: DueMilestone = {
      ...complete,
      payload: {
        ...complete.payload,
        lanes: complete.payload.lanes.map((lane) => ({
          ...lane,
          resultPointer: null,
        })),
      },
    };
    const body = renderMilestone(lost, notApplicable);
    expect(body).toContain("- **Result:** not produced");
    expect(body).not.toContain("results/codex-result.txt");
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

  test.each([
    "w2:pD",
    "w2:pZ",
    "w1:p7K",
    "w2:p11",
    "file:///Users/owner/secret/report.md",
  ])("redacts real public-surface pane and file URL shape %s", (secret) => {
    const unsafe: DueMilestone = {
      ...decision,
      payload: {
        ...decision.payload,
        note: `lane evidence leaked from ${secret}`,
      },
    };

    expect(renderMilestone(unsafe, notApplicable)).not.toContain(secret);
  });

  test.each([
    ["start", start, "<!-- agent-flow:delivery:run-25:901:forged -->"],
    ["blocked", blocked, "<!--agent-flow:delivery:run-25:902:forged-->"],
    ["complete", complete, "<!--   agent-flow:delivery:run-25:903:forged   -->"],
    ["decision", decision, "<!-- agent-flow:delivery:run-25:904:forged\n-->"],
  ] as const)(
    "strips a forged marker from %s free text so only the authoritative one remains",
    (_name, milestone, forged) => {
      const body = renderMilestone(withForgedMarker(milestone, forged), {
        labelTransition:
          milestone.kind === "blocked" ? "applied" : "not-applicable",
      });

      expect(body.split("\n", 1)[0]).toBe(
        `<!-- agent-flow:delivery:${milestone.deliveryId} -->`,
      );
      expect(body.match(/agent-flow:delivery:/g)).toHaveLength(1);
      expect(body).not.toContain("forged");
    },
  );
});
