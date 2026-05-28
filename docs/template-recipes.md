# Template Recipe Standard

Template recipes are saved definitions around the synchronous [Command Template Standard](./command-templates.md). JSON remains the canonical precise format; Markdown is a literate authoring format that compiles into the same recipe model.

**Meta-contract:** a recipe stores a command-template graph plus defaults and run mode. It does not create a second execution language.

**Scope:** reusable JSON/Markdown shape, recipe naming, file-backed recipes, co-located recipes, recipe-layer imports/references, call-time values, foreground execution, and the `async: true` handoff to the [Async Run Standard](./async-runs.md).

---

## Reading Model

```text
command template = execution graph
recipe          = saved JSON definition
run             = one execution instance
async: true     = run through detached lifecycle
```

A recipe wraps one command-template tree. The wrapped `template` keeps the normal command-template semantics: argv splitting, placeholders, defaults, typed args, sequence, `parallel: true`, `when`, delay, retry, failure propagation, recover cleanup, and output selection.

Layer boundary: `imports`, `{ "name": "alias" }` imported-recipe nodes, `{alias.defaults.key}` references, fallback expressions, and recipe-local ternaries are recipe-loading features. They resolve before the command-template graph runs and do not extend the portable Command Template Standard. Typed imports are recipe definitions: they expose the imported recipe's command-template-shaped metadata (`template`, `args`, `defaults`, flags, and `values`), while async-run launch fields such as `async`, `state_dir`, and `retire_when` remain lifecycle configuration for starting a run, not part of the imported execution graph.

Packaged recipes are the pi-actors recipe standard library: declarative actor config components that can be imported, launched, inspected, overridden, or composed by user recipes. Treat them as stable building blocks rather than user-local policy.

## Layer Ownership

Template-recipe standard owns:

- Saved JSON definitions around one command-template graph, plus Markdown-authored recipes that compile to that shape.
- File-backed and co-located recipe shapes.
- Recipe identity through file-backed filename or co-located tool id.
- Recipe defaults, values, imports, import references, and import-node expansion.
- Ordered named artifact declarations through `artifacts`.
- Foreground-vs-detached selection through `async: true` when invoked by a recipe-aware host.

Template-recipe standard does not own:

- How command-template nodes execute internally.
- Async state files, logs, run-local transports, status, cancellation, or observability.
- Tool registry naming, button UX, package installation, or operator-specific policy.
- Domain workflows such as swarm quorum, release policy, backlog parsing, or merge policy.

A recipe can be synchronous or asynchronous:

- Omitted or false `async`: a registered tool executes the recipe in the foreground and returns normal tool output.
- `async: true`: a registered tool starts a detached async run and returns run metadata immediately.

## Minimal Shape

Synchronous recipe:

```json
{
  "template": "npm run check:docs"
}
```

Async recipe:

```json
{
  "async": true,
  "template": "review docs/spec.md"
}
```

A file-backed recipe's id comes from its filename, not a JSON `name` field. Legacy files may still contain `name`, but loaders ignore it for identity. `template` is the command-template tree. `async: true` selects detached run mode when the recipe is invoked through a registered tool.

## Markdown Authoring

Markdown recipes use `.md` files with YAML-like frontmatter for recipe metadata and one fenced executable block for the recipe/template body. Runtime behavior comes only from frontmatter plus the fenced block; surrounding prose is advisory for humans and future recipe-context use.

````markdown
---
description: Literate docs check
args:
  - scope:path
defaults:
  scope: docs
mailbox:
  accepts:
    - control.stop
---

Human notes can explain intent, examples, or review guidance.

```template
npm run check -- {scope}
```
````

Fenced blocks marked `template`, `command-template`, `json`, or `recipe` are executable. A `template` fence stores its text as the command-template string. A JSON fence can contain either a full recipe object with `template` or a raw command-template value. Frontmatter supports the recipe metadata used by JSON recipes, including `args`, `defaults`, `imports`, `mailbox`, `artifacts`, `async`, and command-template flags. For Markdown ergonomics, `args` may be either a YAML list or a comma-separated scalar, and `defaults` may be either a YAML object or a list of `key: value` entries; both normalize to the same JSON recipe shape.

