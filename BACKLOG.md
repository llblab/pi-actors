# Project Backlog

## Open Work

No open work that is safe to execute before the gated 0.7.0 release.

## Blocked Work

- Validate branch-local checkpoint semantics with collaborative-runner experiments.
  - Priority: Low.
  - Blocked by: At least one real collaborative branch-runner async-run experiment.
  - Scope: Use real collaborative branch-runner async runs to validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are sufficient for branch-local validation and bounded reattempts.
  - Exit: Decision recorded as sufficient, documentation-only refinement needed, or propose a further minimal command-template extension with tests.
