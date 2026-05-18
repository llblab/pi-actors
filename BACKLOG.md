# Project Backlog

## Open Work

No open work that is safe to execute before the gated 0.7.0 release.

## Blocked Work

- Execute 0.7.0 release.
  - Priority: High.
  - Blocked by: Explicit user command to push, open a PR, merge, tag, or publish.
  - Scope: Push `dev`, open the release PR, wait for checks, merge, tag `v0.7.0`, and publish npm only when explicitly instructed.
  - Exit: Release is completed and recorded, or the release is explicitly cancelled.

- Validate branch-local checkpoint semantics with collaborative-runner experiments.
  - Priority: Low.
  - Blocked by: At least one real collaborative branch-runner async-run experiment.
  - Scope: Use real collaborative branch-runner async runs to validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are sufficient for branch-local validation and bounded reattempts.
  - Exit: Decision recorded as sufficient, documentation-only refinement needed, or propose a further minimal command-template extension with tests.
