import { describe, expect, test } from "bun:test";
import { validateReportContract } from "../src/index.ts";

const VALID = `Some narrative the reviewer wrote first.

VERDICT: approve
CONFIDENCE: high
FINDINGS: none
`;

describe("validateReportContract", () => {
  test("accepts a minimal approving report with no findings", () => {
    expect(validateReportContract(VALID)).toEqual({
      verdict: "approve",
      confidence: "high",
      findings: [],
      errors: [],
    });
  });

  test("accepts findings rows against source and bundle paths", () => {
    const report = `VERDICT: changes_required
CONFIDENCE: medium
FINDINGS:
- [P1] src/runtime/runtime.ts:42 dispatch loses the recorded exit code
- [P3] bundle/issue-7.md:12 the AC wording is ambiguous about panes
`;
    expect(validateReportContract(report)).toEqual({
      verdict: "changes_required",
      confidence: "medium",
      findings: [
        {
          severity: "P1",
          path: "src/runtime/runtime.ts",
          line: 42,
          text: "dispatch loses the recorded exit code",
        },
        {
          severity: "P3",
          path: "bundle/issue-7.md",
          line: 12,
          text: "the AC wording is ambiguous about panes",
        },
      ],
      errors: [],
    });
  });

  test("allows trailing narrative to end the findings section", () => {
    const report = `VERDICT: approve
CONFIDENCE: low
FINDINGS:
- [P3] a.ts:1 minor nit

That closing paragraph is not a finding row.
`;
    const outcome = validateReportContract(report);
    expect(outcome.errors).toEqual([]);
    expect(outcome.findings).toHaveLength(1);
  });

  test.each([
    ["missing VERDICT", VALID.replace("VERDICT: approve\n", ""), "VERDICT header is missing"],
    ["missing CONFIDENCE", VALID.replace("CONFIDENCE: high\n", ""), "CONFIDENCE header is missing"],
    ["missing FINDINGS", VALID.replace("FINDINGS: none\n", ""), "FINDINGS header is missing"],
  ])("reports a %s header", (_name, report, message) => {
    expect(validateReportContract(report).errors).toContain(message);
  });

  test("reports duplicated headers", () => {
    const report = `VERDICT: approve
VERDICT: approve
CONFIDENCE: high
CONFIDENCE: low
FINDINGS: none
FINDINGS: none
`;
    expect(validateReportContract(report).errors).toEqual([
      "VERDICT header appears 2 times; exactly one is required",
      "CONFIDENCE header appears 2 times; exactly one is required",
      "FINDINGS header appears 2 times; exactly one is required",
    ]);
  });

  test("does not count inline mentions as headers", () => {
    const report = `The brief said VERDICT: approve is one legal value.
VERDICT: approve
CONFIDENCE: high
FINDINGS: none
`;
    expect(validateReportContract(report).errors).toEqual([]);
  });

  test.each([
    ["VERDICT", "VERDICT: maybe", 'VERDICT value "maybe" is not approve | changes_required'],
    ["CONFIDENCE", "CONFIDENCE: certain", 'CONFIDENCE value "certain" is not high | medium | low'],
  ])("rejects an illegal %s enum value", (_field, line, message) => {
    const report = `${VALID}\n`.replace(
      _field === "VERDICT" ? "VERDICT: approve" : "CONFIDENCE: high",
      line,
    );
    expect(validateReportContract(report).errors).toContain(message);
  });

  test("rejects an inline FINDINGS value other than none", () => {
    const report = VALID.replace("FINDINGS: none", "FINDINGS: nothing");
    expect(validateReportContract(report).errors).toContain(
      'FINDINGS inline value "nothing" is not none',
    );
  });

  test("rejects an empty FINDINGS section", () => {
    const report = `VERDICT: approve
CONFIDENCE: high
FINDINGS:
`;
    expect(validateReportContract(report).errors).toContain(
      "FINDINGS section has no rows; use FINDINGS: none when there are none",
    );
  });

  test.each([
    ["missing severity", "- src/a.ts:1 problem"],
    ["illegal severity", "- [P4] src/a.ts:1 problem"],
    ["missing line number", "- [P1] src/a.ts problem"],
    ["missing description", "- [P1] src/a.ts:1 "],
    ["spaces in path", "- [P1] src/a b.ts:1 problem"],
  ])("rejects a finding row with %s", (_name, row) => {
    const report = `VERDICT: changes_required
CONFIDENCE: high
FINDINGS:
${row}
`;
    const outcome = validateReportContract(report);
    expect(outcome.errors).toEqual([
      `finding row is malformed: "${row}"`,
    ]);
  });

  test("a fully empty report accumulates all three missing headers", () => {
    expect(validateReportContract("").errors).toEqual([
      "VERDICT header is missing",
      "CONFIDENCE header is missing",
      "FINDINGS header is missing",
    ]);
  });

  test("a truncated grok-style report keeps its parseable prefix and errors", () => {
    const report = `Long narrative...
VERDICT: changes_required
CONFIDENCE: hi`;
    const outcome = validateReportContract(report);
    expect(outcome.verdict).toBe("changes_required");
    expect(outcome.errors).toEqual([
      'CONFIDENCE value "hi" is not high | medium | low',
      "FINDINGS header is missing",
    ]);
  });
});
