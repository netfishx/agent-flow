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
- **Label transition** — the recorded outcome of the allowed issue-label step:
  not applicable, applied, skipped, or failed.
- **Marker** — the invisible HTML comment containing a delivery id at the start
  of a synchronized issue comment, used for exact remote deduplication.
