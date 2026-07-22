// The single place where Herdr JSON responses are parsed into the structured
// types above. The runtime never sees raw Herdr JSON; every response passes
// through one of these functions, which fail loudly on an unexpected shape.

import type { CreatedTab, PaneRef, ProcessInfo } from "./types.ts";

export class HerdrParseError extends Error {
  constructor(
    readonly command: string,
    readonly raw: string,
  ) {
    super(`failed to parse herdr ${command} response: ${truncate(raw)}`);
    this.name = "HerdrParseError";
  }
}

function truncate(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function parseJson(command: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HerdrParseError(command, raw);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse `herdr tab create` → tab id + initial (controller) pane id. */
export function parseCreatedTab(raw: string): CreatedTab {
  const root = parseJson("tab create", raw);
  const result = isRecord(root) ? root.result : undefined;
  const tab = isRecord(result) ? result.tab : undefined;
  const rootPane = isRecord(result) ? result.root_pane : undefined;
  const tabId = isRecord(tab) ? tab.tab_id : undefined;
  const paneId = isRecord(rootPane) ? rootPane.pane_id : undefined;
  if (typeof tabId !== "string" || typeof paneId !== "string") {
    throw new HerdrParseError("tab create", raw);
  }
  return { tab: { id: tabId }, controllerPane: { id: paneId } };
}

/** Parse `herdr pane split` → the new pane id. */
export function parseSplitPane(raw: string): PaneRef {
  const root = parseJson("pane split", raw);
  const result = isRecord(root) ? root.result : undefined;
  const pane = isRecord(result) ? result.pane : undefined;
  const paneId = isRecord(pane) ? pane.pane_id : undefined;
  if (typeof paneId !== "string") {
    throw new HerdrParseError("pane split", raw);
  }
  return { id: paneId };
}

/** Parse `herdr pane process-info` → structured process facts. */
export function parseProcessInfo(raw: string): ProcessInfo {
  const root = parseJson("pane process-info", raw);
  const result = isRecord(root) ? root.result : undefined;
  const info = isRecord(result) ? result.process_info : undefined;
  if (!isRecord(info)) {
    throw new HerdrParseError("pane process-info", raw);
  }
  const paneId = info.pane_id;
  const shellPid = info.shell_pid;
  const pgid = info.foreground_process_group_id;
  const foreground = info.foreground_processes;
  if (
    typeof paneId !== "string" ||
    typeof shellPid !== "number" ||
    typeof pgid !== "number" ||
    !Array.isArray(foreground)
  ) {
    throw new HerdrParseError("pane process-info", raw);
  }
  const foregroundPids: number[] = [];
  const foregroundNames: string[] = [];
  for (const proc of foreground) {
    if (!isRecord(proc)) continue;
    if (typeof proc.pid === "number") foregroundPids.push(proc.pid);
    if (typeof proc.name === "string") foregroundNames.push(proc.name);
    else if (typeof proc.argv0 === "string") foregroundNames.push(proc.argv0);
  }
  return {
    paneId,
    shellPid,
    foregroundProcessGroupId: pgid,
    foregroundPids,
    foregroundNames,
  };
}
