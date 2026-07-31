// Deterministic brief assembly: a pure function over the captured input
// bundle. The runtime — never the caller — owns brief construction, so six
// lanes provably draw from one immutable material set. Agent differences are
// template branches; the report contract block is appended verbatim to all.

import type { AssembledInputBundle, BundleArtifact } from "./bundle.ts";
import { REPORT_CONTRACT_BLOCK } from "./contract.ts";
import type { ReviewAgentKind, ReviewAxis } from "./types.ts";

export interface BriefInput {
  readonly axis: ReviewAxis;
  readonly agentKind: ReviewAgentKind;
  readonly fixedPoint: {
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly diffHash: string;
  };
  readonly bundle: AssembledInputBundle;
  /** Absolute run artifact root; bundle artifacts live at <root>/<path>. */
  readonly artifactRoot: string;
}

function artifactLocation(root: string, artifact: BundleArtifact): string {
  return `${root}/${artifact.path}`;
}

function listArtifacts(
  root: string,
  artifacts: readonly BundleArtifact[],
): string {
  return artifacts
    .map(
      (artifact) =>
        `- ${artifactLocation(root, artifact)} (cite as ${artifact.path}:<line>)`,
    )
    .join("\n");
}

function embedArtifacts(artifacts: readonly BundleArtifact[]): string {
  return artifacts
    .map(
      (artifact) =>
        `### ${artifact.path} (cite as ${artifact.path}:<line>)\n\n` +
        `\`\`\`\n${artifact.numberedText}\`\`\``,
    )
    .join("\n\n");
}

const AGENT_NOTES: Readonly<Record<ReviewAgentKind, string>> = {
  claude:
    "Your tool surface is read-only: Read, Glob, Grep, and Bash restricted to " +
    "git diff, git log, git show, and git status. Do not attempt writes; " +
    "denied tools mean the action is out of contract, not that you should " +
    "retry it another way.",
  codex:
    "You run in a read-only sandbox. Inspect the change with git and the " +
    "worktree files; do not attempt writes.",
  grok:
    "Web search is disabled; everything you need is in the worktree and the " +
    "captured artifacts listed above. Do not attempt writes.",
};

const AXIS_CHARTER: Readonly<Record<ReviewAxis, string>> = {
  standards:
    "Review the change ONLY against the captured standards materials and the " +
    "repository conventions they document. Does the change follow this " +
    "repository's documented standards? Cite violated standards with source " +
    "path:line loci in the worktree, or bundle path:line for the standard " +
    "itself when the violation is structural.",
  spec:
    "Review the change ONLY against the captured issue and specification " +
    "materials. Does the change do what the issue and spec ask — no more, no " +
    "less? Cite source path:line loci for implementation mismatches, or " +
    "bundle path:line when the finding is about the specification text " +
    "itself.",
};

/**
 * Assemble one lane's brief. Pure and deterministic: identical input produces
 * a byte-identical brief, which the golden tests lock per (axis x agent).
 */
export function assembleBrief(input: BriefInput): string {
  const { axis, agentKind, fixedPoint, bundle, artifactRoot } = input;
  const materials = bundle.artifacts.filter((artifact) =>
    axis === "standards"
      ? artifact.role === "standards"
      : artifact.role === "issue" || artifact.role === "spec",
  );
  if (materials.length === 0) {
    throw new Error(`the input bundle has no materials for the ${axis} axis`);
  }

  const materialsSection =
    agentKind === "codex" && axis === "spec"
      ? `The captured issue and specification materials are embedded below ` +
        `verbatim (line-numbered; your sandbox has no network access):\n\n` +
        `${embedArtifacts(materials)}`
      : `Captured ${axis === "standards" ? "standards" : "issue and specification"} ` +
        `materials (line-numbered files on disk):\n\n` +
        `${listArtifacts(artifactRoot, materials)}`;

  return `# Cross-review lane brief — ${agentKind} / ${axis}

You are one of six independent reviewers. Work alone: do not look for, read,
or reference any other reviewer's output. Your working directory is a
detached review worktree checked out at the head commit under review. It is
disposable and read-only for you: never modify, create, or delete any file.

## Fixed point

- Base commit: ${fixedPoint.baseCommit}
- Head commit: ${fixedPoint.headCommit}
- Diff hash (sha256 of \`git diff base..head\`): ${fixedPoint.diffHash}
- Input bundle hash: ${bundle.manifest.bundleHash}

Inspect the change under review with read-only git, for example:

    git log --oneline ${fixedPoint.baseCommit}..${fixedPoint.headCommit}
    git diff ${fixedPoint.baseCommit}..${fixedPoint.headCommit}

## Review charter — ${axis} axis

${AXIS_CHARTER[axis]}

## Materials

${materialsSection}

## Ground rules

${AGENT_NOTES[agentKind]}

${REPORT_CONTRACT_BLOCK}
`;
}
