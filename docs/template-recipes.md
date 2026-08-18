# Template Recipes

A Recipe stores a reusable command-template definition as JSON or Markdown.

## JSON

```json
{
  "async": true,
  "description": "Create a repository health artifact",
  "args": ["repo:path", "artifact_path:path", "model:string"],
  "defaults": { "artifact_path": "{state_dir}/health.md" },
  "imports": { "review": "swarm/quorum-review" },
  "artifacts": { "report": "{artifact_path}" },
  "template": {
    "name": "review",
    "values": { "input": "Inspect {repo}", "model": "{model}" }
  }
}
```

## Markdown

Markdown Recipes use YAML frontmatter and one executable fence:

````markdown
---
description: Summarize one file
args:
  - file:path
---

Human notes remain advisory.

```template
summarize {file}
```
````

Fences marked `template`, `command-template`, `json`, or `recipe` can define execution. Frontmatter supports Recipe metadata and command-template flags.

Skill Recipe identity is `<active Skill name>/<Recipe filename stem>`. Recipe files have no top-level `name`; both JSON and Markdown fail with migration guidance when that removed field is present. `SKILL.md` `name` remains Pi host metadata and matches the Skill directory; pi-actors introduces no additional Skill identity field. The `name` field on a command-template node still selects an imported alias and is not Recipe self-identity.

## Fields

Common Recipe fields:

- `description`, `disabled`;
- `args`, typed arg declarations, inline defaults, `defaults`, and composition `values`;
- `imports` with optional binding defaults/values;
- `template`;
- `async`;
- `singleton: true` for one explicit Skill-owned async service slot;
- `artifacts`;
- `control` for actual controlled services;
- command-template flags such as `parallel`, `concurrency`, `min_successful`, `when`, `timeout`, `delay`, `retry`, `failure`, `recover`, `repeat`, `accept_output`, and `output`;
- `retire_when: "children_terminal"` for opt-in supervisor retirement.

## Imports

```json
{
  "imports": {
    "review": "swarm/quorum-review",
    "report": {
      "from": "../shared/report.md",
      "defaults": { "thinking": "medium" }
    }
  },
  "template": [
    { "name": "review", "values": { "input": "{input}" } },
    { "name": "report", "values": { "input": "Use prior output" } }
  ]
}
```

Imports are local definitions. Named nodes call imported templates inside the same execution graph and Run. Effective values follow `caller > node/import/Recipe values > defaults > inline arg default > missing-value error`, then the selected value is checked against its declared type or enum.

Imports accept exactly `<skill>/<recipe>` or an explicit `.json` / `.md` file path. A Skill reference selects one direct filename stem under the exact Skill currently active through Pi resource discovery; duplicate active Skill identities and JSON/Markdown stem collisions fail closed. Explicit paths may be relative (`./local-review.json`, `../shared/report.md`) or absolute (`/absolute/path/to/recipe.json`). An entry file path resolves from invocation `cwd`; a relative import resolves from the importing Recipe's directory. No bare or ambient lookup remains.

Direct delegation can use another Recipe as the entire template. The delegated Recipe remains the source of truth while the wrapper may narrow args/defaults or override selected lifecycle metadata.

A launched Run captures each entry/import role, filename-derived stem, logical reference, Skill identity when owned, and import alias ancestry. Private physical source paths remain execution provenance; Inspector and child-agent context expose logical identities rather than machine-local Skill locations.

## Migration from pre-0.46 references

```text
std:foo              -> owning-skill/foo
skill:foo/bar        -> foo/bar
root packaged foo    -> owning-skill/new-file-stem
Recipe name field    -> delete; filename is identity
nested skill path    -> flatten filename or use explicit file path
```

Removed `std:` and `skill:` forms fail with migration guidance; they are not aliases. Root packaged Recipes no longer exist. Flatten a maintained Skill component to a direct filename, or reference a nested/local file explicitly when it is intentionally outside the Skill component namespace.

## Singleton Services

