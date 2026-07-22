# Observable Multi-Agent Workflow Runtime

> Status: design and tracer-bullet plan; not implemented.
> Progress source: [tracking issue #1](https://github.com/netfishx/agent-flow/issues/1) and its native blocking dependencies.
> Do not maintain dynamic issue progress in this document.

## 1. Context

The owner's current development workflow already mixes several Agent tools and model families:

- Codex for implementation and read-only decision consultation;
- Grok for repository exploration and default external research;
- Sonnet/Haiku for selected execution, research, and verification lanes;
- Claude, Codex, and Grok for independent review perspectives;
- Herdr for visible process hosting and human intervention.

The current loss is not simply “too many models.” It comes from mechanical orchestration being distributed across skills and shell runbooks: constructing briefs, starting processes, carrying session and pane identifiers, polling, recovering sessions, checking output contracts, and moving artifacts between stages.

## 2. Goal

Provide one workflow entry point with multiple isolated, visible, directly controllable Agent processes.

```text
                         Human
                 observe / input / interrupt
                           │
                  Herdr workspace
       ┌───────────┬───────┼───────────┬───────────┐
       │           │       │           │           │
 controller    Codex pane Grok pane Claude pane runner pane
       │           │       │           │           │
       └───────────┴── Workflow Runtime ────────────┘
                           │
                  state, contracts, artifacts
```

The runtime unifies orchestration and state. It does not centralize execution into a hidden parent Agent.

## 3. Non-goals

- Running every Agent silently inside Pi or another single process.
- Adding a parent-model turn to decide which deterministic lane to start.
- Removing independent reviewer contexts to reduce token use.
- Relaying complete child-Agent transcripts through a coordinator model.
- Replacing human observation and intervention with background automation.
- Migrating write-capable implementation workflows before a read-only tracer proves parity.

## 4. Responsibility model

### Workflow Runtime records process facts

- workflow, repository, fixed point, run and lane identifiers;
- Agent kind, model, effort, tab, pane, and session identifiers;
- prompt, checkpoint, result, and log paths;
- lifecycle state and timestamps;
- retry, resume, steer, interrupt, and abort events;
- actual process exit code and completion sentinel.

### Executing Agent records semantic progress

Each lane writes a checkpoint/result before yielding:

```text
STATUS: working | complete | partial | blocked
PHASE: <current phase>
COMPLETED:
- <completed work>
NEXT:
- <next step>
BLOCKERS:
- <blocker or none>
ARTIFACTS:
- <file, diff, commit, or report pointer>
VERIFICATION_CLAIMS:
- <commands the Agent claims to have run; evidence only after runner capture>
GAPS:
- <unfinished or uncertain work>
```

The Agent owns semantic progress because it knows what it attempted and what remains. Its claims do not replace objective verification.

### Runner records verification evidence

- exact command;
- stdout/stderr artifact;
- actual exit code;
- start and end timestamps;
- timeout, signal termination, and environment failure.

### Human owns judgement

The owner observes, intervenes, accepts or rejects findings, and makes final decisions. The owner does not manually copy routine progress between systems.

## 5. Persistent run ledger

Suggested layout:

```text
$XDG_STATE_HOME/agent-flow/runs/<run-id>/
├── run.json
├── events.jsonl
├── briefs/
├── checkpoints/
├── results/
└── logs/
```

`run.json` is the current snapshot. `events.jsonl` is the append-only event source. A run records at least:

```text
runId
workflow
repo
fixedPoint
startedAt
updatedAt
controllerPaneId
tabId
status
lanes[]
  laneId
  role
  agentKind
  model
  effort
  paneId
  status
  promptFile
  checkpointFile
  resultFile
  logFile
  sessionId
  exitCode
```

Recovery reads the ledger instead of chat memory:

```text
flow status
flow inspect <run-id>
flow resume <run-id>
```

Memory should retain only stable intent and pointers. GitHub Issues track planned work. The run ledger tracks volatile execution state.

## 6. Intended external interface

Keep the interface small and hide Herdr and Agent-specific mechanics:

```text
startWorkflow(...)
inspectWorkflow(runId)
steerLane(runId, laneId, message)
retryLane(runId, laneId)
stopLane(runId, laneId)
```

Pane identifiers, CLI flags, session identifiers, result files, sentinels, and resume commands belong to the implementation and its adapters.

## 7. Acceptance invariants

- Every important Agent lane has a dedicated Herdr pane.
- Native live output is visible without parent-model relay.
- A human can focus, steer, interrupt, retry, and take over a lane.
- Coordinator exit does not terminate running lanes.
- Mechanical dispatch adds zero model calls.
- Reviewer contexts remain independent.
- Results are durable artifacts rather than scrollback-only output.
- Raw reviewer reports remain available side by side.
- Agent checkpoints, runtime facts, and runner evidence remain distinct.

## 8. Tracer-bullet sequence

### Phase 0: Measure the existing workflow

Use a real branch with a resolvable fixed point and non-empty diff. Record one current cross-review and one implementation flow: start/end time, manual orchestration commands, Agent starts and failures, steering and recovery events, first/last result time, input tokens, and useful findings.

Completion evidence must distinguish model inference, process startup, and human coordination time. No later phase may claim a performance improvement without this baseline.

### Phase 1: Prove six visible Herdr panes

Create a dedicated Herdr tab, split six panes, and run simulated lanes that stream progress and print lane-specific completion sentinels. Verify:

- all lanes are simultaneously observable;
- a human can interrupt exactly one lane;
- the controller can leave without terminating lanes;
- pane output waits reliably detect each unique completion sentinel.

Do not start real reviewers in this phase.

### Phase 2: Implement a Herdr module

Create a standalone repository module with a small interface for visible runs and lanes. Hide Herdr JSON parsing, layout, identifiers, lifecycle waits, and sentinels. Test through a fake adapter, then verify through the real Herdr stack.

### Phase 3: Persist the run ledger

Add the snapshot, append-only event stream, per-lane checkpoints, results, and logs. Demonstrate that a fresh controller process can inspect and resume an unfinished run.

### Phase 4: Launch read-only cross-review

Generate independent Claude/Codex/Grok × Standards/Spec briefs from one fixed point and one review contract. Launch all six lanes in visible panes. Persist every checkpoint and final report.

The first implementation validates the required `VERDICT`, `CONFIDENCE`, and `FINDINGS` structure and exposes the six raw reports. It does not add a model summarizer or semantic clustering step.

### Phase 5: Compare parity and loss

Compare the prototype with the Phase 0 baseline on manual commands, startup time, first/last reviewer completion, coordinator model calls, recovery failures, useful findings, output loss, and human intervention quality.

Stop if mechanical dispatch still needs an extra model call, any important Agent becomes hidden, review quality falls, or controller loss prevents recovery.

### Phase 6: Evaluate a Pi command adapter

Only after Phase 5 passes, expose deterministic commands such as:

```text
/xr <fixed-point> <spec-ref>
/flow-status <run-id>
/flow-focus <run-id> <lane>
/flow-retry <run-id> <lane>
```

The commands call the runtime directly. Pi may be an entry/controller pane or one Agent adapter, but Herdr continues to host observable execution.

### Phase 7: Migrate the implementation workflow

Migrate worktree isolation, Codex implementation, checkpoints, objective verification, resume, two-round stop-loss, cross-review chaining, and owner judgement only after the read-only tracer succeeds.

## 9. Issue and execution synchronization

GitHub Issues own planned lifecycle:

- scope and acceptance criteria;
- blocking edges;
- assignee and readiness state;
- owner decisions;
- final artifact and run links.

The runtime should synchronize milestone events instead of spamming heartbeat comments:

- on start: claim the issue and attach `runId` plus pane names;
- on blocked: post one structured blocker and move to the appropriate triage state;
- on completion: attach result, verification evidence, and gaps;
- on owner decision: record the decision and resulting issue state.

Fine-grained activity stays in `events.jsonl` and lane checkpoints.

## 10. Decision gates

The following remain explicit owner decisions after evidence is available:

- whether Claude review axes move from internal sub-agents into Herdr panes;
- whether deterministic verification replaces any Sonnet lane-runner work;
- whether Pi becomes a command adapter, an Agent adapter, both, or neither;
- whether implementation migration is worth the change in native CLI behavior.
