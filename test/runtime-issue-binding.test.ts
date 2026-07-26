import { describe, expect, test } from "bun:test";
import {
  FakeHerdrAdapter,
  createClock,
} from "../src/herdr/fake-adapter.ts";
import type {
  CreatedTab,
  CreateTabOptions,
  PaneRef,
  SplitPaneOptions,
} from "../src/herdr/types.ts";
import { InMemoryLedger } from "../src/runtime/ledger.ts";
import { WorkflowRuntime } from "../src/runtime/runtime.ts";
import { FakeIssueTracker } from "../src/testing.ts";
import type { IssueRef } from "../src/index.ts";

class CountingFakeHerdrAdapter extends FakeHerdrAdapter {
  createdTabs = 0;
  createdPanes = 0;

  override async createTab(options: CreateTabOptions): Promise<CreatedTab> {
    this.createdTabs++;
    return super.createTab(options);
  }

  override async splitPane(options: SplitPaneOptions): Promise<PaneRef> {
    this.createdPanes++;
    return super.splitPane(options);
  }
}

function setup(issueTracker?: FakeIssueTracker) {
  const clock = createClock(1_000);
  const adapter = new CountingFakeHerdrAdapter({
    clock,
    lanes: [{ laneId: "lane-1", exitCode: 0 }],
  });
  const ledger = new InMemoryLedger();
  const runtime = new WorkflowRuntime({
    adapter,
    ledger,
    clock: clock.now,
    idgen: () => "run-issue-binding",
    readResultFile: adapter.readResultFile,
    sleep: async () => {},
    ...(issueTracker === undefined ? {} : { issueTracker }),
  });
  return { adapter, ledger, runtime };
}

function config(issue?: IssueRef | null) {
  return {
    workflow: "cross-review",
    workspace: "agent-flow",
    cwd: "/tmp/run-issue-binding",
    lanes: [{ laneId: "lane-1", steps: 1 }],
    ...(issue === undefined ? {} : { issue }),
  };
}

describe("runtime issue binding", () => {
  const invalidBindings: readonly [string, IssueRef][] = [
    ["empty owner", { owner: "", repo: "agent-flow", number: 24 }],
    ["empty repository", { owner: "netfishx", repo: "", number: 24 }],
    ["whitespace owner", { owner: "   ", repo: "agent-flow", number: 24 }],
    ["whitespace repository", { owner: "netfishx", repo: "\t", number: 24 }],
    [
      "invalid owner characters",
      { owner: "net_fish", repo: "agent-flow", number: 24 },
    ],
    [
      "invalid repository characters",
      { owner: "netfishx", repo: "agent/flow", number: 24 },
    ],
    ["zero number", { owner: "netfishx", repo: "agent-flow", number: 0 }],
    ["negative number", { owner: "netfishx", repo: "agent-flow", number: -1 }],
    ["non-integer number", { owner: "netfishx", repo: "agent-flow", number: 1.5 }],
    [
      "unsafe number",
      {
        owner: "netfishx",
        repo: "agent-flow",
        number: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
  ];

  for (const [name, issue] of invalidBindings) {
    test(`rejects ${name} before creating Herdr state`, async () => {
      const { adapter, runtime } = setup();

      await expect(runtime.startWorkflow(config(issue))).rejects.toThrow(
        /invalid issue binding/,
      );
      expect(adapter.createdTabs).toBe(0);
      expect(adapter.createdPanes).toBe(0);
    });
  }

  test("persists a valid binding verbatim and defaults an omitted binding to null", async () => {
    const bound = setup(new FakeIssueTracker());
    const issue = { owner: "netfishx", repo: "agent-flow.ts", number: 24 } as const;
    const boundHandle = await bound.runtime.startWorkflow(config(issue));

    expect((await bound.ledger.load(boundHandle.runId))!.issue).toEqual(issue);

    const unbound = setup();
    const unboundHandle = await unbound.runtime.startWorkflow(config());
    expect((await unbound.ledger.load(unboundHandle.runId))!.issue).toBeNull();
  });
});
