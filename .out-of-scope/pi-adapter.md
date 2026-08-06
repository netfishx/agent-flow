# Pi command adapter — deferred beyond v1

## Status

Deferred. Not part of Agent Flow v1. Not rejected.

Pi is a capable tool and remains a possible future option. Nothing here is a
judgement about its quality.

## What was deferred

A deterministic Pi command adapter that would expose the runtime's existing
`flow` surface as Pi slash commands, and the roadmap phase that evaluated
whether Pi should become a command adapter, an Agent adapter, both, or neither.

## Why it was removed from v1

Pi-specific product and roadmap language entered the design as an assistant
proposal. The owner had evaluated and installed Pi, but never selected it as a
v1 Agent Flow requirement. The roadmap therefore carried a planned adoption
decision that no owner decision had ever authorized.

The v1 execution toolchain is Claude Code, Codex, and Grok Build, hosted as
visible native processes under Herdr. The runtime entry point is
technology-neutral and depends on no Agent-host product, so nothing in v1 needs
this adapter to work.

## Record

- [#9 — Prototype a deterministic Pi command adapter](https://github.com/netfishx/agent-flow/issues/9): closed `wontfix`. Closed because the work it specified is outside the corrected v1 scope, not because it failed or was found unworkable.
- [PR #51 — Prototype a deterministic Pi command adapter (#9)](https://github.com/netfishx/agent-flow/pull/51): closed without merge. Its code is not reused. A future reconsideration starts from the runtime as it stands then, not from that branch.
- [#52 — Defer the Pi adapter beyond v1](https://github.com/netfishx/agent-flow/issues/52): the provenance and scope correction that produced this record.

## What reconsideration would require

Both of the following, in order:

1. **Evidence.** A measured problem that the direct entry point does not solve,
   captured the way the design requires evidence to be captured: what the
   current entry costs, what an adapter would change, and the added startup,
   context, and recovery cost of routing through an Agent host. Convenience is
   not evidence.
2. **An owner decision.** An explicit, recorded decision to add an Agent-host
   product to the toolchain, taken with that evidence in hand. Until such a
   decision exists, an adapter is out of scope regardless of how cheap it looks
   to build.

A reconsideration must also preserve the constraints that hold independently of
this question: no important Agent hidden behind one parent model or process, no
extra model turn for mechanical dispatch, and no Agent-host dependency in the
runtime's own entry point.
