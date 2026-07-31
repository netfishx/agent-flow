// Where a smoke's durable evidence lives. A run's raw reports, derived
// results, checkpoints, briefs, bundle, logs, and runner evidence are the
// artifacts its ledger points at, so they must share the ledger's lifetime.
// A machine restart cleared `/private/tmp` once and destroyed a formal run's
// entire artifact set while its ledger survived, leaving every pointer in that
// ledger aimed at nothing. The default therefore resolves through the same
// state-root rules as the ledger, and a formal run refuses to write its
// acceptance evidence into a directory the operating system may clear.

import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { resolveLedgerRoot } from "../runtime/fs-ledger.ts";

/**
 * Directories an operating system may clear without warning. `os.tmpdir()` is
 * added by the caller's default so a per-user temporary directory — macOS puts
 * one under `/var/folders` — is covered without hard-coding its shape.
 */
const VOLATILE_ROOTS: readonly string[] = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/dev/shm",
];

function withoutTrailingSeparator(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 && normalized.endsWith(sep)
    ? normalized.slice(0, -1)
    : normalized;
}

function isUnder(candidate: string, root: string): boolean {
  const target = withoutTrailingSeparator(candidate);
  const prefix = withoutTrailingSeparator(root);
  return target === prefix || target.startsWith(`${prefix}${sep}`);
}

/**
 * The persistent root every smoke's run-scoped evidence lives under. It is NOT
 * run-scoped itself: the runtime already nests each run's artifacts under
 * `<root>/<runId>`, so scoping the root as well would repeat the run id in
 * every recorded artifact pointer. Smoke-level files get `runEvidencePath`.
 */
export function resolveEvidenceRoot(environment = process.env): string {
  const configured = environment.FLOW_EVIDENCE_DIR;
  if (configured !== undefined && configured.length > 0) return configured;
  return join(resolveLedgerRoot(environment), "evidence");
}

/**
 * A path for one run's own smoke-level file, scoped by run id so a later run
 * cannot overwrite an earlier run's acceptance record.
 */
export function runEvidencePath(
  evidenceRoot: string,
  runId: string,
  ...segments: string[]
): string {
  return join(evidenceRoot, runId, ...segments);
}

/**
 * Why this evidence root may not hold a formal run's acceptance evidence, or
 * null when it may. Pure over the two inputs so the rule is unit-testable:
 * `tmpRoot` is injected rather than read from the process, and no filesystem
 * call is made.
 */
export function volatileEvidenceRootRefusal(
  evidenceRoot: string,
  tmpRoot: string = tmpdir(),
): string | null {
  if (!isAbsolute(evidenceRoot)) {
    return `evidence root "${evidenceRoot}" is not an absolute path`;
  }
  for (const root of [...VOLATILE_ROOTS, tmpRoot]) {
    if (isUnder(evidenceRoot, root)) {
      return `evidence root "${evidenceRoot}" is under the volatile directory "${withoutTrailingSeparator(root)}"; a formal run's raw reports must outlive a restart`;
    }
  }
  return null;
}
