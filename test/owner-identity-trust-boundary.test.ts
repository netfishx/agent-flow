import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("the runtime source has no GitHub comment-author identity path", async () => {
  const sources: string[] = [];
  const glob = new Bun.Glob("src/**/*.ts");
  for await (const path of glob.scan({
    cwd: join(import.meta.dir, ".."),
    onlyFiles: true,
  })) {
    sources.push(await readFile(join(import.meta.dir, "..", path), "utf8"));
  }
  expect(sources.length).toBeGreaterThan(20);
  const trackerPort = await readFile(
    join(import.meta.dir, "..", "src", "issue", "tracker.ts"),
    "utf8",
  );
  const interfaceBody = trackerPort.match(
    /export interface IssueTracker \{([\s\S]*?)\n\}/,
  )?.[1];
  const portMethods = [
    ...(interfaceBody ?? "").matchAll(/^\s{2}([A-Za-z]\w*)\(/gm),
  ].map((match) => match[1]);

  expect(portMethods).toEqual([
    "resolveIssue",
    "findCommentByMarker",
    "createComment",
    "readCurrentLabels",
    "compareAndSetTriageLabel",
  ]);
  expect(sources.join("\n")).not.toMatch(
    /\b(?:comment\.(?:author|user)|commentAuthor|commentUser|user\.login|authorAssociation|authorLogin)\b/i,
  );
});
