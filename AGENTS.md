# Agent Flow Instructions

## Current objective

Build an observable multi-agent workflow runtime for the owner's existing mixed-agent development process.

The goal is one workflow entry point with multiple isolated Agent processes that remain visible and directly controllable in separate Herdr panes. The goal is not to hide every Agent inside Pi, add a parent-model relay, or replace model diversity with a single harness.

Read [the runtime design](docs/design/observable-multi-agent-runtime.md) before planning or implementing work.

## Non-negotiable constraints

- Every important Agent lane runs in its own Herdr pane with native live output.
- A human can focus, steer, interrupt, retry, and take over any lane.
- Coordinator exit must not terminate running lanes.
- Mechanical dispatch must not require an extra model call to decide which Agent to invoke.
- Agent contexts remain isolated; one reviewer must not see another reviewer's conclusions before reporting.
- Full child-Agent transcripts are not relayed through a parent model for summarization.
- GitHub Issues track planned work, dependencies, ownership, and decisions.
- The runtime ledger tracks actual runs, panes, sessions, events, exit codes, checkpoints, and artifacts.
- The executing Agent records semantic progress and gaps; the runner records objective command evidence and exit codes.
- Reviewer verdicts are inputs. The owner is the only final decision-maker.

## Sources of truth

- Product intent and architecture: `docs/design/observable-multi-agent-runtime.md`
- Work status and blocking edges: GitHub Issues in `netfishx/agent-flow`
- Per-run execution state: the runtime ledger defined by the design
- Repository tracker and domain conventions: `docs/agents/` once bootstrap is complete

Do not maintain dynamic project progress in this file or duplicate it in long-lived prompts. Query GitHub Issues and the run ledger.

## Current workflow being preserved

- Codex: implementation and read-only decision consultation
- Grok: repository exploration and default external research
- Sonnet/Haiku: selected execution, research, and mechanical verification lanes
- Claude, Codex, and Grok: independent review perspectives
- Herdr: visible process hosting, lifecycle observation, and human intervention

Role assignments may evolve through explicit owner decisions, but observable execution and independent contexts are architectural constraints.

## Working rules

- Prefer deterministic tools for spawning, waiting, validation, retries, and state capture.
- Reserve model calls for judgement: specification completeness, design choices, review findings, and owner-facing decisions.
- Build tracer bullets that are independently observable and verifiable.
- Start with a read-only cross-review prototype; migrate write-capable implementation workflows only after parity is demonstrated.
- Keep Pi optional until measurement shows that it reduces loss without hiding execution.
- Do not silently broaden a ticket beyond its declared acceptance criteria.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. External pull requests are not a triage request surface. See `docs/agents/issue-tracker.md` after tracker bootstrap is complete.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md` after tracker bootstrap is complete.

### Domain docs

This is a single-context repository. Read the root `CONTEXT.md` and applicable ADRs under `docs/adr/` when present. See `docs/agents/domain.md` after tracker bootstrap is complete.
