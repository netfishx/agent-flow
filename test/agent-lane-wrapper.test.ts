// The agent lane wrapper against real bash: stream routing, raw-report
// byte purity, sentinel with the CLI's real exit code, and the cwd guard.
// The "CLI" is a stub script so no model is involved.

import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentLaneCommand } from "../src/review/commands.ts";
import type { AgentLaneCommandInput } from "../src/review/commands.ts";

const STUB = `#!/bin/bash
# Echo stdin length, stream some progress on stderr, report on stdout.
input="$(cat)"
echo "progress one" >&2
printf 'REPORT-LINE-1\\n'
printf 'stdin-bytes=%s\\n' "\${#input}"
echo "progress two" >&2
exit "\${STUB_EXIT:-0}"
`;

interface WrapperRun {
  readonly exitCode: number;
  readonly root: string;
  readonly log: string;
  readonly stderrArtifact: string;
  readonly raw: string;
  readonly paneStdout: string;
  readonly paneStderr: string;
}

async function runWrapper(options: {
  stubExit?: number;
  agentKind?: AgentLaneCommandInput["agentKind"];
  badCwd?: boolean;
}): Promise<WrapperRun> {
  const root = await mkdtemp(join(tmpdir(), "flow-wrapper-"));
  const cliPath = join(root, "stub-cli");
  await writeFile(cliPath, STUB, "utf8");
  await chmod(cliPath, 0o755);
  const cwd = join(root, "worktree");
  if (!options.badCwd) await mkdir(cwd);
  const promptFile = join(root, "brief.md");
  await writeFile(promptFile, "the brief\n", "utf8");
  const input: AgentLaneCommandInput = {
    runId: "runw",
    laneId: "lane-w",
    agentKind: options.agentKind ?? "claude",
    model: "m",
    effort: "low",
    worktreePath: cwd,
    promptFile,
    rawReportFile: join(root, "raw.out"),
    logFile: join(root, "lane.log"),
    stderrFile: join(root, "lane.stderr.log"),
    sessionId: "00000000-0000-4000-8000-000000000001",
  };
  // Swap the real CLI argv for the stub: rebuild the command and replace the
  // trailing CLI tokens with the stub invocation.
  const command = buildAgentLaneCommand(input);
  const scriptStart = command.indexOf("'");
  const header = command.slice(0, scriptStart);
  expect(header).toBe("bash -c ");
  // Reuse the wrapper's own positional layout, but hand it the stub as "$@".
  const tokens = command.split(" '");
  void tokens;
  const stubbed = command.replace(
    /('claude'|'codex'|'grok')[^]*$/,
    `'${cliPath}'`,
  );
  // Herdr hands the one-line command to the pane's shell for re-parsing;
  // running the full line through bash emulates exactly that.
  const proc = Bun.spawn(["bash", "-c", stubbed], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(options.stubExit === undefined
        ? {}
        : { STUB_EXIT: String(options.stubExit) }),
    },
  });
  const [paneStdout, paneStderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const read = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    exitCode,
    root,
    log: await read(input.logFile),
    stderrArtifact: await read(input.stderrFile),
    raw: await read(input.rawReportFile),
    paneStdout,
    paneStderr,
  };
}

describe("agent lane wrapper (real bash)", () => {
  test("routes streams: raw gets only CLI stdout; log gets banner and sentinel", async () => {
    const run = await runWrapper({});
    expect(run.exitCode).toBe(0);
    // Raw report: CLI stdout bytes only — no banner, no sentinel. (The stub's
    // $(cat) strips the brief's trailing newline: 10 bytes in, 9 counted.)
    expect(run.raw).toBe("REPORT-LINE-1\nstdin-bytes=9\n");
    // Durable log: banner + CLI stdout + sentinel with the real exit code.
    expect(run.log).toContain("LANE_START run=runw lane=lane-w");
    expect(run.log).toContain("REPORT-LINE-1");
    expect(run.log).toContain("FLOW_runw_LANE_lane-w_EXIT=0");
    expect(run.raw).not.toContain("LANE_START");
    expect(run.raw).not.toContain("FLOW_runw_LANE_lane-w_EXIT");
    // Stderr artifact captures the CLI's own stderr; the pane sees it too.
    expect(run.stderrArtifact).toBe("progress one\nprogress two\n");
    expect(run.paneStderr).toContain("progress one");
    // The pane's stdout mirrors the durable log.
    expect(run.paneStdout).toContain("REPORT-LINE-1");
    expect(run.paneStdout).toContain("FLOW_runw_LANE_lane-w_EXIT=0");
  });

  test("the sentinel carries the CLI's real non-zero exit code", async () => {
    const run = await runWrapper({ stubExit: 7 });
    expect(run.exitCode).toBe(7);
    expect(run.log).toContain("FLOW_runw_LANE_lane-w_EXIT=7");
    expect(run.log).toContain("LANE_CLI_EXIT code=7");
  });

  test("grok mode leaves stdin closed and still tees the raw report", async () => {
    const run = await runWrapper({ agentKind: "grok" });
    expect(run.exitCode).toBe(0);
    // stdinMode=none: the stub read zero bytes from stdin.
    expect(run.raw).toBe("REPORT-LINE-1\nstdin-bytes=0\n");
  });

  test("codex mode never tees stdout into the raw file (the harness owns it)", async () => {
    const run = await runWrapper({ agentKind: "codex" });
    expect(run.exitCode).toBe(0);
    expect(run.raw).toBe("");
    expect(run.log).toContain("REPORT-LINE-1");
  });

  test("a missing worktree exits 97 and still prints the sentinel", async () => {
    const run = await runWrapper({ badCwd: true });
    expect(run.exitCode).toBe(97);
    expect(run.log).toContain("LANE_CWD_FAILED");
    expect(run.log).toContain("FLOW_runw_LANE_lane-w_EXIT=97");
  });
});
