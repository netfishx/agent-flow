import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  canonicalPayloadHash,
  type BlockedPayload,
  type CompletePayload,
  type DecisionPayload,
  type MilestonePayload,
  type StartPayload,
} from "../src/index.ts";

const startPayload: StartPayload = {
  hashVersion: 1,
  runId: "run-25",
  workflow: "cross-review /Users/alice/worktree",
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
};

const blockedPayload: BlockedPayload = {
  hashVersion: 1,
  runId: "run-25",
  laneId: "codex",
  role: "standards",
  blockers: ["cannot read /Users/alice/one.txt"],
  next: ["record the ruling"],
  gaps: ["verification pending"],
  checkpointPointer: "checkpoints/codex.md",
};

const completePayload: CompletePayload = {
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
      contractErrors: ["missing VERDICT at /Users/alice/result.txt"],
      verificationState: "failed",
      gaps: [],
      resultPointer: "results/codex-result.txt",
      evidencePointer: "evidence/codex-evidence.json",
      checkpointPointer: "checkpoints/codex.md",
      checkpointOrigin: "agent",
    },
  ],
};

const decisionPayload: DecisionPayload = {
  hashVersion: 1,
  runId: "run-25",
  decision: "changes-requested",
  note: "Read /Users/alice/decision.txt.",
  resultingIssueState: "ready-for-agent",
};

const goldenCases: readonly {
  readonly name: string;
  readonly payload: MilestonePayload;
  readonly canonical: string;
  readonly digest: string;
}[] = [
  {
    name: "start",
    payload: startPayload,
    canonical:
      '{"fixedPoint":{"baseCommit":"base","diffHash":"diff","dirtyStatePolicy":"reject","headCommit":"head"},"hashVersion":1,"lanes":[{"laneId":"codex","role":"standards"},{"laneId":"grok","role":null}],"runId":"run-25","workflow":"cross-review /Users/alice/worktree"}',
    digest: "d87439ee2fe43eaaad70b95b85b0dceebb952ac64253dfbb079fba23bce25f03",
  },
  {
    name: "blocked",
    payload: blockedPayload,
    canonical:
      '{"blockers":["cannot read /Users/alice/one.txt"],"checkpointPointer":"checkpoints/codex.md","gaps":["verification pending"],"hashVersion":1,"laneId":"codex","next":["record the ruling"],"role":"standards","runId":"run-25"}',
    digest: "f6341ee968bde12586525f6390b502b9c7ecacb72cf97857e3b61c309e2e027d",
  },
  {
    name: "complete",
    payload: completePayload,
    canonical:
      '{"breakdown":{"crashed":0,"exitedNonZero":1,"exitedZero":0,"failedToStart":0,"lost":0},"finishStatus":"degraded","hashVersion":1,"lanes":[{"checkpointOrigin":"agent","checkpointPointer":"checkpoints/codex.md","contractErrors":["missing VERDICT at /Users/alice/result.txt"],"contractState":"violated","evidencePointer":"evidence/codex-evidence.json","exitCode":1,"gaps":[],"laneId":"codex","resultPointer":"results/codex-result.txt","role":"standards","runtimeState":"exited","semanticState":"partial","signal":null,"verificationState":"failed"}],"runId":"run-25"}',
    digest: "a1a39f278e44f76713df5c7dc9698ea30e41e3a30582ee51d87c03ca40f6983c",
  },
  {
    name: "decision",
    payload: decisionPayload,
    canonical:
      '{"decision":"changes-requested","hashVersion":1,"note":"Read /Users/alice/decision.txt.","resultingIssueState":"ready-for-agent","runId":"run-25"}',
    digest: "064820f0b4991ee0039dc9a4d0b2fd65f4221ebd26293567122069038381127e",
  },
];

