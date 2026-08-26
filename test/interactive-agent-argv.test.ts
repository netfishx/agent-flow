// The argv and JSON boundary for Herdr's agent surface. Every `herdr agent`
// invocation is an argv array — never a joined shell string — and every
// response goes through one parser that fails loudly on an unexpected shape.

import { describe, expect, test } from "bun:test";
import {
  agentGetArgv,
  agentNameFor,
  agentPromptArgv,
  agentSendKeysArgv,
  agentStartArgv,
  agentWaitArgv,
  isValidAgentName,
  paneReleaseAgentArgv,
  paneReportAgentArgv,
} from "../src/herdr/agent-argv.ts";
import {
  parseAgentInfo,
  parseAgentPrompted,
  parseAgentStarted,
} from "../src/herdr/agent-json.ts";
import { HerdrParseError } from "../src/herdr/json.ts";
import { buildNativeArgs } from "../src/interactive/commands.ts";

describe("agent names", () => {
  test("accepts the documented shape and rejects everything else", () => {
    expect(isValidAgentName("flow-l1")).toBe(true);
    expect(isValidAgentName("a")).toBe(true);
    expect(isValidAgentName("a".repeat(32))).toBe(true);
    expect(isValidAgentName("a".repeat(33))).toBe(false);
    expect(isValidAgentName("1lane")).toBe(false);
    expect(isValidAgentName("Flow")).toBe(false);
    expect(isValidAgentName("flow lane")).toBe(false);
    expect(isValidAgentName("")).toBe(false);
  });

  test("derives a valid, stable, lane-readable name", () => {
    const name = agentNameFor("Standards/Claude", "att-7");
    expect(isValidAgentName(name)).toBe(true);
    expect(name).toContain("standards");
    // Same inputs, same name: a control call can re-derive the target.
    expect(agentNameFor("Standards/Claude", "att-7")).toBe(name);
  });

  test("a derived name stays inside the length ceiling", () => {
    const name = agentNameFor("a".repeat(40), "b".repeat(40));
    expect(isValidAgentName(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(32);
  });

  test("attempt ids sharing a long prefix do not collide", () => {
    // A prefix-truncating name would map all of these onto one string, and a
    // duplicate name is rejected by Herdr as a start failure.
    const names = new Set(
      Array.from({ length: 200 }, (_, i) =>
        agentNameFor("a-long-lane-identifier", `att-mabcdefg-${i}`),
      ),
    );
    expect(names.size).toBe(200);
  });
});

describe("agent argv", () => {
  test("start passes native args after the -- separator", () => {
    expect(
      agentStartArgv({
        name: "flow-l1",
        kind: "claude",
        paneId: "w1:p2",
        timeoutMs: 30_000,
        nativeArgs: ["--model", "sonnet", "--permission-mode", "acceptEdits"],
      }),
    ).toEqual([
      "agent",
      "start",
      "flow-l1",
      "--kind",
      "claude",
      "--pane",
      "w1:p2",
      "--timeout",
      "30000",
      "--",
      "--model",
      "sonnet",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  test("start rejects an out-of-range timeout and an invalid name", () => {
    const base = { name: "flow-l1", kind: "claude", paneId: "w1:p2" } as const;
    expect(() => agentStartArgv({ ...base, timeoutMs: 300_001 })).toThrow(
      /timeout/,
    );
    expect(() => agentStartArgv({ ...base, timeoutMs: 0 })).toThrow(/timeout/);
    expect(() => agentStartArgv({ ...base, name: "Flow" })).toThrow(/name/);
  });

  test("start omits the separator when there are no native args", () => {
    expect(
      agentStartArgv({ name: "flow-l1", kind: "codex", paneId: "w1:p2" }),
    ).toEqual(["agent", "start", "flow-l1", "--kind", "codex", "--pane", "w1:p2"]);
  });

  test("prompt carries the text as one argument, never a shell fragment", () => {
    const text = "please run `bun test`; then 'stop'";
    expect(agentPromptArgv("flow-l1", text, { waitMs: 5_000 })).toEqual([
      "agent",
      "prompt",
      "flow-l1",
      text,
      "--wait",
      "--timeout",
      "5000",
    ]);
    expect(agentPromptArgv("flow-l1", text)).toEqual([
      "agent",
      "prompt",
      "flow-l1",
      text,
    ]);
  });

  test("send-keys uses the canonical escape key name", () => {
    expect(agentSendKeysArgv("flow-l1", ["esc"])).toEqual([
      "agent",
      "send-keys",
      "flow-l1",
      "esc",
    ]);
  });

  test("wait repeats --until per requested state", () => {
    expect(agentWaitArgv("flow-l1", ["blocked", "idle"], 9_000)).toEqual([
      "agent",
      "wait",
      "flow-l1",
      "--until",
      "blocked",
      "--until",
      "idle",
      "--timeout",
      "9000",
    ]);
  });

  test("get takes the target alone", () => {
    expect(agentGetArgv("flow-l1")).toEqual(["agent", "get", "flow-l1"]);
  });

  test("report-agent publishes advisory state and cannot publish done", () => {
    expect(
      paneReportAgentArgv({
        paneId: "w1:p2",
        source: "flow-run1",
        agent: "flow-l1",
        state: "working",
        message: "attempt a1 live",
      }),
    ).toEqual([
      "pane",
      "report-agent",
      "--source",
      "flow-run1",
      "--agent",
      "flow-l1",
      "--state",
      "working",
      "--message",
      "attempt a1 live",
      "w1:p2",
    ]);
    expect(
      paneReleaseAgentArgv({
        paneId: "w1:p2",
        source: "flow-run1",
        agent: "flow-l1",
      }),
    ).toEqual([
      "pane",
      "release-agent",
      "--source",
      "flow-run1",
      "--agent",
      "flow-l1",
      "w1:p2",
    ]);
  });
});

describe("agent JSON", () => {
  const info = {
    pane_id: "w1:p2",
    tab_id: "w1:t1",
    terminal_id: "t-9",
    name: "flow-l1",
    agent: "claude",
    agent_status: "working",
    interactive_ready: true,
    launch_pending: false,
    focused: false,
    revision: 4,
    state_change_seq: 12,
    state_labels: {},
    agent_session: {
      source: "integration",
      agent: "claude",
      kind: "session_id",
      value: "sess-abc",
    },
  };

  test("parses agent_info, agent_started, and agent_prompted envelopes", () => {
    const parsedInfo = parseAgentInfo(
      JSON.stringify({ id: 1, result: { type: "agent_info", agent: info } }),
    );
    expect(parsedInfo).toEqual({
      paneId: "w1:p2",
      name: "flow-l1",
      agent: "claude",
      status: "working",
      interactiveReady: true,
      launchPending: false,
      sessionId: "sess-abc",
    });

    const started = parseAgentStarted(
      JSON.stringify({
        id: 2,
        result: { type: "agent_started", agent: info, argv: ["claude", "-p"] },
      }),
    );
    expect(started.argv).toEqual(["claude", "-p"]);
    expect(started.agent.name).toBe("flow-l1");

    expect(
      parseAgentPrompted(
        JSON.stringify({ id: 3, result: { type: "agent_prompted", agent: info } }),
      ).status,
    ).toBe("working");
  });

  test("a missing session yields an explicit null, never a guess", () => {
    const parsed = parseAgentInfo(
      JSON.stringify({
        result: { type: "agent_info", agent: { ...info, agent_session: null } },
      }),
    );
    expect(parsed.sessionId).toBeNull();
  });

  test("an unknown agent_status is rejected rather than coerced", () => {
    expect(() =>
      parseAgentInfo(
        JSON.stringify({
          result: { type: "agent_info", agent: { ...info, agent_status: "busy" } },
        }),
      ),
    ).toThrow(HerdrParseError);
  });

  test("a malformed envelope throws instead of returning a partial shape", () => {
    expect(() => parseAgentInfo("not json")).toThrow(HerdrParseError);
    expect(() => parseAgentInfo(JSON.stringify({ result: {} }))).toThrow(
      HerdrParseError,
    );
    expect(() =>
      parseAgentStarted(
        JSON.stringify({ result: { type: "agent_started", agent: info } }),
      ),
    ).toThrow(HerdrParseError);
  });
});

describe("the production native argv pins the approval boundary", () => {
  // Stage 1 measured host configuration silently removing the human approval
  // boundary: grok inherited `always-approve` from ~/.grok/config.toml, codex
  // inherited `approvals_reviewer = "guardian_subagent"` from
  // ~/.codex/config.toml, and claude was launched by this very function with
  // `acceptEdits`. v1 therefore pins the policy per invocation.
  const SESSION = "11111111-2222-3333-4444-555555555555";

  test("claude asks its own way: default, never acceptEdits", () => {
    const argv = buildNativeArgs({
      agentKind: "claude",
      model: "sonnet",
      effort: "high",
      sessionId: SESSION,
    });

    expect(argv).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--permission-mode",
      "default",
      "--session-id",
      SESSION,
    ]);
    expect(argv).not.toContain("acceptEdits");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).not.toContain("dontAsk");
  });

  test("codex keeps its sandbox and sends every raised request to a human", () => {
    const argv = buildNativeArgs({
      agentKind: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      sessionId: null,
    });

    expect(argv).toEqual([
      "-c",
      "model=gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
      "-s",
      "workspace-write",
      "-a",
      "on-request",
      "-c",
      "approvals_reviewer=user",
    ]);
    // The sandbox axis and the approval axis are separate, and both are pinned.
    expect(argv[argv.indexOf("-s") + 1]).toBe("workspace-write");
    expect(argv[argv.indexOf("-a") + 1]).toBe("on-request");
    // `user` is the reviewer that is a person. Stage 2 measured codex 0.149.1
    // refusing to start at all on `none`: "unknown variant `none`, expected one
    // of `user`, `auto_review`, `guardian_subagent`".
    expect(argv).toContain("approvals_reviewer=user");
    expect(argv).not.toContain("approvals_reviewer=none");
    expect(argv).not.toContain("approvals_reviewer=auto_review");
    expect(argv).not.toContain("approvals_reviewer=guardian_subagent");
    expect(argv).not.toContain("never");
    expect(argv).not.toContain("--approve-for-me");
  });

  test("every pinned flag carries its value as the next argument", () => {
    // A flag whose value drifted onto the wrong index is argv the CLI rejects.
    const pairs = [
      ["claude", SESSION, ["--model", "--effort", "--permission-mode", "--session-id"]],
      ["codex", null, ["-s", "-a"]],
    ] as const;
    for (const [kind, sessionId, flags] of pairs) {
      const argv = buildNativeArgs({
        agentKind: kind,
        model: "m",
        effort: "e",
        sessionId,
      });
      for (const flag of flags) {
        const at = argv.indexOf(flag);
        expect(at).toBeGreaterThanOrEqual(0);
        const value = argv[at + 1];
        expect(value).toBeDefined();
        expect(value!.startsWith("-")).toBe(false);
      }
    }
  });

  test("model, effort and session inputs still reach the argv", () => {
    expect(
      buildNativeArgs({
        agentKind: "claude",
        model: "opus",
        effort: "xhigh",
        sessionId: SESSION,
      }),
    ).toEqual([
      "--model",
      "opus",
      "--effort",
      "xhigh",
      "--permission-mode",
      "default",
      "--session-id",
      SESSION,
    ]);
    expect(
      buildNativeArgs({
        agentKind: "codex",
        model: "gpt-x",
        effort: "low",
        sessionId: null,
      }).slice(0, 4),
    ).toEqual(["-c", "model=gpt-x", "-c", "model_reasoning_effort=low"]);
  });
});
