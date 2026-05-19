# Template Recipe Standard

Template recipes are saved JSON definitions around the synchronous [Command Template Standard](./command-templates.md).

**Meta-contract:** a recipe stores a command-template graph plus defaults and run mode. It does not create a second execution language.

**Scope:** reusable JSON shape, recipe naming, file-backed recipes, co-located recipes, recipe-layer imports/references, call-time values, foreground execution, and the `async: true` handoff to the [Async Run Standard](./async-runs.md).

---

## Reading Model

```text
command template = execution graph
recipe          = saved JSON definition
run             = one execution instance
async: true     = run through detached lifecycle
```

A recipe wraps one command-template tree. The wrapped `template` keeps the normal command-template semantics: argv splitting, placeholders, defaults, typed args, sequence, `parallel: true`, `when`, delay, retry, failure propagation, recover cleanup, and output selection.

Layer boundary: `imports`, `{ "name": "alias" }` imported-recipe nodes, `{alias.defaults.key}` references, fallback expressions, and recipe-local ternaries are recipe-loading features. They resolve before the command-template graph runs and do not extend the portable Command Template Standard. Typed imports are recipe definitions: they expose the imported recipe's command-template-shaped metadata (`template`, `args`, `defaults`, flags, and `values`), while async-run launch fields such as `async` and `state_dir` remain lifecycle configuration for starting a run, not part of the imported execution graph.

## Layer Ownership

Template-recipe standard owns:

- Saved JSON definitions around one command-template graph.
- File-backed and co-located recipe shapes.
- Recipe identity through `name` or filename.
- Recipe defaults, values, imports, import references, and import-node expansion.
- Ordered named artifact declarations through `artifacts`.
- Foreground-vs-detached selection through `async: true` when invoked by a recipe-aware host.

Template-recipe standard does not own:

- How command-template nodes execute internally.
- Async state files, logs, FIFO, status, cancellation, or observability.
- Tool registry naming, button UX, package installation, or operator-specific policy.
- Domain workflows such as swarm quorum, release policy, backlog parsing, or merge policy.

A recipe can be synchronous or asynchronous:

- Omitted or false `async`: a registered tool executes the recipe in the foreground and returns normal tool output.
- `async: true`: a registered tool starts a detached async run and returns run metadata immediately.

## Minimal Shape

Synchronous recipe:

```json
{
  "name": "check-docs",
  "template": "npm run check:docs"
}
```

Async recipe:

```json
{
  "name": "review-docs",
  "async": true,
  "template": "review docs/spec.md"
}
```

`name` names the saved definition when an explicit name is needed. File-backed recipes usually omit it because the filename is the canonical recipe id. `template` is the command-template tree. `async: true` selects detached run mode when the recipe is invoked through a registered tool.

For object form, keep `template` last. Recipe metadata comes first; executable content stays last.

## Named Artifacts

Use recipe-level `artifacts` to declare stable artifact names and paths for the whole recipe, ordered from most important to least important:

```json
{
  "name": "report-task",
  "args": ["report_path:path"],
  "defaults": { "report_path": "artifacts/report.md" },
  "artifacts": {
    "report": "{report_path}",
    "summary": "artifacts/summary.json"
  },
  "template": "generate-report --out {report_path}"
}
```

`output` and `artifacts` are intentionally different. `output` is the command-template primary result selector and defaults to stdout; it participates in sequence/stdin flow. `artifacts` is recipe metadata: an ordered named artifact manifest for humans, async completion events, and downstream tooling. `stdout` remains the default command result channel and is not renamed by `artifacts`.

## Mailbox

Use recipe-level `mailbox` to document the semantic messages a recipe actor accepts and emits:

```json
{
  "mailbox": {
    "accepts": ["control.continue", "control.revise", "control.approve", "control.stop"],
    "emits": ["checkpoint.needs_scope", "branch.done", "run.done"]
  }
}
```

`mailbox` is contract metadata, not transport configuration. It should name semantic message types, not FIFO commands, file paths, or CLI fragments.

## Actor Message Delivery