JSON remains the source-of-truth format for precise machine editing. If `<id>.json` and `<id>.md` exist in the same discovery priority layer, `<id>.json` wins and the Markdown recipe is reported as shadowed.

## Discovery Priority

Recipe priority only matters when two discovered recipes have the same filename id. The conceptual ladder from lowest to highest priority is:

1. No recipe for that id.
2. Packaged pi-actors recipe components, acting as the standard library.
3. Explicitly referenced ad hoc user recipe files located outside `~/.pi/agent/recipes`.
4. User recipe files under `~/.pi/agent/recipes/*.json` or `*.md`.

The high-priority user recipe directory is also the default tool set: recipes placed there are agent tools by location. This preserves the old advantage of a tool-only registry because listing `~/.pi/agent/recipes` shows the operator-managed tool surface. Packaged and ad hoc recipes are recipe components by default; they become tools only when copied or registered into the agent recipe root.

Higher-priority files shadow lower-priority files with the same basename. Within one priority layer, same-id JSON shadows Markdown because JSON is the canonical precise format. A highest-priority invalid recipe is still visible and blocks fallback so operators do not accidentally run packaged behavior when a user override is broken. A highest-priority recipe with `disabled: true` also blocks fallback and intentionally disables that id.

## Usage Metadata

User-owned recipes may accumulate extension-maintained usage metadata:

```json
{
  "usage": {
    "calls": 12,
    "last_called": "2026-05-22T10:30:00.000Z"
  }
}
```

The extension increments `usage.calls` and updates `usage.last_called` when it starts that concrete recipe, either through a recipe-backed tool call or a direct async recipe-file run. It also stores a content `usage.fingerprint`; if the authored recipe content changes, the next launch resets `usage.calls` before counting the new launch and records `usage.reset_at`. Agents should treat these fields as cleanup evidence, not as authored recipe contract. Packaged standard-library recipes are not mutated for usage metadata.

There is intentionally no failure counter in the recipe contract. A failed launch can reflect caller misuse, missing runtime values, or an environmental problem rather than recipe uselessness. Cleanup decisions should be explicit operator work: keep as a tool, move out of the agent recipe root to retain recipe-only memory, merge, delete, or archive.

For object form, keep `template` last. Recipe metadata comes first; executable content stays last.

## Named Artifacts

Use recipe-level `artifacts` to declare stable artifact names and paths for the whole recipe, ordered from most important to least important:

```json
{
  "args": ["report_path:path"],
  "defaults": { "report_path": "artifacts/report.md" },
  "artifacts": {
    "report": "{report_path}",
    "summary": "artifacts/summary.json"
  },
  "template": "generate-report --out {report_path}"
}
```

`output` and `artifacts` are intentionally different. `output` is the command-template primary result selector and defaults to stdout; it participates in sequence/stdin flow. `artifacts` is recipe metadata: an ordered named artifact manifest for humans, async completion messages, and downstream tooling. `stdout` remains the default command result channel and is not renamed by `artifacts`.

## Mailbox

Use recipe-level `mailbox` to document the semantic messages a recipe actor accepts and emits:

```json
{
  "mailbox": {
    "accepts": [
      "control.continue",
      "control.revise",
      "control.approve",
      "control.stop"
    ],
    "emits": ["checkpoint.needs_scope", "branch.done", "run.done"]
  }
}
```

`mailbox` is contract metadata, not transport configuration. It should name semantic message types, not transport commands, file paths, or CLI fragments. Entries may be strings or typed objects such as `{ "type": "task.assign", "requires_response": true, "summary": "Assign work" }`; inspection normalizes both forms. Acceptance contracts are advisory by default: messages outside `mailbox.accepts` produce warnings rather than hard routing failures.

## Actor Recipe Context

File-backed async recipes automatically build a bounded recipe context bundle for child LLM actor launches. The bundle is appended to child `pi -p` prompts as JSONL: each line is one recipe/context record containing filename-derived `name`, source file, role/depth, import path/alias, and the raw authored recipe JSON. The record whose command-template node launched the current child is marked with `"you_are_here": true` and path metadata.

