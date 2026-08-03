// Stable domain types of the review seam. These are the vocabulary CONTEXT.md
// fixes, so they live in a leaf module: the ledger's event schema and the
// reducer depend on the vocabulary, never on the brief assembler or the command
// builders that happen to use it too.

/** The reviewer charter dimension of an agent lane. */
export type ReviewAxis = "standards" | "spec";

/** The CLI family behind an agent lane. */
export type ReviewAgentKind = "claude" | "codex" | "grok";

/**
 * A lane's CLI session id, recorded only from evidence causally tied to that
 * lane: a pre-assigned id, or the lane's own captured output. Never guessed.
 */
export type SessionIdentity =
  | {
      readonly kind: "measured";
      readonly id: string;
      /** What ties this id to this specific lane process. */
      readonly evidence: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type BundleFileRole = "issue" | "spec" | "standards";

export interface BundleFileRecord {
  readonly path: string;
  readonly role: BundleFileRole;
  /** SHA-256 hex of the ORIGINAL (un-numbered) content. */
  readonly sha256: string;
  readonly lines: number;
}

export interface InputBundleManifest {
  readonly files: readonly BundleFileRecord[];
  /** SHA-256 hex over the canonical JSON of `files`, sorted by path. */
  readonly bundleHash: string;
}

export interface WorktreeVerification {
  readonly headOk: boolean;
  readonly cleanOk: boolean;
  readonly diffHashOk: boolean;
  /** Failure context; null when every check passed. */
  readonly detail: string | null;
}

export interface CaptureFixedPointInput {
  readonly repoRoot: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly dirtyStatePolicy: "reject" | "record-hash";
}
