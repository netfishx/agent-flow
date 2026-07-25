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

  test.each([
    "",
    "STATUS: working\nBLOCKERS:\n- waiting\n",
    "STATUS complete\nBLOCKERS:\n- waiting\n",
    "not a checkpoint",
  ])("returns a null status for malformed input without throwing", (text) => {
    expect(parseCheckpoint(text).status).toBeNull();
  });
});
