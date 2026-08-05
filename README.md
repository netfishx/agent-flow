# agent-flow

Observable orchestration for a mixed-agent development workflow.

`agent-flow` aims to provide one deterministic workflow entry point while keeping every important Agent process isolated, visible, and directly controllable in its own Herdr pane.

It does **not** aim to place every Agent silently inside one harness or add another model turn merely to dispatch work.

## Scope

The v1 execution toolchain is Claude Code, Codex, and Grok Build, hosted as visible native processes under Herdr. The runtime entry point is technology-neutral and depends on no Agent-host product.

The tracer sequence starts with a read-only, multi-model cross-review in visible Herdr panes that persists run state and result artifacts, and migrates the write-capable implementation workflow only after parity with the existing workflow is demonstrated. Current progress lives on [tracking issue #1](https://github.com/netfishx/agent-flow/issues/1), not in this file.

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
Claude Code / Codex / Grok Build / command runners
```
