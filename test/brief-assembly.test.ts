import { describe, expect, test } from "bun:test";
import {
  assembleBrief,
  assembleInputBundle,
  REPORT_CONTRACT_BLOCK,
  type ReviewAxis,
} from "../src/index.ts";

const BUNDLE = assembleInputBundle([
  {
    path: "bundle/issue-7.md",
    role: "issue",
    content: "Run six visible cross-review lanes.\n",
  },
  {
    path: "bundle/spec-7.md",
    role: "spec",
    content: "The executable spec body.\nSecond line.\n",
  },
  {
    path: "bundle/standards/agents.md",
    role: "standards",
    content: "Prefer deterministic tools.\n",
  },
]);

const FIXED_POINT = {
  baseCommit: "aaaa000000000000000000000000000000000000",
  headCommit: "bbbb111111111111111111111111111111111111",
  diffHash: "sha256:cafe",
};

const AGENTS = ["claude", "codex", "grok"] as const;
const AXES: readonly ReviewAxis[] = ["standards", "spec"];

function brief(agentKind: (typeof AGENTS)[number], axis: ReviewAxis): string {
  return assembleBrief({
    axis,
    agentKind,
    fixedPoint: FIXED_POINT,
    bundle: BUNDLE,
    artifactRoot: "/runs/flow-1",
  });
}

describe("assembleBrief", () => {
  test.each(
    AGENTS.flatMap((agent) => AXES.map((axis) => [agent, axis] as const)),
  )("golden brief for %s / %s", (agent, axis) => {
    expect(brief(agent, axis)).toMatchSnapshot();
  });

  test("is deterministic byte-for-byte", () => {
    expect(brief("claude", "standards")).toBe(brief("claude", "standards"));
  });

  test("every brief records the fixed point and the same bundle hash", () => {
    for (const agent of AGENTS) {
      for (const axis of AXES) {
        const text = brief(agent, axis);
        expect(text).toContain(FIXED_POINT.baseCommit);
        expect(text).toContain(FIXED_POINT.headCommit);
        expect(text).toContain(FIXED_POINT.diffHash);
        expect(text).toContain(BUNDLE.manifest.bundleHash);
      }
    }
  });

  test("the report contract block is appended verbatim to every brief", () => {
    for (const agent of AGENTS) {
      for (const axis of AXES) {
        expect(brief(agent, axis)).toContain(REPORT_CONTRACT_BLOCK);
      }
    }
  });

  test("the codex spec brief embeds the issue and spec text verbatim", () => {
    const text = brief("codex", "spec");
    expect(text).toContain("1\tRun six visible cross-review lanes.");
    expect(text).toContain("2\tSecond line.");
    expect(text).not.toContain("/runs/flow-1/bundle/issue-7.md");
  });

  test("claude and grok spec briefs point at bundle artifacts on disk", () => {
    for (const agent of ["claude", "grok"] as const) {
      const text = brief(agent, "spec");
      expect(text).toContain("/runs/flow-1/bundle/issue-7.md");
      expect(text).toContain("/runs/flow-1/bundle/spec-7.md");
      expect(text).not.toContain("/runs/flow-1/bundle/standards/agents.md");
    }
  });

  test("standards briefs draw only from standards materials", () => {
    const text = brief("claude", "standards");
    expect(text).toContain("/runs/flow-1/bundle/standards/agents.md");
    expect(text).not.toContain("bundle/issue-7.md");
  });

  test("an axis without materials refuses assembly", () => {
    const issueOnly = assembleInputBundle([
      { path: "bundle/issue.md", role: "issue", content: "x\n" },
    ]);
    expect(() =>
      assembleBrief({
        axis: "standards",
        agentKind: "claude",
        fixedPoint: FIXED_POINT,
        bundle: issueOnly,
        artifactRoot: "/runs/flow-1",
      }),
    ).toThrow("no materials for the standards axis");
  });
});
