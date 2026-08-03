// What this file has to prove, and cannot prove by inspection: that a Pi
// command and the direct shell entry are one path rather than two that happen
// to agree today. Every equivalence assertion below therefore drives the real
// registered handler against a real on-disk ledger and compares it with
// `runFlowCli` over identical state, rather than testing the mapping table on
// its own.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFlowCli } from "../src/cli/flow.ts";
import { FakeHerdrAdapter } from "../src/herdr/fake-adapter.ts";
import { FsLedger } from "../src/runtime/fs-ledger.ts";
import type { RunEvent } from "../src/runtime/events.ts";
import type { Ledger } from "../src/runtime/ledger.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
import {
  FLOW_COMMANDS,
  flowArgvFor,
  notificationFor,
  registerFlowCommands,
  runFlowCommand,
  splitArguments,
  type FlowCommandSpec,
  type PiCommandContext,
  type PiCommandOptions,
  type PiExtensionApi,
  type PiNotifyLevel,
} from "../src/pi/adapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-flow-pi-"));
  roots.push(root);
  return root;
}

/**
 * A single-lane run whose lane has reached a terminal state but whose run has
 * not finished: enough for status, inspect, takeover, and release without the
 * fake Herdr adapter needing to own a pane it never created.
 */
async function seedLiveRun(root: string): Promise<void> {
  const ledger = new FsLedger(root);
  const base = { schemaVersion: 1 as const, runId: "run-pi", controllerEpoch: 0 };
  const events: RunEvent[] = [
    {
      ...base,
      eventId: "run-pi#1",
      sequence: 1,
      type: "run_started",
      at: 100,
      actor: "runtime",
      data: {
        workflow: "cross-review",
        workspace: "w1",
        cwd: "/tmp/pi-run",
        splitDirection: "down",
        tabId: "w1:t1",
        controllerPaneId: "w1:p1",
        fixedPoint: null,
        issue: null,
      },
    },
    {
      ...base,
      eventId: "run-pi#2",
      laneId: "lane-1",
      sequence: 2,
      type: "lane_registered",
      at: 110,
      actor: "runtime",
      data: {
        laneId: "lane-1",
        paneId: "w1:p2",
        logFile: "/tmp/pi-run/lane.log",
        stderrFile: "/tmp/pi-run/lane.stderr.log",
        sentinelToken: "FLOW_run-pi_LANE_lane-1_EXIT",
        steps: 1,
        stepDelaySeconds: 0,
      },
    },
    {
      ...base,
      eventId: "run-pi#3",
      laneId: "lane-1",
      sequence: 3,
      type: "lane_dispatch_intent",
      at: 115,
      actor: "runtime",
      data: {},
    },
    {
      ...base,
      eventId: "run-pi#4",
      laneId: "lane-1",
      sequence: 4,
      type: "lane_dispatched",
      at: 120,
      actor: "runtime",
      data: { command: "sleep 1" },
    },
    {
      ...base,
      eventId: "run-pi#5",
      laneId: "lane-1",
      sequence: 5,
      type: "lane_live",
      at: 130,
      actor: "runtime",
      data: {},
    },
    {
      ...base,
      eventId: "run-pi#6",
      laneId: "lane-1",
      sequence: 6,
      type: "lane_exited",
      at: 140,
      actor: "runtime",
      data: { exitCode: 0, waitMatched: true },
    },
  ];
  for (const event of events) await ledger.commit(event);
}

function runtimeFactory(runtimeLedger: Ledger): WorkflowRuntime {
  return new WorkflowRuntime({
    adapter: new FakeHerdrAdapter({ lanes: [] }),
    ledger: runtimeLedger,
    clock: () => 1_000,
    idgen: () => "unused",
    readResultFile: async () => "",
    sleep: async () => {},
  });
}

class Sink {
  text = "";
  write(chunk: string): void {
    this.text += chunk;
  }
}

interface Notification {
  readonly message: string;
  readonly level: PiNotifyLevel | undefined;
}

/**
 * A Pi host that refuses everything the adapter is not allowed to touch. A
 * plain object with spies would let a future handler reach for a model API
 * and still pass; the proxy makes "the adapter only registers commands, and a
 * handler only notifies" a property of the test rather than of the reviewer's
 * attention.
 */
