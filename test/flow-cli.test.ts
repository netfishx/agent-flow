import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { RunEvent } from "../src/runtime/events.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-cli-"));
  roots.push(root);
  return root;
}

async function seedFinishedRun(
  root: string,
  options: { finished?: boolean } = {},
): Promise<void> {
  const ledger = new FsLedger(root);
  const base = {
    schemaVersion: 1 as const,
    runId: "run-cli",
    controllerEpoch: 0,
  };
  const events: RunEvent[] = [
    {
      ...base,
      eventId: "run-cli#1",
      sequence: 1,
      type: "run_started",
      at: 100,
      actor: "runtime",
      data: {
        workflow: "cross-review",
        workspace: "w1",
        cwd: "/tmp/cli-run",
        splitDirection: "down",
        tabId: "w1:t1",
        controllerPaneId: "w1:p1",
        fixedPoint: {
          repoRoot: "/repo",
          baseCommit: "base123",
          headCommit: "head456",
          diffHash: "sha256:diff",
          dirtyStatePolicy: "reject",
          capturedAt: 99,
        },
      },
    },
    {
      ...base,
      eventId: "run-cli#2",
      laneId: "lane-1",
      sequence: 2,
      type: "lane_registered",
      at: 110,
      actor: "runtime",
      data: {
        laneId: "lane-1",
        paneId: "w1:p2",
        logFile: "/tmp/cli-run/lane.log",
        stderrFile: "/tmp/cli-run/lane.stderr.log",
        sentinelToken: "FLOW_run-cli_LANE_lane-1_EXIT",
        steps: 1,
        stepDelaySeconds: 0,
      },
    },
    {
      ...base,
      eventId: "run-cli#3",
      laneId: "lane-1",
      sequence: 3,
      type: "lane_dispatched",
      at: 120,
      actor: "runtime",
      data: { command: "actual command" },
    },
    {
      ...base,
      eventId: "run-cli#4",
      laneId: "lane-1",
      sequence: 4,
      type: "lane_live",
      at: 130,
      actor: "runtime",
      data: {},
    },
    {
      ...base,
      eventId: "run-cli#5",
      laneId: "lane-1",
      sequence: 5,
      type: "lane_exited",
      at: 140,
      actor: "runtime",
      data: { exitCode: 0, waitMatched: true },
    },
    {
      ...base,
      eventId: "run-cli#6",
      laneId: "lane-1",
      sequence: 6,
      type: "lane_checkpoint",
      at: 150,
      actor: "agent",
      data: { semanticState: "complete", checkpointFile: "/tmp/cli-run/checkpoint.md" },
    },
    {
      ...base,
      eventId: "run-cli#7",
      laneId: "lane-1",
      sequence: 7,
      type: "lane_contract_evaluated",
      at: 160,
      actor: "validator",
      data: {
        contractState: "satisfied",
        resultFile: "/tmp/cli-run/result.txt",
        errors: [],
      },
    },
    {
      ...base,
      eventId: "run-cli#8",
      laneId: "lane-1",
      sequence: 8,
      type: "lane_verification_recorded",
      at: 170,
      actor: "runner",
      data: { verificationState: "verified", evidenceFile: "/tmp/cli-run/evidence.json" },
    },
    {
      ...base,
      eventId: "run-cli#9",
      sequence: 9,
      type: "run_finished",
      at: 180,
      actor: "runtime",
      data: {
        status: "clean",
        breakdown: {
          exitedZero: 1,
          exitedNonZero: 0,
          crashed: 0,
          lost: 0,
          failedToStart: 0,
        },
      },
    },
  ];
  for (const event of events) {
    if (options.finished === false && event.type === "run_finished") continue;
    await ledger.commit(event);
  }
}