This context is provenance, not the task instruction. The authored prompt remains authoritative; the bundle explains the recipe/composition tree that produced the launch. A child actor can use it to give advisory feedback on whether its recipe, imports, mailbox metadata, and role boundaries fit the task, without needing a separate hand-written workflow explanation. Recipes that require a minimal child prompt may opt out:

```json
{
  "async": true,
  "actor_context": false,
  "template": "pi -p --model {model} {prompt}"
}
```

`"actor_context": "off"` is equivalent. Bundle generation uses the same recipe file-size and import-depth safety limits as normal recipe loading.

## Actor Message Delivery

Recipes do not declare a second event-delivery policy. A running actor emits addressed messages such as `command.done`, `run.done`, or `checkpoint.needs_input`; the coordinator/runtime decides whether a message stays diagnostic, becomes a notification, or re-enters the agent context. This keeps recipe metadata focused on the actor contract:

```json
{
  "mailbox": {
    "accepts": ["control.kill"],
    "emits": ["command.done", "run.done", "run.failed"]
  },
  "template": "run-subtask {prompt}"
}
```

## Command-Template Flags At Recipe Top Level

Top-level command-template flags may sit beside recipe metadata such as `async`:

```json
{
  "async": true,
  "parallel": true,
  "timeout": 300000,
  "failure": "branch",
  "template": ["review-a docs/spec.md", "review-b docs/spec.md"]
}
```

Valid command-template flags include `args`, `defaults`, `parallel`, `when`, `label`, `timeout`, `delay`, `output`, `retry`, `failure`, `recover`, and `repeat`.

Timeout is disabled by default. Set a positive `timeout` when a recipe should fail closed after a bounded runtime; omit it, or set `0`, for intentionally open-ended runs that will be stopped by async cancellation, such as background audio playback.

## Valid Graph

The valid chain is:

```text
tool → template reference → recipe → run → template
```

A recipe must define `template` directly. Tool exposure comes from where the recipe is stored, so the same recipe remains transportable across user, ad hoc, and packaged roots.

A recipe may live in a file or be co-located inside a registered tool entry. Both are storage variants of the same graph.

## File-Backed Recipes

Reusable local recipes live in:

```text
~/.pi/agent/recipes/*.json
~/.pi/agent/recipes/*.md
```

Bare recipe names resolve under that directory, so `file: "review-docs"` loads:

```text
~/.pi/agent/recipes/review-docs.json
# or, when no same-id JSON file exists:
~/.pi/agent/recipes/review-docs.md
```

Call-time params override file params. `values` are merged with file values; call-time values win. If a run id is omitted for an explicit async start, the file basename becomes the default run id.

## Registered Recipe Tools

A registered tool is a recipe file exposed as an agent tool. User recipes under `~/.pi/agent/recipes/*.json` or `*.md` are tools by location; packaged/ad hoc recipes are components unless copied or registered into that user recipe root:

```json
{
  "description": "Start an async docs review actor",
  "async": true,
  "args": ["scope:path", "model:string"],
  "template": "review {scope} --model {model}"
}
```

If a tool recipe contains `async: true`, calling the tool starts a detached actor run and returns metadata. If `async` is omitted or false, calling the tool executes the recipe foreground and returns normal tool output.

## Values And Public Args

Recipe placeholders come from runtime values, recipe `defaults`, inline placeholder defaults, and registered-tool defaults.

Recipe tools derive public arguments from the referenced or co-located command template when the recipe is available locally. Explicit `args` is still available when the public tool surface should be narrower than the recipe internals.

Example: a recipe may expose a private `repo` default for an example script, while the registered public tool only asks for `file`, `volume`, and `player`.

## Recipe Imports

File-backed recipes may import other file-backed recipes at the recipe layer. Imports are resolved before the command-template graph is executed, so command-template core stays registry-free and synchronous. Recipe loading is intentionally bounded: a single recipe file larger than 1 MiB is rejected before JSON parsing, and import chains deeper than 32 are rejected before further resolution. Split very large prompts/data into explicit files or artifacts and keep recipe graphs shallow enough for operator review.

