# Domain Vocabulary

This repository has one domain: observable multi-agent workflow execution.
These terms are stable and should be used consistently in code, tests, issues,
and design records.

- **Run** — one execution of a named workflow against a fixed point.
- **Lane** — one isolated Agent process within a run, hosted visibly and
  independently controllable.
- **Ledger** — the append-only event record from which durable run state is
  reconstructed.
- **Delivery** — the durable record of synchronizing one due run milestone to
  its bound issue. It may span several attempts, which `intents` counts.
- **Delivery id** — the deterministic identity of a milestone delivery, derived
  from the run id, anchor sequence, milestone kind, and lane id when applicable.
- **Payload hash** — the SHA-256 digest of a milestone payload's canonical JSON;
  it detects content drift for an existing delivery id.
- **Public-surface redaction** — removal of local paths, credentials, pane
  identifiers, and other private values only while rendering public issue text;
  payload identity retains the true source values.
- **Milestone kind** — one of the fixed public lifecycle signals: `start`,
  `blocked`, `complete`, or `decision`.
- **Anchor sequence** — the ledger sequence of the event that gives a milestone
  its stable delivery identity.
- **Blocked anchor** — a lane's write-once snapshot of its first blocked
  checkpoint, used to keep the blocked delivery stable.
- **Checkpoint collection** — reading an executing lane's checkpoint at a
  reconciliation boundary and recording a changed blocked fact before delivery
  planning.
- **Checkpoint origin** — who authored a lane's checkpoint: the Agent itself,
  or the runtime deriving one from the lane's captured bytes. The two are
  recorded distinctly and never rendered as the same claim.
- **Terminal record** — the runtime-derived checkpoint every lane that ran
  receives when it reaches a terminal state, whatever that state was. It states
  its mechanical origin, claims no verification, and invents no verdict.
- **Checkpoint semantic signature** — the comparison key over semantic state
  and blocker, next, and gap lines, used to suppress unchanged checkpoint facts.
- **Label transition** — the recorded outcome of the allowed issue-label step:
  not applicable, applied, skipped, or failed.
- **Marker** — the invisible HTML comment containing a delivery id at the start
  of a synchronized issue comment, used for exact remote deduplication.
- **Reconciliation pass** — one lease-held sweep over a run's due milestones.
  Passes for a single run never overlap, so two of them cannot both miss a
  marker and both create a comment.
- **Backfill** — confirming a delivery from a marker the issue already carries,
  because the remote write landed but its confirmation did not.
- **Delivery outcome** — what one reconciliation pass did with one delivery:
  posted, backfilled, or failed.
- **Planning failure** — a reconciliation pass that could not compute the due
  list at all. It is contained rather than thrown, and it produces no delivery
  record, so no delivery state carries it.
- **Synchronization state** — the shared operator projection of a run's issue
  delivery health: `none` when unbound, `ok` when settled, `pending` when work
  is due or in flight, and `degraded` when a delivery or planning failure needs
  attention.
- **`will-retry`** — the operator disposition for a retryable delivery failure;
  a later reconciliation pass will attempt the delivery again.
- **`needs-operator`** — the operator disposition for a non-retryable delivery
  failure; automated reconciliation will not attempt it again.
- **Agent lane** — a lane that runs a real reviewer CLI headlessly in its own
  review worktree; a **simulated lane** runs the scripted stand-in.
- **Review axis** — the reviewer charter dimension of an agent lane:
  `standards` or `spec`.
- **Input bundle** — the immutable review materials captured once at run
  start, persisted as line-numbered artifacts with per-file content hashes.
- **Bundle hash** — the SHA-256 over the input bundle's canonical manifest;
  all briefs of one run must record the same value.
- **Review worktree** — a detached, disposable git worktree pinned at the
  captured head commit; the reviewer's working directory, never the
  implementation worktree.
- **Isolation verification** — the pre-flight/post-flight check of a review
  worktree (HEAD, clean state, diff hash). A verification that cannot run
  proves nothing and fails closed.
- **Raw report** — a lane's CLI output captured byte-for-byte; the
  first-class artifact from which the report text, checkpoint, and contract
  outcome are derived without rewriting.
- **Raw report outcome** — the runner's objective fact about that artifact:
  `captured`, `missing`, or `underivable`. Only `captured` licenses releasing
  the lane's review worktree.
- **Worktree disposition** — whether a lane's review worktree was released or
  retained, and the reason it was kept. Retention is recorded, never silent.
- **Report contract** — the required `VERDICT` / `CONFIDENCE` / `FINDINGS`
  form of a reviewer's report; validated for form only, never for truth.
- **Session identity** — a lane's CLI session id, recorded only from evidence
  causally tied to that lane (pre-assigned id or the lane's own output):
  measured, or unavailable with a reason.
- **`invalid`** — the run finish status when an agent lane that ran to a
  terminal state lacks a passing post-flight verification; an invalid run is
  never carried forward, and a rerun gets a new run id.
