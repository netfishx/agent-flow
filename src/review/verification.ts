// The two isolation-verification predicates, in one leaf module so that every
// consumer shares them: the reducer's finish rule, the runtime's pre-flight
// gate, the cleanup gate, the git implementation, and the CLI renderer. A
// second inline copy of "all three booleans are true" is a defect, not a
// shortcut — that is the shape a fail-open hides in.

import type { WorktreeVerification } from "./types.ts";

/** The one shared pass predicate for any isolation-verification shape. */
export function verificationPassed(verification: {
  readonly headOk: boolean;
  readonly cleanOk: boolean;
  readonly diffHashOk: boolean;
}): boolean {
  return (
    verification.headOk && verification.cleanOk && verification.diffHashOk
  );
}

/** A verification that proves nothing — the fail-closed outcome. */
export function failedVerification(detail: string): WorktreeVerification {
  return { headOk: false, cleanOk: false, diffHashOk: false, detail };
}