```json
{
  "name": "parent",
  "imports": {
    "prepare": "prepare-worktree.json",
    "test": {
      "from": "run-tests.json",
      "values": { "suite": "unit" }
    }
  },
  "template": [{ "name": "prepare" }, { "name": "test" }]
}
```

An import binding may be either a string recipe path/name or an object with:

- `from`: recipe path or bare recipe name. Import paths support static load-time placeholders: `{repo}` expands to the directory above the active recipe root, and `{agent}` expands to the pi agent directory. For a packaged recipe in `<repo>/recipes/name.json`, `{repo}/recipes/other.json` resolves to a sibling packaged recipe. For a user recipe in `~/.pi/agent/recipes/name.json`, `{repo}` and `{agent}` both resolve to `~/.pi/agent`. Bare names such as `utility-package-summary` resolve by recipe priority: first `~/.pi/agent/recipes`, then the importing recipe's directory, then the packaged standard library. This makes packaged recipes easy to reuse while preserving user/ad hoc overrides by filename identity.
- `defaults`: extra default values exposed through the import.
- `values`: explicit values for embedding that imported recipe.

A template node of `{ "name": "alias" }` is replaced with the imported recipe's command-template graph. Imported recipe defaults are merged with import `defaults`, import `values`, node `defaults`, and node `values`; later layers win. This lets a parent recipe embed a reusable recipe in a sequence or `parallel: true` branch without inventing a workflow language.

Async composition stays explicit: importing a recipe reuses its command-template-shaped definition. It does not start a nested async run. Put `async: true` on the parent recipe when the combined imported graph should run detached as one run with one state dir. Ephemeral coordinator recipes may declare `retire_when: "children_terminal"` as an opt-in lifecycle hint for future graceful retirement handling; persistent services and implementer loops should omit it. For agent-callable fanout, prefer public inputs such as `prompts:array` plus `repeat: "{prompts.length}"`, then select each branch value with `{prompts[index]}` instead of baking concrete prompts or file names into the reusable recipe.

```json
{
  "async": true,
  "imports": {
    "review": "review-one.json"
  },
  "parallel": true,
  "failure": "branch",
  "template": [
    { "name": "review", "values": { "scope": "README.md" } },
    { "name": "review", "values": { "scope": "docs/template-recipes.md" } }
  ]
}
```

Recipes can also read imported metadata and value containers before command-template placeholder expansion. Each import alias acts like a recipe-local variable:

```json
{
  "imports": {
    "base": {
      "from": "base.json",
      "values": { "target": "docs" }
    }
  },
  "defaults": {
    "profile": "{base.defaults.profile=safe}",
    "target": "{base.values.target}",
    "label": "{base.name}:{base.values.target}",
    "enabled_label": "{base.defaults.enabled?enabled:disabled}"
  },
  "template": "run {base.defaults.profile=safe} {base.values.target} {label}"
}
```

Supported references are:

- `{alias.name}`
- `{alias.file}`
- `{alias.defaults.key}`
- `{alias.values.key}`
- `{alias.defaults.key=fallback}` for a missing/null import value fallback.
- `{alias.values.key?truthy:falsy}` for a small recipe-layer ternary.

Nested object keys are dot-separated. Import references are resolved before normal command-template placeholders, so ordinary values such as `{label}` still flow through command-template defaults and call-time values. Ternaries use simple falsy checks for missing, null, false, zero, and empty string. Missing imports, missing values without fallback, and import cycles fail during recipe loading.

## Recipe Shape

Use the filename for file-backed recipe ids, and use `async: true` for detached runs. Use `parallel: true` for fanout, `when` for node guards, and semantic public args such as `tools`, `all`, or `timeout_ms` instead of leaking CLI fragments or reusing node-control names. Local files belong under `~/.pi/agent/recipes/*.json` or `*.md` before relying on recipe launchers.

If a proposed recipe needs a scheduler, queue daemon, `goto`, or custom workflow syntax, stop. Keep the recipe as saved command-template JSON and put policy in the registered tool, script, or caller.
