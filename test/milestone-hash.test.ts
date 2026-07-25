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
};

const blockedPayload: BlockedPayload = {
  hashVersion: 1,
  runId: "run-25",
  laneId: "codex",
  role: "standards",
  blockers: ["owner decision required"],
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
      contractErrors: ["missing VERDICT"],
      verificationState: "failed",
      gaps: [],
      resultPointer: "results/codex-result.txt",
      evidencePointer: "evidence/codex-evidence.json",
      checkpointPointer: "checkpoints/codex.md",
    },
  ],
};

const decisionPayload: DecisionPayload = {
  hashVersion: 1,
  runId: "run-25",
  decision: "changes-requested",
  note: "Add objective evidence.",
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
      '{"fixedPoint":{"baseCommit":"base","diffHash":"diff","dirtyStatePolicy":"reject","headCommit":"head"},"hashVersion":1,"lanes":[{"laneId":"codex","role":"standards"},{"laneId":"grok","role":null}],"runId":"run-25","workflow":"cross-review"}',
    digest: "d6e3659adcb16e61bdc05b89fd27c32751ae2d75c162f85cffff83bf8a997e21",
  },
  {
    name: "blocked",
    payload: blockedPayload,
    canonical:
      '{"blockers":["owner decision required"],"checkpointPointer":"checkpoints/codex.md","gaps":["verification pending"],"hashVersion":1,"laneId":"codex","next":["record the ruling"],"role":"standards","runId":"run-25"}',
    digest: "e1d2c6dff34f8039d2b244c197e32aac6cf83983ebf1669fdebe62bafce70c8d",
  },
  {
    name: "complete",
    payload: completePayload,
    canonical:
      '{"breakdown":{"crashed":0,"exitedNonZero":1,"exitedZero":0,"failedToStart":0,"lost":0},"finishStatus":"degraded","hashVersion":1,"lanes":[{"checkpointPointer":"checkpoints/codex.md","contractErrors":["missing VERDICT"],"contractState":"violated","evidencePointer":"evidence/codex-evidence.json","exitCode":1,"gaps":[],"laneId":"codex","resultPointer":"results/codex-result.txt","role":"standards","runtimeState":"exited","semanticState":"partial","signal":null,"verificationState":"failed"}],"runId":"run-25"}',
    digest: "f6ed62480f8e2e0c48c152f3d96f4a8403ed327ed637ef70dd9219728698abf3",
  },
  {
    name: "decision",
    payload: decisionPayload,
    canonical:
      '{"decision":"changes-requested","hashVersion":1,"note":"Add objective evidence.","resultingIssueState":"ready-for-agent","runId":"run-25"}',
    digest: "34f0d654be7a90d9e0d2ecb47ae6e6b2a69c7691fa3db76e596935065432966f",
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
