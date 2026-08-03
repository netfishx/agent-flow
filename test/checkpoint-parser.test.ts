import { describe, expect, test } from "bun:test";
import { parseCheckpoint } from "../src/index.ts";

describe("parseCheckpoint", () => {
  test.each(["complete", "partial", "blocked"] as const)(
    "accepts the %s status and extracts reported sections",
    (status) => {
      expect(
        parseCheckpoint(`STATUS: ${status}
PHASE: reporting
COMPLETED:
- implementation
NEXT:
- ask the owner
BLOCKERS:
- owner decision
ARTIFACTS:
- results/lane-1.txt
VERIFICATION_CLAIMS:
- bun test
GAPS:
- terminal gaps
`),
      ).toEqual({
        status,
        blockers: ["owner decision"],
        next: ["ask the owner"],
        gaps: ["terminal gaps"],
        artifacts: ["results/lane-1.txt"],
        verificationClaims: ["bun test"],
      });
    },
  );

  test("treats an only `none` item and a missing section as empty", () => {
    expect(
      parseCheckpoint(`STATUS: blocked
BLOCKERS:
- none
ARTIFACTS:
- result.txt
VERIFICATION_CLAIMS:
- none
`),
    ).toEqual({
      status: "blocked",
      blockers: [],
      next: [],
      gaps: [],
      artifacts: ["result.txt"],
      verificationClaims: [],
    });
  });

  test("requires the documented uppercase STATUS header without changing none normalization", () => {
    expect(
      parseCheckpoint("Status: Complete\nBLOCKERS:\n- None\n"),
    ).toMatchObject({
      status: null,
      blockers: [],
    });
  });

  test.each([
    "",
    "STATUS: working\nBLOCKERS:\n- waiting\n",
    "STATUS complete\nBLOCKERS:\n- waiting\n",
    "not a checkpoint",
  ])("returns a null status for malformed input without throwing", (text) => {
    expect(parseCheckpoint(text).status).toBeNull();
  });
});

describe("runtime-derived terminal records", () => {
  // The runtime writes `STATUS: unknown` for a crashed or lost lane, because no
  // evidence of progress survived. A record our own parser cannot classify is
  // not a durable record, so the parser must read what the runtime writes.
  test("parses the unknown status the runtime derives", () => {
    const record = `STATUS: unknown
PHASE: runtime-derived-terminal-record
COMPLETED:
- the lane process is gone
NEXT:
- none
BLOCKERS:
- no completion sentinel was found in the lane's durable log
ARTIFACTS:
- reports/codex-spec.raw (not produced)
VERIFICATION_CLAIMS:
- none
GAPS:
- none
`;
    const parsed = parseCheckpoint(record);
    expect(parsed.status).toBe("unknown");
    expect(parsed.blockers).toEqual([
      "no completion sentinel was found in the lane's durable log",
    ]);
    expect(parsed.verificationClaims).toEqual([]);
  });
});