function strictHost(allowed: readonly string[], sink: (name: string) => unknown) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol") return undefined;
        if (property === "then") return undefined;
        if (!allowed.includes(property)) {
          throw new Error(`adapter touched forbidden host member "${property}"`);
        }
        return sink(property);
      },
    },
  );
}

function collectCommands(): {
  readonly pi: PiExtensionApi;
  readonly registered: Map<string, PiCommandOptions>;
} {
  const registered = new Map<string, PiCommandOptions>();
  const pi = strictHost(["registerCommand"], () => {
    return (name: string, options: PiCommandOptions) => {
      registered.set(name, options);
    };
  }) as PiExtensionApi;
  return { pi, registered };
}

function strictContext(notifications: Notification[]): PiCommandContext {
  const ui = strictHost(["notify"], () => {
    return (message: string, level?: PiNotifyLevel) => {
      notifications.push({ message, level });
    };
  });
  return strictHost(["ui"], () => ui) as PiCommandContext;
}

async function invoke(
  root: string,
  name: string,
  args: string,
): Promise<Notification[]> {
  const { pi, registered } = collectCommands();
  registerFlowCommands(pi, {
    environment: { FLOW_LEDGER_ROOT: root },
    runtimeFactory,
  });
  const command = registered.get(name);
  if (!command) throw new Error(`command "${name}" was not registered`);
  const notifications: Notification[] = [];
  await command.handler(args, strictContext(notifications));
  return notifications;
}

