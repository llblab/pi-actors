# Packaged Recipe Library

Packaged Recipes provide maintained execution graphs and service definitions. User Recipes with the same name shadow packaged definitions; invalid shadowing fails closed.

## Recommended Entry Points

### Repository and delivery

- `pipeline-repo-health.json` — repository inspection and bounded health artifact.
- `pipeline-docs-maintenance.json` — documentation analysis and artifact preparation.
- `pipeline-release-readiness.json` — release checks and readiness artifact.
- `pipeline-release-summary.json` — release-summary artifact.
- `pipeline-development-tasking.json` — task-card and implementation planning pipeline.

### Review and synthesis

- `pipeline-quorum-review.json` — parallel reviewers with quorum-oriented synthesis.
- `pipeline-review-readiness.json` — review plus readiness stages.
- `pipeline-research-synthesis.json` — evidence-oriented research synthesis.
- `lens-swarm.json` — configurable repeated review lenses.
- `subagent-review-coordinator.json` — lower-level review/verify/merge/judge composition.

Callers should own model, thinking, concurrency, quorum, and mission policy. Review pipelines preflight provider/model availability before expensive fanout.

### Artifacts

- `pipeline-artifact-report.json` — prepare one artifact body.
- `pipeline-artifact-write.json` — prepare and deterministically write an artifact.
- `pipeline-artifact-bundle.json` — optional validation, artifact write, manifest generation, and manifest write.
- `utility-artifact-write.json` — deterministic create/overwrite/append helper.
- `utility-artifact-manifest.json` — artifact manifest generation.

Artifact pipelines terminate in files/manifests and result evidence; they do not fabricate communication events.

### Controlled services

- `music-player.json` — playback service with declared playback actions, `controls.jsonl`, generation-fenced endpoint readiness, state artifact, and playback Trace. Player selection is `player:enum(auto,mpv,afplay,ffplay,cvlc,play,wmp)=auto`.
- `resource-locker.json` — optional queue/lease-lock service with explicit owner/resource input, lock Trace, and a 512-record/1 MiB atomically retained journal.

These are the packaged Recipes that declare actor-local Control. Ordinary one-shot Recipes omit it. Helper-backed packaged Recipes self-locate their installed package root when `repo` is omitted; an explicit caller value still wins for development or custom layouts.

## Component Recipes

Subagent components provide reusable command-template cells for normalization, planning, evidence mapping, contradiction analysis, criticism, review, verification, merging, judging, quorum work, task cards, checkpoint prompts, and artifact generation.

Imports compose these definitions inside one parent Run. They are not independently addressable peers. Parent template flags control sequencing, parallelism, retries, failure scope, recovery, and repeated execution.

## Utility Recipes

Utilities wrap deterministic local capabilities such as:

- package and skill summaries;
- artifact writes/manifests;
- validation commands;
- Run operations snapshots;
- Recipe validation.

Use utilities as imported cells or registered tools where their contract fits.

## Selection Guidance

1. Prefer the highest-level maintained pipeline matching the task.
2. Use component Recipes when building a new stable pipeline.
3. Use inline templates for genuinely one-off trusted work.
4. Declare artifacts for outputs that callers must retain.
5. Declare Control only when a service process actually consumes it.
6. Keep large semantic evidence in artifacts or execution captures, not Trace summaries; Trace/Control quotas do not bound user artifacts or actor-owned workload state.

## Installation Safety

Do not bulk-copy `recipes/*.json` into the user Recipe root. Internal `draft-review.json` and `tool-review.json` support fenced automatic review and must not become user-installed callable tools. Register or wrap only the specific public capability you intend to use.

## Validation

```bash
npm run recipes:qa
```

Recipe QA validates syntax, imports, Control declarations, artifact paths, helper references, and platform documentation. Recipe descriptions are optional because discovery supplies stable fallback tool copy; internal component Recipes do not need boilerplate. The packaged baseline requires zero diagnostics and zero warnings, and any future warning is release-blocking with its concrete file and repair. Removed mailbox declarations fail with the migration diagnostic rather than receiving automatic conversion.

## Related

- [Template Recipes](./template-recipes.md)
- [Command templates](./command-templates.md)
- [Runs](./async-runs.md)
