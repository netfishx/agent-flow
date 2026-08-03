// The immutable input bundle: the review materials captured exactly once at
// run start. Assembly is pure — callers supply file contents; this module
// produces line-numbered artifacts, per-file content hashes, and the bundle
// hash that all six briefs must record.

import { createHash } from "node:crypto";
import { canonicalJson } from "../issue/hash.ts";
import type {
  BundleFileRecord,
  BundleFileRole,
  InputBundleManifest,
} from "./types.ts";

export interface BundleSourceFile {
  /** Logical artifact path, e.g. "bundle/issue-7.md". */
  readonly path: string;
  readonly role: BundleFileRole;
  readonly content: string;
}

export interface BundleArtifact {
  readonly path: string;
  readonly role: BundleFileRole;
  /** The content with 1-based line numbers, citable as path:line. */
  readonly numberedText: string;
  readonly content: string;
}

export interface AssembledInputBundle {
  readonly manifest: InputBundleManifest;
  readonly artifacts: readonly BundleArtifact[];
}

const BUNDLE_PATH = /^bundle\/[A-Za-z0-9._/-]+$/;

/** Bundle paths are joined under the run directory; no segment may escape it. */
function assertSafeBundlePath(path: string): void {
  if (!BUNDLE_PATH.test(path)) {
    throw new Error(
      `bundle path "${path}" must match bundle/<name> with safe characters`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`bundle path "${path}" contains an unsafe segment`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function numbered(content: string): { text: string; lines: number } {
  // The numbering mirrors the original byte-for-byte per line: a trailing
  // newline yields no extra numbered row.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const rows = body.split("\n");
  return {
    text: `${rows.map((row, index) => `${index + 1}\t${row}`).join("\n")}\n`,
    lines: rows.length,
  };
}

export function assembleInputBundle(
  files: readonly BundleSourceFile[],
): AssembledInputBundle {
  if (files.length === 0) {
    throw new Error("an input bundle requires at least one file");
  }
  const seen = new Set<string>();
  for (const file of files) {
    assertSafeBundlePath(file.path);
    if (seen.has(file.path)) {
      throw new Error(`duplicate bundle path "${file.path}"`);
    }
    seen.add(file.path);
  }

  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const artifacts: BundleArtifact[] = [];
  const records: BundleFileRecord[] = [];
  for (const file of ordered) {
    const { text, lines } = numbered(file.content);
    artifacts.push({
      path: file.path,
      role: file.role,
      numberedText: text,
      content: file.content,
    });
    records.push({
      path: file.path,
      role: file.role,
      sha256: sha256(file.content),
      lines,
    });
  }
  return {
    manifest: {
      files: records,
      bundleHash: sha256(canonicalJson(records)),
    },
    artifacts,
  };
}