describe("canonical milestone payload hashes", () => {
  test("sorts object keys recursively, preserves array order, and emits UTF-8 JSON without whitespace", () => {
    expect(
      canonicalJson({
        z: [{ β: "東京", a: 1 }],
        a: { z: true, a: null },
      }),
    ).toBe('{"a":{"a":null,"z":true},"z":[{"a":1,"β":"東京"}]}');
  });

  test.each([...goldenCases])(
    "$name has a checkable canonical form and golden SHA-256 digest",
    ({ payload, canonical, digest }) => {
      expect(canonicalJson(payload)).toBe(canonical);
      expect(canonicalPayloadHash(payload)).toBe(digest);
    },
  );

  test.each([
    ["start", startPayload],
    ["blocked", blockedPayload],
    ["complete", completePayload],
    ["decision", decisionPayload],
  ] as const)(
    "%s ignores every excluded delivery, environment, path, and clock field",
    (_name, payload) => {
      const excluded = {
        ...payload,
        at: 999,
        capturedAt: 999,
        cwd: "/secret/worktree",
        workspace: "private-workspace",
        repoRoot: "/secret/repository",
        tabId: "secret-tab",
        controllerPaneId: "secret-controller-pane",
        paneId: "secret-pane",
        logFile: "/secret/log",
        stderrFile: "/secret/stderr",
        sentinelToken: "FLOW_secret",
        dispatchedCommand: "GH_TOKEN=secret agent",
        waitMatched: true,
        intents: 99,
        commentId: 42,
        commentUrl: "https://example.invalid/comment",
        labelTransition: "applied",
        lastFailure: { reason: "secret", retryable: true },
        controllerId: "controller-secret",
        controllerEpoch: 9,
        pid: 123,
        sequence: 88,
        ...("fixedPoint" in payload && payload.fixedPoint !== null
          ? {
              fixedPoint: {
                ...payload.fixedPoint,
                repoRoot: "/secret/repository",
                capturedAt: 999,
              },
            }
          : {}),
        ...("lanes" in payload
          ? {
              lanes: payload.lanes.map((lane) => ({
                ...lane,
                paneId: "secret-pane",
                logFile: "/secret/log",
                stderrFile: "/secret/stderr",
                sentinelToken: "FLOW_secret",
                dispatchedCommand: "GH_TOKEN=secret agent",
                waitMatched: true,
              })),
            }
          : {}),
      } as unknown as MilestonePayload;

      expect(canonicalPayloadHash(excluded)).toBe(
        canonicalPayloadHash(payload),
      );
    },
  );

  test.each([
    ["start hashVersion", startPayload, { ...startPayload, hashVersion: 2 }],
    ["start runId", startPayload, { ...startPayload, runId: "other-run" }],
    ["start workflow", startPayload, { ...startPayload, workflow: "implement" }],
    ["start lanes", startPayload, { ...startPayload, lanes: [] }],
    ["start laneId", startPayload, {
      ...startPayload,
      lanes: [{ ...startPayload.lanes[0]!, laneId: "other" }],
    }],
    ["start role", startPayload, {
      ...startPayload,
      lanes: [{ ...startPayload.lanes[0]!, role: "spec" }],
    }],
    ["start fixedPoint", startPayload, { ...startPayload, fixedPoint: null }],
    ["start baseCommit", startPayload, {
      ...startPayload,
      fixedPoint: { ...startPayload.fixedPoint!, baseCommit: "other" },
    }],
    ["start headCommit", startPayload, {
      ...startPayload,
      fixedPoint: { ...startPayload.fixedPoint!, headCommit: "other" },
    }],
    ["start diffHash", startPayload, {
      ...startPayload,
      fixedPoint: { ...startPayload.fixedPoint!, diffHash: "other" },
    }],
    ["start dirtyStatePolicy", startPayload, {
      ...startPayload,
      fixedPoint: {
        ...startPayload.fixedPoint!,
        dirtyStatePolicy: "record-hash",
      },
    }],
    ["blocked runId", blockedPayload, { ...blockedPayload, runId: "other-run" }],
    ["blocked hashVersion", blockedPayload, {
      ...blockedPayload,
      hashVersion: 2,
    }],
    ["blocked laneId", blockedPayload, { ...blockedPayload, laneId: "grok" }],
    ["blocked role", blockedPayload, { ...blockedPayload, role: null }],
    ["blocked blockers", blockedPayload, { ...blockedPayload, blockers: [] }],
    ["blocked next", blockedPayload, { ...blockedPayload, next: [] }],
    ["blocked gaps", blockedPayload, { ...blockedPayload, gaps: [] }],
    ["blocked pointer", blockedPayload, {
      ...blockedPayload,
      checkpointPointer: "checkpoints/other.md",
    }],
    ["complete runId", completePayload, { ...completePayload, runId: "other" }],
    ["complete hashVersion", completePayload, {
      ...completePayload,
      hashVersion: 2,
    }],
    ["complete finishStatus", completePayload, {
      ...completePayload,
      finishStatus: "clean",
    }],
    ...(
      [
        "exitedZero",
        "exitedNonZero",
        "crashed",
        "lost",
        "failedToStart",
      ] as const
    ).map((field) => [
      `complete breakdown ${field}`,
      completePayload,
      {
        ...completePayload,
        breakdown: {
          ...completePayload.breakdown,
          [field]: completePayload.breakdown[field] + 1,
        },
      },
    ]),
    ["complete lanes", completePayload, { ...completePayload, lanes: [] }],
    ...(
      [
        ["laneId", "other"],
        ["role", null],
        ["runtimeState", "crashed"],
        ["exitCode", 0],
        ["signal", "SIGTERM"],
        ["semanticState", "complete"],
        ["contractState", "satisfied"],
        ["contractErrors", []],
        ["verificationState", "verified"],
        ["gaps", ["unexpected"]],
        ["resultPointer", "results/other.txt"],
        ["evidencePointer", "evidence/other.json"],
        ["checkpointPointer", null],
      ] as const
    ).map(([field, value]) => [
      `complete ${field}`,
      completePayload,
      {
        ...completePayload,
        lanes: [{ ...completePayload.lanes[0]!, [field]: value }],
      },
    ]),
    ["decision runId", decisionPayload, { ...decisionPayload, runId: "other" }],
    ["decision hashVersion", decisionPayload, {
      ...decisionPayload,
      hashVersion: 2,
    }],
    ["decision decision", decisionPayload, {
      ...decisionPayload,
      decision: "accepted",
    }],
    ["decision note", decisionPayload, { ...decisionPayload, note: "Other." }],
    ["decision issue state", decisionPayload, {
      ...decisionPayload,
      resultingIssueState: null,
    }],
  ] as readonly (readonly [string, MilestonePayload, unknown])[])(
    "changing included field %s changes the digest",
    (_name, original, changed) => {
      expect(canonicalPayloadHash(changed as MilestonePayload)).not.toBe(
        canonicalPayloadHash(original),
      );
    },
  );
});
