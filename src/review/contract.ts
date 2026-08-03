// The review report contract validator. It locks form, not truth: the three
// headers exist exactly once, enum values are legal, and each finding row
// carries a severity and a path:line locus. It never judges whether a finding
// is correct, and it never rewrites the reviewer's text.

export type ReviewVerdict = "approve" | "changes_required";
export type ReviewConfidence = "high" | "medium" | "low";
export type FindingSeverity = "P0" | "P1" | "P2" | "P3";

export interface ReportFinding {
  readonly severity: FindingSeverity;
  /** A source path in the review worktree or a bundle artifact path. */
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface ReportContractOutcome {
  readonly verdict: ReviewVerdict | null;
  readonly confidence: ReviewConfidence | null;
  readonly findings: readonly ReportFinding[];
  /** Empty means the contract is satisfied. */
  readonly errors: readonly string[];
}

/**
 * The contract block appended verbatim to every brief. This is the single
 * textual home of the contract; the validator below locks exactly this form.
 */
export const REPORT_CONTRACT_BLOCK = `## Required report contract

End your report with exactly one contract block in this exact form:

VERDICT: approve | changes_required
CONFIDENCE: high | medium | low
FINDINGS:
- [P0|P1|P2|P3] <path>:<line> <one-line finding>

Rules:
- Choose exactly one value for VERDICT and exactly one for CONFIDENCE.
- When you have no findings, write the single line \`FINDINGS: none\` instead
  of an empty section.
- Every finding row must carry a severity and a <path>:<line> locus. The path
  may be a source path inside your working directory or a captured bundle
  artifact path (bundle/...).
- Observations without a path:line locus belong in your narrative, not in
  FINDINGS.
- Do not start any other line in your report with VERDICT:, CONFIDENCE:, or
  FINDINGS: — each header must appear exactly once.
- \`changes_required\` if and only if you found at least one P0-P2 you consider
  mandatory to fix; P3-only judgement calls mean \`approve\`.`;

const VERDICTS: ReadonlySet<string> = new Set(["approve", "changes_required"]);
const CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const FINDING_ROW = /^- \[(P0|P1|P2|P3)\] (\S+):(\d+) (\S.*)$/;

interface HeaderScan {
  readonly count: number;
  readonly value: string;
  readonly lineIndex: number;
}

function scanHeader(lines: readonly string[], header: string): HeaderScan {
  let count = 0;
  let value = "";
  let lineIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith(`${header}:`)) continue;
    count += 1;
    if (count === 1) {
      value = line.slice(header.length + 1).trim();
      lineIndex = index;
    }
  }
  return { count, value, lineIndex };
}

function headerErrors(
  header: string,
  scan: HeaderScan,
  errors: string[],
): boolean {
  if (scan.count === 0) {
    errors.push(`${header} header is missing`);
    return false;
  }
  if (scan.count > 1) {
    errors.push(
      `${header} header appears ${scan.count} times; exactly one is required`,
    );
    return false;
  }
  return true;
}

/**
 * Validate a reviewer's final report text against the cross-review report
 * contract. Narrative before (and after) the header block is allowed; headers
 * only count when they start a line.
 */
export function validateReportContract(text: string): ReportContractOutcome {
  const lines = text.split(/\r?\n/);
  const errors: string[] = [];

  const verdictScan = scanHeader(lines, "VERDICT");
  let verdict: ReviewVerdict | null = null;
  if (headerErrors("VERDICT", verdictScan, errors)) {
    if (VERDICTS.has(verdictScan.value)) {
      verdict = verdictScan.value as ReviewVerdict;
    } else {
      errors.push(
        `VERDICT value "${verdictScan.value}" is not approve | changes_required`,
      );
    }
  }

  const confidenceScan = scanHeader(lines, "CONFIDENCE");
  let confidence: ReviewConfidence | null = null;
  if (headerErrors("CONFIDENCE", confidenceScan, errors)) {
    if (CONFIDENCES.has(confidenceScan.value)) {
      confidence = confidenceScan.value as ReviewConfidence;
    } else {
      errors.push(
        `CONFIDENCE value "${confidenceScan.value}" is not high | medium | low`,
      );
    }
  }

  const findingsScan = scanHeader(lines, "FINDINGS");
  const findings: ReportFinding[] = [];
  if (headerErrors("FINDINGS", findingsScan, errors)) {
    if (findingsScan.value.length > 0) {
      if (findingsScan.value !== "none") {
        errors.push(`FINDINGS inline value "${findingsScan.value}" is not none`);
      }
    } else {
      // Rows are the consecutive `- ` lines after the header; the first
      // non-row, non-blank line ends the section (trailing narrative allowed).
      let sawRow = false;
      for (
        let index = findingsScan.lineIndex + 1;
        index < lines.length;
        index++
      ) {
        const line = lines[index]!;
        if (line.trim().length === 0) {
          if (sawRow) break;
          continue;
        }
        if (!line.startsWith("- ")) break;
        sawRow = true;
        const row = line.match(FINDING_ROW);
        if (!row) {
          errors.push(`finding row is malformed: "${line}"`);
          continue;
        }
        findings.push({
          severity: row[1] as FindingSeverity,
          path: row[2]!,
          line: Number.parseInt(row[3]!, 10),
          text: row[4]!,
        });
      }
      if (!sawRow) {
        errors.push(
          "FINDINGS section has no rows; use FINDINGS: none when there are none",
        );
      }
    }
  }

  return { verdict, confidence, findings, errors };
}
