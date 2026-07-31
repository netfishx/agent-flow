// A run's raw reports, derived results, checkpoints, briefs, bundle, logs, and
// runner evidence are the artifacts its ledger points at. A machine restart
// cleared `/private/tmp` and destroyed a formal run's entire artifact set while
// its ledger survived, so every pointer in that ledger aimed at nothing. These
// tests hold the default to the ledger's own state root, keep runs from
// overwriting each other, and prove a formal run refuses a volatile root.
//
// The environment is injected, never read from the process, so no test writes
// to or depends on a real user directory.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  resolveEvidenceRoot,
  runEvidencePath,
  volatileEvidenceRootRefusal,
} from "../src/smoke/evidence-root.ts";
import { resolveLedgerRoot } from "../src/runtime/fs-ledger.ts";

const XDG = "/opt/test-state";

describe("resolveEvidenceRoot", () => {
  test("defaults under the same state root the ledger resolves", () => {
    const environment = { XDG_STATE_HOME: XDG };
    expect(resolveEvidenceRoot(environment)).toBe(
      join(resolveLedgerRoot(environment), "evidence"),
    );
    expect(resolveEvidenceRoot(environment)).toBe(
      "/opt/test-state/agent-flow/evidence",
    );
  });

  test("follows an explicit ledger root, so evidence and ledger stay together", () => {
    const environment = { FLOW_LEDGER_ROOT: "/opt/ledgers/agent-flow" };
    expect(resolveEvidenceRoot(environment)).toBe(
      "/opt/ledgers/agent-flow/evidence",
    );
  });

  test("honors an explicit FLOW_EVIDENCE_DIR override", () => {
    expect(
      resolveEvidenceRoot({
        XDG_STATE_HOME: XDG,
        FLOW_EVIDENCE_DIR: "/opt/elsewhere",
      }),
    ).toBe("/opt/elsewhere");
    // An empty value is not an override.
    expect(
      resolveEvidenceRoot({ XDG_STATE_HOME: XDG, FLOW_EVIDENCE_DIR: "" }),
    ).toBe("/opt/test-state/agent-flow/evidence");
  });

  // The regression that cost a formal run its artifacts: no code path may reach
  // a temporary directory when nothing was configured.
  test("never falls back to a temporary directory", () => {
    const withoutConfiguration = resolveEvidenceRoot({
      HOME: "/opt/home",
      XDG_STATE_HOME: XDG,
    });
    expect(withoutConfiguration.startsWith(tmpdir())).toBeFalse();
    expect(volatileEvidenceRootRefusal(withoutConfiguration)).toBeNull();
    // And with a bare environment, it still lands in a state directory.
    const bare = resolveEvidenceRoot({});
    expect(bare.startsWith(tmpdir())).toBeFalse();
    expect(bare.endsWith(join(".local", "state", "agent-flow", "evidence")))
      .toBeTrue();
    expect(volatileEvidenceRootRefusal(bare)).toBeNull();
  });

  test("isolates one run's evidence from another's", () => {
    const root = resolveEvidenceRoot({ XDG_STATE_HOME: XDG });
    expect(runEvidencePath(root, "review-a", "formal-result.json")).toBe(
      "/opt/test-state/agent-flow/evidence/review-a/formal-result.json",
    );
    expect(runEvidencePath(root, "review-b", "formal-result.json")).not.toBe(
      runEvidencePath(root, "review-a", "formal-result.json"),
    );
    // The run directory itself, which the runtime nests its artifacts under.
    expect(runEvidencePath(root, "review-a")).toBe(
      "/opt/test-state/agent-flow/evidence/review-a",
    );
  });
});

describe("volatileEvidenceRootRefusal", () => {
  test.each([
    "/tmp",
    "/tmp/agent-flow-review-formal-3",
    "/private/tmp/agent-flow-review-formal-3",
    "/var/tmp/agent-flow",
    "/private/var/tmp/agent-flow",
    "/dev/shm/agent-flow",
  ])("refuses %s", (path) => {
    const refusal = volatileEvidenceRootRefusal(path, "/var/folders/xx/T");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("volatile directory");
  });

  test("refuses the injected per-user temporary directory", () => {
    const refusal = volatileEvidenceRootRefusal(
      "/var/folders/qw/abc/T/agent-flow",
      "/var/folders/qw/abc/T",
    );
    expect(refusal).toContain("volatile directory");
    // The real one on this machine is refused too.
    expect(volatileEvidenceRootRefusal(join(tmpdir(), "agent-flow"))).toContain(
      "volatile directory",
    );
  });

  test("refuses a relative path, which proves nothing about persistence", () => {
    expect(volatileEvidenceRootRefusal("evidence")).toContain(
      "not an absolute path",
    );
  });

  test("accepts a state directory", () => {
    expect(
      volatileEvidenceRootRefusal(
        "/Users/someone/.local/state/agent-flow/evidence",
        "/var/folders/xx/T",
      ),
    ).toBeNull();
    // A path that merely contains the substring is not under it.
    expect(
      volatileEvidenceRootRefusal("/opt/not-tmp/evidence", "/var/folders/xx/T"),
    ).toBeNull();
    expect(
      volatileEvidenceRootRefusal("/tmpfoo/evidence", "/var/folders/xx/T"),
    ).toBeNull();
  });
});
