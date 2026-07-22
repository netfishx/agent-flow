# agent-flow

Observable orchestration for a mixed-agent development workflow.

`agent-flow` aims to provide one deterministic workflow entry point while keeping every important Agent process isolated, visible, and directly controllable in its own Herdr pane.

It does **not** aim to place every Agent silently inside one harness or add another model turn merely to dispatch work.

## Current status

Tracker initialized; no runtime has been implemented yet.

The first tracer bullet will launch a read-only, multi-model cross-review in visible Herdr panes, persist run state and result artifacts, and compare it with the existing workflow before any Pi integration or implementation-workflow migration.

## Read first

- [Agent instructions](AGENTS.md)
- [Observable multi-agent runtime design](docs/design/observable-multi-agent-runtime.md)
- [Tracking issue #1](https://github.com/netfishx/agent-flow/issues/1) for current work and blocking edges

## Core principle

Unify orchestration and state, not execution visibility:

```text
Human
  ↕ observe / steer / interrupt
Herdr panes
  ↕ deterministic lifecycle and artifacts
Workflow Runtime
  ↕ isolated adapters
Claude / Codex / Grok / Pi / command runners
```
