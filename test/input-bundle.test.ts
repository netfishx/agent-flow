import { describe, expect, test } from "bun:test";
import { assembleInputBundle } from "../src/index.ts";

const FILES = [
  {
    path: "bundle/standards/agents.md",
    role: "standards" as const,
    content: "# Rules\nBe boring.\n",
  },
  {
    path: "bundle/issue-7.md",
    role: "issue" as const,
    content: "Run six lanes.\nAll visible.\n",
  },
];

describe("assembleInputBundle", () => {
  test("produces line-numbered artifacts and per-file hashes sorted by path", () => {
    const bundle = assembleInputBundle(FILES);
    expect(bundle.manifest.files.map((file) => file.path)).toEqual([
      "bundle/issue-7.md",
      "bundle/standards/agents.md",
    ]);
    expect(bundle.manifest.files[0]).toMatchObject({
      role: "issue",
      lines: 2,
    });
    expect(bundle.manifest.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.artifacts[0]!.numberedText).toBe(
      "1\tRun six lanes.\n2\tAll visible.\n",
    );
  });

  test("is deterministic: identical input produces an identical bundle hash", () => {
    const first = assembleInputBundle(FILES);
    const second = assembleInputBundle([...FILES].reverse());
    expect(first.manifest.bundleHash).toBe(second.manifest.bundleHash);
    expect(first.manifest.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("any content change changes the bundle hash", () => {
    const changed = assembleInputBundle([
      FILES[0]!,
      { ...FILES[1]!, content: `${FILES[1]!.content}tail\n` },
    ]);
    expect(changed.manifest.bundleHash).not.toBe(
      assembleInputBundle(FILES).manifest.bundleHash,
    );
  });

  test("rejects unsafe or duplicated bundle paths and empty bundles", () => {
    expect(() => assembleInputBundle([])).toThrow("at least one file");
    expect(() =>
      assembleInputBundle([
        { path: "issue.md", role: "issue", content: "x" },
      ]),
    ).toThrow('bundle path "issue.md"');
    expect(() =>
      assembleInputBundle([FILES[0]!, { ...FILES[0]! }]),
    ).toThrow('duplicate bundle path');
  });

  test.each(["bundle/../escape.md", "bundle/a/../../b.md", "bundle//x.md", "bundle/./x.md"])(
    "a traversal-shaped path %s never escapes the run directory",
    (path) => {
      expect(() =>
        assembleInputBundle([{ path, role: "issue", content: "x" }]),
      ).toThrow("unsafe segment");
    },
  );

  test("a file without a trailing newline still numbers every line", () => {
    const bundle = assembleInputBundle([
      { path: "bundle/a.md", role: "spec", content: "one\ntwo" },
    ]);
    expect(bundle.artifacts[0]!.numberedText).toBe("1\tone\n2\ttwo\n");
    expect(bundle.manifest.files[0]!.lines).toBe(2);
  });
});
