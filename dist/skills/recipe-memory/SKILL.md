---
name: recipe-memory
description: Use only for internal automatic Recipe-memory review, diagnosis, or recovery; do not use for normal Recipe creation, registration, or invocation.
---

# Recipe Memory

Use this Skill only when automatic draft-memory or active-tool review needs diagnosis or bounded recovery. Normal agents must not spawn, register, specialize, or invoke `recipe-memory/draft-review` or `recipe-memory/tool-review`; they are package-owned internal reviewer components.

## Evidence limits

Automatic reviewers receive value-free contract shape, risk labels, usage counts, and batch-local equality groups, not executable content, descriptions, paths, or canonical names. Structural evidence and launch counts alone do not establish semantic purpose, good tool names, successful reuse, or accepted outcomes. Promotion preserves unchanged captured executable content; it does not generalize a one-off mission.

Explicit create-only retention is owned by `actors` through `actors_tool_register expose=false`, not by these internal reviewers. Automatic retained lifecycle is not implemented. Current draft promote/discard and tool-review behavior are unchanged. Missing evidence is unknown; this guidance adds no retain/defer action, retry permission, automatic rewrite, or live migration. Do not bypass confidentiality or edit review state to simulate the future policy.

## Diagnose first

```text
actors_inspect target=recipes view=reviews
actors_inspect target=runtime view=triage
```

Use the review view to distinguish `draft` and `tool` scope, current phase, failed stage, bounded error, preserved transaction evidence, and the recorded next action. Use runtime triage only when the reviewer Run itself needs Run-level diagnosis. Follow `actors` for generic Inspect, Run, and Control semantics.

## Recovery Controls

Use runtime Controls only when the review evidence names the matching recovery action:

```text
actors_control_apply target=runtime action=review.retry input={"scope":"draft"}
actors_control_apply target=runtime action=review.retry input={"scope":"tool"}
actors_control_apply target=runtime action=review.reset input={"scope":"draft"}
actors_control_apply target=runtime action=review.reset input={"scope":"tool"}
```

- `review.retry` resumes the selected failed review scope while preserving authenticated transaction recovery.
- `review.reset` clears disposable failure state only. It must reject evidence that requires roll-forward recovery.
- Re-inspect `view=reviews` after one recovery Control; do not loop retries or resets without changed evidence.

## Stop rules

Stop when the phase is healthy or idle, the requested scope does not match the failure, recovery evidence requires deterministic roll-forward, or the reported next action is not retry/reset. Never edit review state, lineage, journals, quarantine, drafts, or persisted Recipes directly. Never bypass automatic review by running its internal Recipes as ordinary capabilities.
