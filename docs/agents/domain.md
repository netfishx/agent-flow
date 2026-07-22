# Domain Docs

This is a single-context repository for observable multi-agent workflow orchestration.

## Before exploring

Read these sources when they exist:

- `CONTEXT.md` at the repository root for domain vocabulary;
- applicable ADRs under `docs/adr/`;
- `docs/design/observable-multi-agent-runtime.md` for the active product intent and architectural constraints;
- the complete GitHub issue and comments for the work being performed.

If `CONTEXT.md` or `docs/adr/` does not exist, proceed silently. Create domain documentation lazily when terminology or a durable architectural decision is actually resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   ├── agents/
│   └── design/
└── src/
```

The absence of `CONTEXT.md`, `docs/adr/`, or `src/` during early bootstrap is expected.

## Vocabulary discipline

Use terms from `CONTEXT.md` in issue titles, acceptance criteria, design proposals, tests, and implementation names. Do not silently replace an established term with a synonym.

If a necessary term is missing, either reconsider whether the concept belongs in the design or record the vocabulary gap for domain modelling.

## ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly and leave the decision to the owner. Do not silently override an accepted decision.
