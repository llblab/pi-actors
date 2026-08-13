# Skill-Owned Recipe Components

Active Skills provide maintained execution graphs and service definitions. Skill Recipe identity is `<active Skill name>/<Recipe filename stem>`. Recipe files have no top-level `name`; `SKILL.md` `name` remains Pi host metadata matching the Skill directory, and pi-actors introduces no additional Skill identity field. Skill components are outside user Recipe discovery and never become tools merely because a Skill is active.

## Recommended Entry Points

### Repository and delivery

- `project-work/repo-health` — repository inspection and bounded health artifact.
- `project-work/docs-maintenance` — documentation analysis and artifact preparation.
- `project-work/release-readiness` — release checks and readiness artifact.
- `project-work/release-summary` — release-summary artifact.
- `swarm/development-tasking` — task-card and implementation planning pipeline.

### Review and synthesis

- `swarm/quorum-review` — parallel reviewers with quorum-oriented synthesis.
- `swarm/review-readiness` — review plus readiness stages.
- `swarm/research-synthesis` — evidence-oriented research synthesis.
- `swarm/lens-review` — configurable repeated review lenses.
- `swarm/subagent-review-coordinator` — lower-level review/verify/merge/judge composition.

Callers should own model, thinking, concurrency, quorum, and mission policy. Review pipelines preflight provider/model availability before expensive fanout.

### Artifacts

- `artifacts/report` — prepare one artifact body.
- `artifacts/write` — prepare and deterministically write an artifact.
- `artifacts/bundle` — optional validation, artifact write, manifest generation, and manifest write.
- `artifacts/file-write` — deterministic create/overwrite/append helper.
- `artifacts/manifest` — artifact manifest generation.

Artifact pipelines terminate in files/manifests and result evidence; they do not fabricate communication events.

### Controlled services

- `media/player` — playback service with declared playback actions, `controls.jsonl`, generation-fenced endpoint readiness, state artifact, and playback Trace. Player selection is `player:enum(auto,mpv,afplay,ffplay,cvlc,play,wmp)=auto`.
- `actors/resource-locker` — optional queue/lease-lock service with explicit owner/resource input, lock Trace, and a 512-record/1 MiB atomically retained journal.

These Recipes declare actor-local Control. Ordinary one-shot Recipes omit it. Helper-backed Skill Recipes self-locate through runtime-owned `{skill_dir}`; callers do not pass package installation roots.

## Component Recipes

Subagent components provide reusable command-template cells for normalization, planning, evidence mapping, contradiction analysis, criticism, review, verification, merging, judging, quorum work, task cards, checkpoint prompts, and artifact generation.

Imports compose these definitions inside one parent Run. They are not independently addressable peers. Parent template flags control sequencing, parallelism, retries, failure scope, recovery, and repeated execution.

Recipes bundled under a Pi-active Skill are selected as `<skill-name>/<recipe-stem>` and receive runtime-owned `{skill_dir}` plus `{recipe_dir}`. Explicit `.json` / `.md` paths select exact files: entry paths are based at invocation `cwd`, while relative imports are based at the importing Recipe's directory. Active Skill components are library entries, never automatic tools; expose one intentionally through a user Recipe wrapper when a direct tool is desired.

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

Do not bulk-copy bundled Recipes into the user Recipe root. Internal `recipe-memory/draft-review` and `recipe-memory/tool-review` components support fenced automatic review and must not become user-installed callable tools. Register or wrap only the specific public capability you intend to use.

## Validation

```bash
npm run recipes:qa
```

Recipe QA recursively inventories direct Skill components and validates filesystem identity, syntax, imports, Control declarations, origin ownership, portable artifact paths, and `{skill_dir}` helper references. Nested files and JSON/Markdown stem collisions fail precisely. Recipe descriptions remain optional; QA requires zero capability diagnostics and zero warnings without enforcing style, documentation quotas, or architecture policy. Removed mailbox declarations fail with the migration diagnostic rather than receiving automatic conversion.

## Related

- [Template Recipes](./template-recipes.md)
- [Command templates](./command-templates.md)
- [Runs](./async-runs.md)
