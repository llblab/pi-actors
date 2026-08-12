# Template Recipes

A Recipe stores a reusable command-template definition as JSON or Markdown.

## JSON

```json
{
  "async": true,
  "description": "Create a repository health artifact",
  "args": ["repo:path", "artifact_path:path", "model:string"],
  "defaults": { "artifact_path": "{state_dir}/health.md" },
  "imports": { "review": "subagent-review.json" },
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

## Fields

Common Recipe fields:

- `name`, `description`, `disabled`;
- `args`, typed arg declarations, inline defaults, `defaults`, and composition `values`;
- `imports` with optional binding defaults/values;
- `template`;
- `async`;
- `artifacts`;
- `control` for actual controlled services;
- command-template flags such as `parallel`, `concurrency`, `min_successful`, `when`, `timeout`, `delay`, `retry`, `failure`, `recover`, `repeat`, `accept_output`, and `output`;
- `retire_when: "children_terminal"` for opt-in supervisor retirement.

## Imports

```json
{
  "imports": {
    "review": "subagent-review.json",
    "verify": {
      "from": "subagent-verify.json",
      "defaults": { "thinking": "medium" }
    }
  },
  "template": [
    { "name": "review", "values": { "input": "{input}" } },
    { "name": "verify", "values": { "input": "Use prior output" } }
  ]
}
```

Imports are local definitions. Named nodes call imported templates inside the same execution graph and Run. Effective values follow `caller > node/import/Recipe values > defaults > inline arg default > missing-value error`, then the selected value is checked against its declared type or enum.

Bare references preserve user → adjacent → packaged resolution. `std:<name>` selects a packaged Recipe exactly. `skill:<skill-name>/<recipe-path>` selects a component under the `recipes/` tree of a Skill currently active through Pi resource discovery. Skill Recipes never become tools merely by existing, and duplicate active Skill names fail as ambiguous rather than shadowing silently.

Direct delegation can use another Recipe as the entire template. The delegated Recipe remains the source of truth while the wrapper may narrow args/defaults or override selected lifecycle metadata.

## Control

Only a process that consumes actor-local input declares actions:

```json
{
  "async": true,
  "control": ["pause", "resume", "stop"],
  "template": "{repo}/scripts/service.mjs --state-dir {state_dir}"
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

File-backed Runs capture Recipe context records for the entry and imports, including qualified `std:` or `skill:` identity when applicable. The captured bundle explains composition identity and remains generation-local evidence. Runtime origin paths remain in local Run provenance but are omitted from model-facing launch values. It does not override the authored task prompt.

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

## Resolution and Shadowing

User Recipes under `~/.pi/agent/recipes` take priority over adjacent and packaged Recipes for compatible bare lookup. Exact `std:` and `skill:` references bypass that ambiguous space. The active Skill namespace converges from Pi's loaded Skill metadata on startup/reload; pi-actors does not scan ambient Skill roots independently. An invalid active file blocks fallback and reports both paths. Disabled Recipes cannot launch. Registry watchers converge after atomic changes without executing partial definitions.

## Validation

```bash
node scripts/validate-recipe.mjs recipes/example.json --qa
node scripts/validate-recipe.mjs recipes --all --qa --summary
```

Validation checks JSON/Markdown compilation, imports, Control, artifacts, helper paths, and platform notes. Files exceed 1 MiB or import depth 32 fail closed.

## Related

- [Command templates](./command-templates.md)
- [Runs](./async-runs.md)
- [Recipe library](./recipe-library.md)
- [Tool registry](./tool-registry.md)
