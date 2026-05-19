# Project Backlog

## Open Work

No open work is actionable before a real subagent coordinator smoke run is approved.

## Blocked Work

- Smoke-test the component-recipe coordinator with real subagents.
  - Priority: High.
  - Blocked by: Explicit approval to launch a multi-branch subagent async run against a small scope.
  - Scope: Register or start `examples/recipes/subagent-review-coordinator.json` with a narrow harmless scope, inspect status/tail/events, and record whether the component contract needs changes for artifacts, stdin handoff, or event emission.
  - Exit: One real run proves the seed component toolkit works end-to-end, or the required adapter/runtime changes are captured as concrete follow-ups.

- Validate branch-local checkpoint semantics with collaborative-runner experiments.
  - Priority: Low.
  - Blocked by: At least one real collaborative branch-runner async-run experiment.
  - Scope: Use real collaborative branch-runner async runs to validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are sufficient for branch-local validation and bounded reattempts.
  - Exit: Decision recorded as sufficient, documentation-only refinement needed, or propose a further minimal command-template extension with tests.
