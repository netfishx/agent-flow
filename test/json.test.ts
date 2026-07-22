import { describe, expect, test } from "bun:test";
import {
  HerdrParseError,
  parseCreatedTab,
  parseHerdrError,
  parseProcessInfo,
  parseSplitPane,
} from "../src/herdr/json.ts";
import { classifyWaitOutput } from "../src/herdr/real-adapter.ts";

const CREATE_TAB = JSON.stringify({
  id: "cli:tab:create",
  result: {
    root_pane: { pane_id: "w2:pK", tab_id: "w2:t5" },
    tab: { tab_id: "w2:t5", label: "flow" },
    type: "tab_created",
  },
});

const SPLIT = JSON.stringify({
  id: "cli:pane:split",
  result: { pane: { pane_id: "w2:pM", tab_id: "w2:t5" }, type: "pane_info" },
});

const PROCESS_INFO = JSON.stringify({
  id: "cli:pane:process_info",
  result: {
    process_info: {
      foreground_process_group_id: 81604,
      foreground_processes: [
        { name: "bash", pid: 81604 },
        { argv0: "sleep", pid: 81620 },
      ],
      pane_id: "w2:pD",
      shell_pid: 80940,
    },
    type: "pane_process_info",
  },
});

describe("parseCreatedTab", () => {
  test("extracts tab id and controller pane id", () => {
    expect(parseCreatedTab(CREATE_TAB)).toEqual({
      tab: { id: "w2:t5" },
      controllerPane: { id: "w2:pK" },
    });
  });
  test("rejects a missing shape", () => {
    expect(() => parseCreatedTab("{}")).toThrow(HerdrParseError);
    expect(() => parseCreatedTab("not json")).toThrow(HerdrParseError);
  });
});

describe("parseSplitPane", () => {
  test("extracts the new pane id", () => {
    expect(parseSplitPane(SPLIT)).toEqual({ id: "w2:pM" });
  });
  test("rejects a missing shape", () => {
    expect(() => parseSplitPane('{"result":{}}')).toThrow(HerdrParseError);
  });
});

describe("parseProcessInfo", () => {
  test("extracts shell pid, foreground group, and pids", () => {
    const info = parseProcessInfo(PROCESS_INFO);
    expect(info.paneId).toBe("w2:pD");
    expect(info.shellPid).toBe(80940);
    expect(info.foregroundProcessGroupId).toBe(81604);
    expect(info.foregroundPids).toEqual([81604, 81620]);
    expect(info.foregroundNames).toEqual(["bash", "sleep"]);
  });
  test("fails loudly on malformed JSON", () => {
    expect(() => parseProcessInfo("not json")).toThrow(HerdrParseError);
    expect(() => parseProcessInfo('{"result":{"process_info":{}}}')).toThrow(
      HerdrParseError,
    );
  });
});

describe("parseHerdrError", () => {
  test("extracts a Herdr error envelope", () => {
    const err = parseHerdrError(
      '{"error":{"code":"timeout","message":"timed out"},"id":"cli:pane:wait-output"}',
    );
    expect(err).toEqual({ code: "timeout", message: "timed out" });
  });
  test("returns null for non-error output", () => {
    expect(parseHerdrError("")).toBeNull();
    expect(parseHerdrError("not json")).toBeNull();
    expect(parseHerdrError('{"result":{"type":"ok"}}')).toBeNull();
  });
});

describe("classifyWaitOutput", () => {
  test("exit 0 is a match", () => {
    expect(classifyWaitOutput(0, "")).toEqual({ matched: true, timedOut: false });
  });
  test("a herdr timeout is a clean non-match, not an error", () => {
    const stderr =
      '{"error":{"code":"timeout","message":"timed out waiting for output match"}}';
    expect(classifyWaitOutput(1, stderr)).toEqual({
      matched: false,
      timedOut: true,
    });
  });
  test("a non-timeout herdr error is raised, not folded into matched:false", () => {
    const stderr = '{"error":{"code":"pane_not_found","message":"pane w9:pZ not found"}}';
    expect(() => classifyWaitOutput(1, stderr)).toThrow(/pane_not_found/);
  });
  test("a bare CLI/environment failure (empty stderr) is raised", () => {
    // e.g. the binary itself failing (`/usr/bin/false`): exit 1, no envelope.
    expect(() => classifyWaitOutput(1, "")).toThrow(
      /wait-output failed/,
    );
  });
});
