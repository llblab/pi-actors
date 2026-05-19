# Project Backlog

## Open Work

Continue progressive component/pipeline expansion in small validated slices; real smoke runs remain gated. Prefer task-first design for new high-level recipe families: start from operator/coordinator work patterns, then derive missing component cells.

- Progressively increase component parameterization and higher-level recipe composition.
  - Priority: High.
  - Scope: Iteratively strengthen atom/component recipes with public policy knobs such as model pools, stage-specific models, thinking, tool policy, output format, evidence policy, risk policy, source policy, artifact paths, event delivery, handoff format, resume/continuity policy, and validation gates; add higher-level component recipes that compose existing atoms into reusable coordinator patterns.
  - Exit: Each iteration adds or refines at least one atom-level parameterization surface and at least one composed recipe/pipeline, with packaged recipe import validation passing and docs/changelog updated.

- Add another task-first high-level pipeline candidate from the design map.
  - Priority: Medium.
  - Status: `pipeline-release-readiness`, `pipeline-repo-health`, `pipeline-async-run-ops`, `pipeline-docs-maintenance`, and `pipeline-media-library` landed. `pipeline-media-library` required playlist output-mode parameterization, then reused playlist and artifact-report cells.
  - Scope: Reassess `docs/task-first-recipes.md` for the next high-value task cell after 0.7.1, then implement only the minimum missing cells needed for that task.
  - Exit: Another task-first pipeline lands with docs, package validation, and a note about which missing atoms/utilities it required.

- Grow the standard recipe library with safer structured utility transforms.
  - Priority: Low.
  - Status: `utility-artifact-manifest` landed for machine-readable artifact metadata; `utility-package-summary` landed for bounded package metadata used by release/repo-health flows; `utility-validate-recipe` landed with a dedicated recipe validator script.
  - Scope: Continue beyond listing/extraction utilities toward structured transforms for artifact packaging, report normalization, release prep, and machine-readable summaries. Keep helpers generic, parameterized, and justified by repeated recipe needs.
  - Exit: A future utility slice adds another structured transform only when a repeated recipe need appears; otherwise treat the current helper-backed utility surface as sufficient for 0.7.1.

## Blocked Work

- Smoke-test higher-level pipelines with real subagents.
  - Priority: High.
  - Status: Real `subagent-review-coordinator` smoke passed after fixing nested object template execution for repeated imported component nodes; run `coordinated-multiagent-smoke-2` reached parallel reviewer fanout (`activeSubagents: 3`) and completed verifier, merger, judge, and normalizer stages with code 0. Reload smoke confirmed three concurrently started independent subagent async runs show three simultaneous ambient triangles when held open long enough; this validates one-triangle-per-live-run semantics, not internal branch counts.
  - Blocked by: Explicit approval to launch an additional higher-level multi-subagent pipeline run against a small scope.
  - Scope: Start one `recipes/pipeline-*.json` recipe that includes real subagent stages with a narrow harmless scope, inspect status/tail/events, and record whether the component contract needs changes for artifacts, stdin handoff, or event emission.
  - Exit: One higher-level pipeline run proves the toolkit works end-to-end, or the required adapter/runtime changes are captured as concrete follow-ups.

- Validate branch-local checkpoint semantics with collaborative-runner experiments.
  - Priority: Low.
  - Blocked by: At least one real collaborative branch-runner async-run experiment.
  - Scope: Use real collaborative branch-runner async runs to validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are sufficient for branch-local validation and bounded reattempts.
  - Exit: Decision recorded as sufficient, documentation-only refinement needed, or propose a further minimal command-template extension with tests.