async function shellEntry(
  root: string,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const exitCode = await runFlowCli(argv, stdout, stderr, {
    environment: { FLOW_LEDGER_ROOT: root },
    runtimeFactory,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

async function eventStream(root: string): Promise<unknown[]> {
  const raw = await readFile(
    join(root, "runs", "run-pi", "events.jsonl"),
    "utf8",
  );
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // `at` is the only field two runs of the same command may legitimately
      // differ on, so it is the only field normalised away.
      const { at: _at, ...rest } = JSON.parse(line) as Record<string, unknown>;
      return rest;
    });
}

describe("the Pi adapter publishes the shell entry's own commands", () => {
  test("every command maps to a flow subcommand, and adds none", () => {
    expect(FLOW_COMMANDS.map((spec) => spec.subcommand)).toEqual([
      "status",
      "inspect",
      "resume",
      "takeover",
      "release",
      "decide",
    ]);
  });

  test("no command starts a run: that spends real model budget behind the smoke gate", () => {
    for (const spec of FLOW_COMMANDS) {
      expect(spec.subcommand).not.toBe("start");
      expect(spec.name.startsWith("flow-")).toBe(true);
    }
  });

  test("registration touches only registerCommand", () => {
    const { pi, registered } = collectCommands();
    // The strict host throws on any other member, so reaching this line at all
    // is the assertion; the count guards against a silent partial registration.
    registerFlowCommands(pi);
    expect(registered.size).toBe(FLOW_COMMANDS.length);
  });

  test("argv matches what the shell entry would receive", () => {
    const spec = (name: string): FlowCommandSpec =>
      FLOW_COMMANDS.find((candidate) => candidate.name === name)!;
    expect(flowArgvFor(spec("flow-status"), "")).toEqual(["status"]);
    expect(flowArgvFor(spec("flow-inspect"), "run-pi")).toEqual([
      "inspect",
      "run-pi",
    ]);
    expect(flowArgvFor(spec("flow-takeover"), "run-pi lane-1")).toEqual([
      "takeover",
      "run-pi",
      "lane-1",
    ]);
    expect(
      flowArgvFor(
        spec("flow-decide"),
        'run-pi --decision accepted --note "two words"',
      ),
    ).toEqual([
      "decide",
      "run-pi",
      "--decision",
      "accepted",
      "--note",
      "two words",
    ]);
  });
});

describe("argument splitting keeps free text intact", () => {
  test("a quoted note survives as one argument", () => {
    expect(splitArguments('--note "ship it"')).toEqual(["--note", "ship it"]);
    expect(splitArguments("--note 'ship it'")).toEqual(["--note", "ship it"]);
  });

  test("empty and whitespace-only input produce no arguments", () => {
    expect(splitArguments("")).toEqual([]);
    expect(splitArguments("   \t ")).toEqual([]);
  });

  test("an empty quoted argument is preserved, not dropped", () => {
    // `--note ""` must reach the CLI so it can reject it, rather than becoming
    // a missing flag that changes which error the operator sees.
    expect(splitArguments('--note ""')).toEqual(["--note", ""]);
  });
});

describe("both entries are one path", () => {
  test("a read-only command produces byte-identical output", async () => {
    const root = await tempRoot();
    await seedLiveRun(root);

    const shell = await shellEntry(root, ["inspect", "run-pi"]);
    const adapter = await runFlowCommand(["inspect", "run-pi"], {
      environment: { FLOW_LEDGER_ROOT: root },
      runtimeFactory,
    });

    expect(adapter.exitCode).toBe(shell.exitCode);
    expect(adapter.stdout).toBe(shell.stdout);
    expect(adapter.stderr).toBe(shell.stderr);
    expect(shell.stdout.length).toBeGreaterThan(0);
  });

  test("a state-changing command leaves an identical ledger", async () => {
    const viaShell = await tempRoot();
    const viaPi = await tempRoot();
    await seedLiveRun(viaShell);
    await seedLiveRun(viaPi);
    expect(await eventStream(viaShell)).toEqual(await eventStream(viaPi));

    const shell = await shellEntry(viaShell, ["takeover", "run-pi", "lane-1"]);
    const notifications = await invoke(viaPi, "flow-takeover", "run-pi lane-1");

    expect(shell.exitCode).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("info");
    expect(await eventStream(viaPi)).toEqual(await eventStream(viaShell));
  });

  test("the handler notifies the runtime's own bytes, whole", async () => {
    const root = await tempRoot();
    await seedLiveRun(root);
    const shell = await shellEntry(root, ["inspect", "run-pi"]);

    const notifications = await invoke(root, "flow-inspect", "run-pi");

    expect(notifications).toHaveLength(1);
    // Trimmed, never summarised: every line the shell entry printed is present.
    expect(notifications[0]!.message).toBe(shell.stdout.trim());
    for (const line of shell.stdout.trim().split("\n")) {
      expect(notifications[0]!.message).toContain(line);
    }
  });

  test("a handler touches only ui.notify", async () => {
    const root = await tempRoot();
    await seedLiveRun(root);
    // The strict context throws on any member other than `ui.notify`, so a
    // handler that reached for a session or a model API would fail here.
    const notifications = await invoke(root, "flow-status", "");
    expect(notifications).toHaveLength(1);
  });

  test("a read-only command through the adapter commits nothing", async () => {
    // `status` is the one subcommand that only reads. `inspect` legitimately
    // reconciles a run whose lanes are already terminal, and the ledger it
    // leaves is compared against the shell entry's above — so what this asserts
    // is that the adapter contributes no event of its own on top.
    const root = await tempRoot();
    await seedLiveRun(root);
    const before = await eventStream(root);

    await invoke(root, "flow-status", "");
    await invoke(root, "flow-status", "");

    expect(await eventStream(root)).toEqual(before);
  });
});

describe("failures stay visible", () => {
  test("a non-zero exit surfaces stderr as an error", async () => {
    const root = await tempRoot();
    await seedLiveRun(root);

    const notifications = await invoke(root, "flow-inspect", "no-such-run");

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("error");
    expect(notifications[0]!.message).toContain("no-such-run");
  });

  test("a usage error reports the usage line rather than an empty panel", async () => {
    const root = await tempRoot();
    await seedLiveRun(root);

    const notifications = await invoke(root, "flow-inspect", "");

    expect(notifications[0]!.level).toBe("error");
    expect(notifications[0]!.message).toContain("usage: flow");
  });

  test("a silent success still says something", () => {
    const spec = FLOW_COMMANDS[0]!;
    expect(
      notificationFor(spec, { exitCode: 0, stdout: "", stderr: "" }),
    ).toEqual({ message: "flow-status: no runs in the ledger", level: "info" });
  });

  test("a failure with no output still names the exit code", () => {
    const spec = FLOW_COMMANDS[0]!;
    expect(
      notificationFor(spec, { exitCode: 2, stdout: "", stderr: "" }),
    ).toEqual({ message: "flow-status failed with exit 2", level: "error" });
  });
});
