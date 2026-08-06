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

  test("derives a valid name from a lane and attempt", () => {
    const name = agentNameFor("Standards/Claude", "att-7");
    expect(isValidAgentName(name)).toBe(true);
    expect(name).toContain("att-7".toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
  });

  test("a derived name stays inside the length ceiling", () => {
    const name = agentNameFor("a".repeat(40), "b".repeat(40));
    expect(isValidAgentName(name)).toBe(true);
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