`singleton: true` is valid only for an async Skill Recipe, and one Skill may declare at most one singleton Recipe. The runtime derives `run:<skill>` and the canonical `<skill>/<recipe>` identity, then rejects a conflicting caller-supplied Run id. A compatible repeated launch returns the healthy active generation; contradictory Recipe identity, ownership, startup values, or Control fails closed. A terminal result is never reused even during runner exit; retry after that process exits starts a fresh `run_instance_id` under the same logical Run id. Actor-owned workload continuity requires a validated state artifact that restart cleanup deliberately preserves; singleton identity alone never proves restored state.

Direct Recipe delegation inherits the original singleton Run and Recipe identities, so registered tools and explicit wrappers cannot retarget the service or create parallel aliases.

## Control

Only a process that consumes actor-local input declares actions:

```json
{
  "async": true,
  "control": ["pause", "resume", "stop"],
  "template": "{skill_dir}/scripts/service.mjs --state-dir {state_dir}"
}
```

Actions must be lowercase ASCII, unique, non-reserved, and at most 64 characters. Serialized Control input is at most 380 bytes so every admitted wire record remains within 512 bytes on FIFO and named pipe. One-shot Recipes omit Control. Larger data belongs in a declared artifact/path; outputs belong in Trace, artifacts, execution evidence, or the command result.

## Artifacts

```json
{
  "artifacts": {
    "report": "{state_dir}/report.md",
    "manifest": "{state_dir}/manifest.json"
  }
}
```

Artifact paths resolve under containment policy and appear in Run inspection. Recipes should write declared artifacts deterministically and fail when the requested write policy cannot be honored.

## File Origins

Every file-backed Recipe receives immutable `{recipe_dir}`. A Recipe under an active Skill also receives `{skill_dir}`, resolved to the directory containing that Skill's `SKILL.md`; using `{skill_dir}` elsewhere fails clearly. These runtime values cannot be declared in `args`, `defaults`, or `values`, and caller input cannot override them. They expand in templates, recursive defaults/values, imports, and artifacts while existing `./` executable behavior remains relative to invocation `cwd`.

## Context and Provenance

File-backed Runs capture Recipe context records for the entry and imports. File identity is the filename stem; a direct Recipe under an active Skill has the logical identity `<skill>/<stem>`. The captured bundle explains composition identity and remains generation-local evidence. Runtime origin paths remain in local Run provenance but are omitted from model-facing launch values. It does not override the authored task prompt.

Recipes that need a minimal child prompt may opt out of injected Recipe context through the documented `actor_context` launch option.

## Current Policy

Defaults can inherit current Pi policy:

```json
{
  "defaults": {
    "model": "{current_model}",
    "thinking": "{current_thinking}"
  }
}
```

Resolution fails before launch when required current policy is unavailable. The Run persists whether values were inherited or explicit.

## Resolution Context

User Recipes under `~/.pi/agent/recipes` remain intentionally registered tools, not an ambient import namespace. Each session receives one immutable resolution context from Pi's loaded Skill metadata; spawn, user-Recipe admission, registration, schema derivation, live inspection, and watcher reconciliation consume that same context rather than scanning ambient Skill roots or keeping a process-global mutable namespace. A launch captures its resolved graph, so later Skill changes affect only future launches. An invalid or missing exact target fails without fallback. Disabled Recipes cannot launch. Registry watchers converge after atomic changes without executing partial definitions.

Active-Skill catalog inventory is fail-soft diagnostic state, not exact-resolution authority. Invalid components are reported individually and make the catalog partial while unrelated valid `<skill>/<recipe>` references remain exactly resolvable.

## Validation

```bash
node skills/actors/scripts/validate-recipe.mjs path/to/recipe.json --qa
node skills/actors/scripts/validate-recipe.mjs skills --skills --qa --summary
```

Skill validation recursively inventories every direct `<skill>/recipes/*.json|*.md` component, rejects nested files and duplicate stems, and checks filename identity, JSON/Markdown compilation, origins, imports, Control, artifacts, portable paths, helper targets, and platform notes. Files exceeding 1 MiB or import depth 32 fail closed.

## Related

- [Command templates](./command-templates.md)
- [Runs](./async-runs.md)
- [Recipe library](./recipe-library.md)
- [Tool registry](./tool-registry.md)
