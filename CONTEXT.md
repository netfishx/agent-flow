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
- **Checkpoint collection** — reading an executing lane's Agent-written
  checkpoint at a reconciliation boundary and recording a changed blocked fact
  before delivery planning.
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
