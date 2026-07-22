import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import { reduce } from "../src/runtime/reducer.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-ledger-"));
  roots.push(root);
  return root;
}

function started(runId = "run-fs"): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `${runId}#1`,
    runId,
    sequence: 1,
    type: "run_started",
    at: 10,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      workflow: "cross-review",
      workspace: "w1",
      cwd: "/tmp/work",
      splitDirection: "down",
      tabId: "w1:t1",
      controllerPaneId: "w1:p1",
      fixedPoint: null,
    },
  };
}

function registered(sequence = 2): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `run-fs#${sequence}`,
    runId: "run-fs",
    laneId: "lane-1",
    sequence,
    type: "lane_registered",
    at: 20,
    actor: "runtime",
    controllerEpoch: 0,
    data: {
      laneId: "lane-1",
      paneId: "w1:p2",
      logFile: "/tmp/work/lane.log",
      sentinelToken: "FLOW_run-fs_LANE_lane-1_EXIT",
      steps: 1,
      stepDelaySeconds: 0,
    },
  };
}

async function seedEventFile(root: string, lines: readonly string[]): Promise<void> {
  const runDir = join(root, "runs", "run-fs");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "events.jsonl"), lines.join(""), "utf8");
}

class DoubleAppendFailureLedger extends FsLedger {
  protected override async appendAndSync(
    handle: FileHandle,
    contents: string,
  ): Promise<void> {
    await handle.writeFile(contents, "utf8");
    throw new Error("injected append fsync failure");
  }

  protected override async rollbackAppend(
    _handle: FileHandle,
    _originalSize: number,
  ): Promise<void> {
    throw new Error("injected truncate rollback failure");
  }
}

class SnapshotWriteFailureLedger extends FsLedger {
  protected override async writeSnapshotFile(
    path: string,
    _contents: string,
  ): Promise<void> {
    await writeFile(path, "partial snapshot", "utf8");
    throw new Error("injected snapshot write failure");
  }
}

describe("FsLedger public capabilities", () => {
  test("append, load, and list round-trip through the shared reducer", async () => {
    const ledger = new FsLedger(await tempRoot());
    const event = started();

    await ledger.commit(event);

    expect(await ledger.load(event.runId)).toEqual(reduce(undefined, event));
    expect(await ledger.list()).toEqual([{ runId: event.runId }]);
  });

  test("silently deduplicates an identical event and rejects an id conflict", async () => {
    const ledger = new FsLedger(await tempRoot());
    const event = started();
    await ledger.commit(event);

    await expect(ledger.commit(structuredClone(event))).resolves.toBeUndefined();
    expect((await ledger.load(event.runId))!.lastAppliedSequence).toBe(1);

    await expect(
      ledger.commit({ ...event, at: event.at + 1 }),
    ).rejects.toThrow(/different payload/);
    expect((await ledger.load(event.runId))!.updatedAt).toBe(event.at);
  });

  test("fails closed when replay encounters a sequence gap", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      `${JSON.stringify(registered(3))}\n`,
    ]);

    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(/sequence 3/);
  });

  test("fails closed on mid-file corruption and event id conflicts", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      "{not-json}\n",
      `${JSON.stringify(registered())}\n`,
    ]);
    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(
      /corrupt event stream.*line 2/,
    );

    await seedEventFile(root, [
      `${JSON.stringify(started())}\n`,
      `${JSON.stringify({ ...started(), at: 99 })}\n`,
    ]);
    await expect(new FsLedger(root).load("run-fs")).rejects.toThrow(
      /conflicting payloads/,
    );
  });

  test("ignores exactly one trailing partial JSON line", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [`${JSON.stringify(started())}\n`, '{"schemaVersion":']);

    expect((await new FsLedger(root).load("run-fs"))!.lastAppliedSequence).toBe(1);
  });

  test("the next commit truncates a tolerated trailing partial line", async () => {
    const root = await tempRoot();
    await seedEventFile(root, [`${JSON.stringify(started())}\n`, '{"schemaVersion":']);
    const ledger = new FsLedger(root);
    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(1);

    await ledger.commit(registered());

    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(2);
  });

  test("replay ignores a missing or torn materialized snapshot", async () => {
    const root = await tempRoot();
    const ledger = new FsLedger(root);
    await ledger.commit(started());
    const snapshot = join(root, "runs", "run-fs", "run.json");

    await writeFile(snapshot, "{torn", "utf8");
    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(1);
    await unlink(snapshot);
    expect((await ledger.load("run-fs"))!.lastAppliedSequence).toBe(1);
  });

  test("refuses a lease while held and permits reacquire after release", async () => {
    const ledger = new FsLedger(await tempRoot());
    const first = await ledger.acquireLease("run-fs", {
      controllerId: "controller-1",
      pid: 101,
    });

    await expect(
      ledger.acquireLease("run-fs", { controllerId: "controller-2", pid: 202 }),
    ).rejects.toThrow(/already held/);
    await first.release();
    const second = await ledger.acquireLease("run-fs", {
      controllerId: "controller-2",
      pid: 202,
    });
    await expect(second.release()).resolves.toBeUndefined();
  });

  test("poisons the run when append failure rollback also fails", async () => {
    const root = await tempRoot();
    const ledger = new DoubleAppendFailureLedger(root);

    await expect(ledger.commit(started())).rejects.toThrow(
      /append fsync failure.*truncate rollback failure/,
    );
    expect((await new FsLedger(root).load("run-fs"))!.lastAppliedSequence).toBe(1);

    await expect(ledger.commit(registered())).rejects.toThrow(
      /run "run-fs" is poisoned/,
    );
  });

  test("removes a partially written snapshot temp when its write fails", async () => {
    const root = await tempRoot();
    const ledger = new SnapshotWriteFailureLedger(root);

    await expect(ledger.commit(started())).rejects.toThrow(
      /snapshot write failure/,
    );

    const runDir = join(root, "runs", "run-fs");
    expect((await readdir(runDir)).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
    expect(await ledger.load("run-fs")).toBeNull();
  });
});
