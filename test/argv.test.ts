import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  escapeRegex,
  paneRunArgv,
  shellSingleQuote,
} from "../src/herdr/argv.ts";
import { scanSingleQuoted } from "../src/herdr/fake-adapter.ts";
import { buildLaneCommand } from "../src/smoke/lane.ts";

describe("shell quoting", () => {
  test("wraps plain and space-containing values", () => {
    expect(shellSingleQuote("abc")).toBe("'abc'");
    expect(shellSingleQuote("a b")).toBe("'a b'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });

  test("round-trips adversarial values", () => {
    for (const value of [
      "plain",
      "a b c",
      "a'b",
      "$(rm -rf /)",
      "x; echo hi",
      "a && b",
      "quote'in'middle",
      "trailing'",
    ]) {
      expect(scanSingleQuoted(shellSingleQuote(value))).toEqual([value]);
    }
  });
});

describe("escapeRegex", () => {
  test("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
    expect(escapeRegex("FLOW_run-1_LANE_lane-2_EXIT")).toBe(
      "FLOW_run-1_LANE_lane-2_EXIT",
    );
  });
});

describe("paneRunArgv", () => {
  test("passes the command as a single argv element", () => {
    const argv = paneRunArgv({ id: "w2:pD" }, "bash -c 'echo hi'");
    expect(argv).toEqual(["pane", "run", "w2:pD", "bash -c 'echo hi'"]);
    // The quoted command survives as ONE element — no per-word argv leaks out.
    expect(argv).toHaveLength(4);
  });
});

describe("buildLaneCommand", () => {
  test("emits one bash -c line with positional, quoted args", () => {
    const command = buildLaneCommand({
      runId: "run1",
      laneId: "lane-2",
      logFile: "/tmp/ev/lane-2.log",
      stderrFile: "/tmp/ev/lane-2.stderr.log",
      checkpointFile: "/tmp/ev/checkpoints/lane-2.md",
      resultFile: "/tmp/ev/results/lane-2-result.txt",
      steps: 5,
      stepDelaySeconds: 0.2,
    });
    expect(command.startsWith("bash -c '")).toBe(true);
    const tokens = scanSingleQuoted(command);
    // [script, runId, laneId, logFile, stderrFile, steps, delay]
    expect(tokens[1]).toBe("run1");
    expect(tokens[2]).toBe("lane-2");
    expect(tokens[3]).toBe("/tmp/ev/lane-2.log");
    expect(tokens[4]).toBe("/tmp/ev/lane-2.stderr.log");
    expect(tokens[5]).toBe("5");
  });

  test("keeps the sentinel token format aligned with laneSentinelToken", () => {
    const command = buildLaneCommand({
      runId: "run1",
      laneId: "lane-2",
      logFile: "/tmp/ev/lane-2.log",
      stderrFile: "/tmp/ev/lane-2.stderr.log",
      checkpointFile: "/tmp/ev/checkpoints/lane-2.md",
      resultFile: "/tmp/ev/results/lane-2-result.txt",
      steps: 5,
      stepDelaySeconds: 0.2,
    });
    // The script builds the token from bash vars; assert the literal template
    // matches FLOW_<run>_LANE_<lane>_EXIT so the two sides cannot drift.
    expect(command).toContain("FLOW_${runId}_LANE_${laneId}_EXIT");
  });

  test("quotes an adversarial laneId safely", () => {
    const command = buildLaneCommand({
      runId: "run1",
      laneId: "l'x",
      logFile: "/tmp/ev/lane.log",
      stderrFile: "/tmp/ev/lane.stderr.log",
      checkpointFile: "/tmp/ev/checkpoints/lane.md",
      resultFile: "/tmp/ev/results/lane-result.txt",
      steps: 1,
      stepDelaySeconds: 0.2,
    });
    expect(scanSingleQuoted(command)[2]).toBe("l'x");
  });

  test("writes the checkpoint and result schemas through adversarial paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-flow-lane-' quoted "));
    try {
      const logFile = join(root, "logs", "lane's log.txt");
      const stderrFile = join(root, "logs", "lane's stderr.txt");
      const checkpointFile = join(root, "check points", "lane's checkpoint.md");
      const resultFile = join(root, "result files", "lane's result.txt");
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(logFile, "", "utf8");
      const command = buildLaneCommand({
        runId: "run1",
        laneId: "lane-2",
        logFile,
        stderrFile,
        checkpointFile,
        resultFile,
        steps: 1,
        stepDelaySeconds: 0.001,
      });
      const process = Bun.spawn(["bash", "-c", command], {
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(0);
      expect(await readFile(logFile, "utf8")).toContain(
        "FLOW_run1_LANE_lane-2_EXIT=0",
      );
      expect(await readFile(stderrFile, "utf8")).toBe("");
      const checkpoint = await readFile(checkpointFile, "utf8");
      for (const field of [
        "STATUS: complete",
        "PHASE:",
        "COMPLETED:",
        "NEXT:",
        "BLOCKERS:",
        "ARTIFACTS:",
        "VERIFICATION_CLAIMS:",
        "GAPS:",
      ]) {
        expect(checkpoint).toContain(field);
      }
      expect(await readFile(resultFile, "utf8")).toBe("RESULT: ok steps=1\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("captures setup failures in the durable stderr log", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-flow-lane-setup-"));
    try {
      const invalidParent = join(root, "not-a-directory");
      await writeFile(invalidParent, "file", "utf8");
      const logFile = join(root, "logs", "lane.log");
      const stderrFile = join(root, "logs", "lane.stderr.log");
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(logFile, "", "utf8");
      const command = buildLaneCommand({
        runId: "run1",
        laneId: "lane-2",
        logFile,
        stderrFile,
        checkpointFile: join(invalidParent, "checkpoint.md"),
        resultFile: join(root, "results", "result.txt"),
        steps: 0,
        stepDelaySeconds: 0,
      });
      const process = Bun.spawn(["bash", "-c", command], {
        stdout: "ignore",
        stderr: "ignore",
      });

      await process.exited;

      expect(await readFile(stderrFile, "utf8")).toMatch(
        /^mkdir:.*not-a-directory/m,
      );
      expect(await readFile(logFile, "utf8")).not.toMatch(
        /^mkdir:.*not-a-directory/m,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("captures stdout-writer failures in the durable stderr log", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-flow-lane-tee-error-"));
    try {
      const logFile = join(root, "log-is-a-directory");
      const stderrFile = join(root, "logs", "lane.stderr.log");
      await mkdir(logFile, { recursive: true });
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(stderrFile, "", "utf8");
      const command = buildLaneCommand({
        runId: "run1",
        laneId: "lane-2",
        logFile,
        stderrFile,
        checkpointFile: join(root, "checkpoints", "lane.md"),
        resultFile: join(root, "results", "result.txt"),
        steps: 1,
        stepDelaySeconds: 0,
      });
      const process = Bun.spawn(["bash", "-c", command], {
        stdout: "ignore",
        stderr: "ignore",
      });

      await process.exited;

      expect(await readFile(stderrFile, "utf8")).toMatch(/^tee:/m);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("durably records an interrupt delivered to the lane process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-flow-lane-sigint-"));
    const logFile = join(root, "logs", "lane.log");
    const stderrFile = join(root, "logs", "lane.stderr.log");
    const checkpointFile = join(root, "checkpoints", "lane.md");
    const resultFile = join(root, "results", "lane-result.txt");
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(logFile, "", "utf8");
    const command = buildLaneCommand({
      runId: "interrupt-run",
      laneId: "interrupt-lane",
      logFile,
      stderrFile,
      checkpointFile,
      resultFile,
      steps: 10,
      stepDelaySeconds: 10,
    });
    const lane = Bun.spawn(["bash", "-c", command], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!(await readFile(logFile, "utf8")).includes("STEP=1/10")) {
        if (Date.now() >= deadline) {
          throw new Error("lane did not write its first step before timeout");
        }
        await Bun.sleep(10);
      }

      process.kill(-lane.pid, "SIGINT");
      expect(await lane.exited).toBe(130);

      const log = await readFile(logFile, "utf8");
      expect(log).toContain("EVENT=interrupted-SIGINT");
      expect(log).toContain(
        "FLOW_interrupt-run_LANE_interrupt-lane_EXIT=130",
      );
      expect(await readFile(checkpointFile, "utf8")).toContain(
        "STATUS: partial",
      );
      expect(await readFile(resultFile, "utf8")).toContain(
        "RESULT: interrupted",
      );
    } finally {
      try {
        process.kill(-lane.pid, "SIGKILL");
      } catch {
        // The process group already exited normally.
      }
      await rm(root, { recursive: true });
    }
  });
});