async function flow(root: string, ...args: string[]) {
  const child = Bun.spawn(["bun", "run", "flow", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FLOW_LEDGER_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

class AmbiguousCommitLedger extends FsLedger {
  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    throw new Error("injected append failure");
  }

  protected override async rollbackAppend(): Promise<void> {
    throw new Error("injected rollback failure");
  }
}

function ambiguousRunStarted(): RunEvent {
  return {
    schemaVersion: 1,
    eventId: "run-poisoned#1",
    runId: "run-poisoned",
    sequence: 1,
    type: "run_started",
    at: 100,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      workflow: "cross-review",
      workspace: "w1",
      cwd: "/tmp/poisoned",
      splitDirection: "down",
      tabId: "w1:t1",
      controllerPaneId: "w1:p1",
      fixedPoint: null,
    },
  };
}

describe("flow CLI external behavior", () => {
  test("status lists a run from the durable ledger", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);

    const result = await flow(root, "status");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("run-cli");
    expect(result.stdout).toContain("workflow=cross-review");
    expect(result.stdout).toContain("state=complete");
    expect(result.stdout).toContain("finishStatus=clean");
    expect(result.stdout).toContain("lanes=1");
    expect(result.stdout).toContain("updatedAt=180");
  });

  test("inspect keeps four dimensions side by side with fixed point and artifacts", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root);

    const result = await flow(root, "inspect", "run-cli");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('fixedPoint={"repoRoot":"/repo"');
    expect(result.stdout).toContain(
      "runtimeState=exited semanticState=complete contractState=satisfied verificationState=verified",
    );
    expect(result.stdout).toContain("controlMode=managed exitCode=0");
    expect(result.stdout).toContain("dispatchedAt=120 liveAt=130 completedAt=140");
    expect(result.stdout).toContain("stdout=/tmp/cli-run/lane.log");
    expect(result.stdout).toContain("stderr=/tmp/cli-run/lane.stderr.log");
    expect(result.stdout).toContain("checkpoint=/tmp/cli-run/checkpoint.md");
    expect(result.stdout).toContain("result=/tmp/cli-run/result.txt");
    expect(result.stdout).toContain("evidence=/tmp/cli-run/evidence.json");
  });

  test("status and inspect render an all-terminal unfinished replay as incomplete", async () => {
    const root = await tempRoot();
    await seedFinishedRun(root, { finished: false });

    const status = await flow(root, "status");
    const inspect = await flow(root, "inspect", "run-cli");

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("state=incomplete");
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain("state=incomplete");
  });

  test("usage errors are non-zero", async () => {
    const root = await tempRoot();
    expect((await flow(root, "inspect")).exitCode).not.toBe(0);
    expect((await flow(root, "unknown")).exitCode).not.toBe(0);
  });

  test("an unusable ledger root fails loudly without an in-memory fallback", async () => {
    const root = await tempRoot();
    const unusable = join(root, "not-a-directory");
    await writeFile(unusable, "file", "utf8");

    const result = await flow(unusable, "status");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("a nonexistent ledger root fails loudly for status and inspect", async () => {
    const parent = await tempRoot();
    const missing = join(parent, "missing-ledger");

    for (const args of [["status"], ["inspect", "run-missing"]]) {
      const result = await flow(missing, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ledger root");
    }
  });

  test("an existing ledger root with an empty runs directory lists normally", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "runs"));

    const result = await flow(root, "status");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("flow:");
  });

  test("status and inspect fail closed for an ambiguous run", async () => {
    const root = await tempRoot();
    await expect(
      new AmbiguousCommitLedger(root).commit(ambiguousRunStarted()),
    ).rejects.toThrow(/append failure.*rollback failure/);

    const status = await flow(root, "status");
    const inspect = await flow(root, "inspect", "run-poisoned");

    expect(status.exitCode).not.toBe(0);
    expect(status.stderr).toContain('run "run-poisoned" has an ambiguous commit');
    expect(status.stdout).toBe("");
    expect(inspect.exitCode).not.toBe(0);
    expect(inspect.stderr).toContain('run "run-poisoned" has an ambiguous commit');
    expect(inspect.stdout).toBe("");
  });
});