Recipes do not declare a second event-delivery policy. A running actor emits addressed messages such as `command.done`, `run.done`, or `checkpoint.needs_input`; the coordinator/runtime decides whether a message stays diagnostic, becomes a notification, or re-enters the agent context. This keeps recipe metadata focused on the actor contract:

```json
{
  "mailbox": {
    "accepts": ["control.stop"],
    "emits": ["command.done", "run.done", "run.failed"]
  },
  "template": "run-subtask {prompt}"
}
```

## Command-Template Flags At Recipe Top Level

Top-level command-template flags may sit beside `name` and `async`:

```json
{
  "name": "review-docs",
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

A recipe must define `template` directly. A recipe must not define `tool`, because recipes are saved command-template definitions, not tool indirection layers.

A recipe may live in a file or be co-located inside a registered tool entry. Both are storage variants of the same graph.

## File-Backed Recipes

Reusable local recipes live in:

```text
~/.pi/agent/recipes/*.json
```

Bare recipe names resolve under that directory, so `file: "review-docs"` loads:

```text
~/.pi/agent/recipes/review-docs.json
```

Call-time params override file params. `values` are merged with file values; call-time values win. If a run id is omitted for an explicit async start, the explicit recipe `name` or file basename becomes the default run id.

## Registered Recipe Tools

A registered tool can point at an actor recipe by storing the recipe path or name in `template`:

```json
{
  "shader_ring": {
    "description": "Start the shader ring recipe",
    "args": ["theme", "out_dir"],
    "template": "shader-ring-8-parallel.json"
  }
}
```

If `shader-ring-8-parallel.json` contains `async: true`, calling `shader_ring` starts a detached run and returns metadata. If `async` is omitted or false, calling `shader_ring` executes the recipe foreground and returns normal tool output.

A registered tool may also co-locate an actor recipe directly in `tools.json`:

```json
{
  "review_docs": {
    "description": "Start an async docs review",
    "name": "review-docs",
    "async": true,
    "template": "review {scope}"
  }
}
```

The co-located entry must still own `template` directly and must not define `tool`.

## Values And Public Args

Recipe placeholders come from runtime values, recipe `defaults`, inline placeholder defaults, and registered-tool defaults.

Recipe tools derive public arguments from the referenced or co-located command template when the recipe is available locally. Explicit `args` is still available when the public tool surface should be narrower than the recipe internals.

Example: a recipe may expose a private `repo` default for an example script, while the registered public tool only asks for `file`, `volume`, and `player`.

## Recipe Imports

File-backed recipes may import other file-backed recipes at the recipe layer. Imports are resolved before the command-template graph is executed, so command-template core stays registry-free and synchronous.

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

- `from`: recipe path or bare name.
- `defaults`: extra default values exposed through the import.
- `values`: explicit values for embedding that imported recipe.

A template node of `{ "name": "alias" }` is replaced with the imported recipe's command-template graph. Imported recipe defaults are merged with import `defaults`, import `values`, node `defaults`, and node `values`; later layers win. This lets a parent recipe embed a reusable recipe in a sequence or `parallel: true` branch without inventing a workflow language.

Async composition stays explicit: importing a recipe reuses its command-template-shaped definition. It does not start a nested async run. Put `async: true` on the parent recipe when the combined imported graph should run detached as one run with one state dir. For agent-callable fanout, prefer public inputs such as `prompts:array` plus `repeat: "{prompts.length}"`, then select each branch value with `{prompts[index]}` instead of baking concrete prompts or file names into the reusable recipe.

```json
{
  "name": "parallel-review",
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

Use `name` for an explicit recipe id, rely on the filename for file-backed recipe ids, and use `async: true` for detached runs. Use `parallel: true` for fanout, `when` for node guards, and semantic public args such as `tools`, `all`, or `timeout_ms` instead of leaking CLI fragments or reusing node-control names. Local files belong under `~/.pi/agent/recipes/*.json` before relying on recipe launchers.

If a proposed recipe needs a scheduler, queue daemon, `goto`, or custom workflow syntax, stop. Keep the recipe as saved command-template JSON and put policy in the registered tool, script, or caller.
