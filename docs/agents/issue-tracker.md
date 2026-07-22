# Issue Tracker: GitHub

Issues and planning records for this repository live in GitHub Issues at `netfishx/agent-flow`. Use the `gh` CLI for tracker operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List work with `gh issue list --state open --json number,title,body,labels,assignees,comments` and appropriate label filters.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` and `--remove-label "..."`.
- Claim work with `gh issue edit <number> --add-assignee @me`.
- Close work with `gh issue close <number> --comment "..."` only after its acceptance criteria and evidence are complete.

Infer the repository from `git remote -v` when running inside a clone. Otherwise pass `--repo netfishx/agent-flow` explicitly.

## Pull requests as a triage surface

External pull requests are **not** a request surface. Pull requests deliver reviewed changes; new work enters through GitHub Issues.

Do not add external PRs to the issue triage queue. Do not modify collaborator work unless the user places that PR in scope.

## Publishing and fetching work

- When a skill says “publish to the issue tracker,” create a GitHub issue.
- When a skill says “fetch the relevant ticket,” read the complete issue body, labels, assignees, and comments.
- GitHub shares one number space across issues and pull requests. Resolve an ambiguous `#<number>` before acting.

## Blocking edges

Prefer GitHub native issue dependencies when available. Add a blocker through the dependencies endpoint using the blocker issue's numeric database ID, not its visible issue number or GraphQL node ID.

If native dependencies are unavailable, put this at the end of the blocked issue body:

```text
## Blocked by

- #<issue-number>
```

A ticket is on the frontier only when every blocker is closed and it has no active assignee.

## Progress and execution evidence

GitHub Issues own planned lifecycle: scope, acceptance criteria, blockers, assignee, owner decisions, and final artifact links.

The runtime ledger owns volatile execution state. Agents should attach only milestone records to an issue:

- start: run ID and visible Herdr lane names;
- blocked: one structured blocker and the relevant triage state;
- complete: result artifacts, objective verification evidence, and gaps;
- decision: the owner's decision and resulting issue state.

Do not post heartbeat comments for routine activity.
