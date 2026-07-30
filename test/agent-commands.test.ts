import { describe, expect, test } from "bun:test";
import {
  buildAgentCliArgv,
  buildAgentLaneCommand,
  type AgentLaneCommandInput,
} from "../src/index.ts";
import { scanSingleQuoted } from "../src/testing.ts";

function input(
  overrides: Partial<AgentLaneCommandInput> = {},
): AgentLaneCommandInput {
  return {
    runId: "run-1",
    laneId: "claude-standards",
    agentKind: "claude",
    model: "claude-opus-5",
    effort: "high",
    worktreePath: "/runs/run-1/worktrees/claude-standards",
    promptFile: "/runs/run-1/briefs/claude-standards.md",
    rawReportFile: "/runs/run-1/reports/claude-standards.raw",
    logFile: "/runs/run-1/logs/claude-standards.log",
    stderrFile: "/runs/run-1/logs/claude-standards.stderr.log",
    sessionId: "11111111-2222-3333-4444-555555555555",
    ...overrides,
  };
}

describe("buildAgentCliArgv", () => {
  test("claude uses the verified read-only + stream-json battery", () => {
    expect(buildAgentCliArgv(input())).toEqual([
      "claude",
      "-p",
      "--model",
      "claude-opus-5",
      "--effort",
      "high",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
      "--tools",
      "Bash,Read,Glob,Grep",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git status:*)",
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--setting-sources",
      "",
    ]);
  });

  test("codex uses the read-only sandbox with -o as the raw report", () => {
    expect(
      buildAgentCliArgv(
        input({
          agentKind: "codex",
          laneId: "codex-spec",
          model: "gpt-5.6-sol",
          sessionId: null,
        }),
      ),
    ).toEqual([
      "codex",
      "exec",
      "-s",
      "read-only",
      "-c",
      "model=gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
      "-o",
      "/runs/run-1/reports/claude-standards.raw",
    ]);
  });

  test("grok uses prompt-file, no-leader, and a pre-assigned session id", () => {
    expect(
      buildAgentCliArgv(
        input({ agentKind: "grok", model: "grok-4.5" }),
      ),
    ).toEqual([
      "grok",
      "--no-leader",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
      "--prompt-file",
      "/runs/run-1/briefs/claude-standards.md",
      "-m",
      "grok-4.5",
      "--reasoning-effort",
      "high",
      "--disable-web-search",
      "--always-approve",
      "--output-format",
      "plain",
    ]);
  });

  test("the grok streaming-json contingency surface is selectable", () => {
    const argv = buildAgentCliArgv(
      input({ agentKind: "grok", grokOutputFormat: "streaming-json" }),
    );
    expect(argv.slice(-2)).toEqual(["--output-format", "streaming-json"]);
  });

  test.each(["claude", "grok"] as const)(
    "a %s lane refuses to build without a pre-assigned session id",
    (agentKind) => {
      expect(() =>
        buildAgentCliArgv(input({ agentKind, sessionId: null })),
      ).toThrow("requires a pre-assigned session id");
    },
  );
});

describe("buildAgentLaneCommand", () => {
  test("emits one bash -c line whose quoting round-trips", () => {
    const command = buildAgentLaneCommand(input());
    expect(command.startsWith("bash -c '")).toBe(true);
    expect(command).not.toContain("\n'");
    const tokens = scanSingleQuoted(command);
    // [script, runId, laneId, cwd, log, stderr, raw, prompt, stdinMode,
    //  rawMode, ...cli]
    expect(tokens[0]).toStartWith("# flow agent lane");
    expect(tokens.slice(1, 10)).toEqual([
      "run-1",
      "claude-standards",
      "/runs/run-1/worktrees/claude-standards",
      "/runs/run-1/logs/claude-standards.log",
      "/runs/run-1/logs/claude-standards.stderr.log",
      "/runs/run-1/reports/claude-standards.raw",
      "/runs/run-1/briefs/claude-standards.md",
      "file",
      "tee",
    ]);
    expect(tokens.slice(10)).toEqual(buildAgentCliArgv(input()));
  });

  test("codex routes the raw report through the harness, not a tee", () => {
    const tokens = scanSingleQuoted(
      buildAgentLaneCommand(input({ agentKind: "codex", sessionId: null })),
    );
    expect(tokens[8]).toBe("file");
    expect(tokens[9]).toBe("harness");
  });

  test("grok takes its brief from --prompt-file, not stdin", () => {
    const tokens = scanSingleQuoted(
      buildAgentLaneCommand(input({ agentKind: "grok" })),
    );
    expect(tokens[8]).toBe("none");
    expect(tokens[9]).toBe("tee");
  });

  test("the wrapper prints the run+lane sentinel with the real exit code", () => {
    const script = scanSingleQuoted(buildAgentLaneCommand(input()))[0]!;
    expect(script).toContain('token="FLOW_${runId}_LANE_${laneId}_EXIT"');
    expect(script).toContain('laneStatus="${PIPESTATUS[0]}"');
    expect(script).toContain("trap ':' INT");
    expect(script).toContain('tee -a "$rawFile"');
    expect(script).toContain('tee -a "$stderrFile"');
    expect(script).toContain('tee -a "$logFile"');
  });
});
