# Tool Registry

`pi-actors` stores persistent agent tools as recipe files under `~/.pi/agent/recipes/*.json` or `*.md` and registers the active tool set automatically on session start.

This document is the local adaptation of the portable [Command Template Standard](./command-templates.md) and the recipe-file runtime described in [Template Recipe Standard](./template-recipes.md).

## Registry Model

The registry source is location-discovered recipes, not a live tool-only JSON file and not recipe content flags:

- `~/.pi/agent/recipes/*.json` and `*.md` are the highest-priority user recipe root and the operator-managed tool set.
- Recipes in that root are tools by location.
- Packaged pi-actors recipes are the lower-priority standard library of declarative actor config components, not automatically registered tools.
- Ad hoc recipe files outside the user recipe root are components unless explicitly registered/copied into `~/.pi/agent/recipes`.
- Recipe identity is the filename basename; `~/.pi/agent/recipes/docs_review.json` and `docs_review.md` both have id/tool name `docs_review`.
- Same-id JSON shadows Markdown in the same priority layer.

Because the user recipe directory is sticky agent muscle memory, runtime launches update `usage.calls`, `usage.last_called`, and a content `usage.fingerprint` on user-owned recipe files. If authored recipe content changes, the next launch resets `usage.calls` and records `usage.reset_at` before counting the launch, so usage evidence follows the current recipe meaning rather than an older file history. `inspect target=recipes view=summary verbose=true` includes usage metadata and operator-gated cleanup recommendations for invalid, shadowed, disabled, component-only, unused, or overriding recipes. Recommended actions stay explicit: keep as a tool/component, enable, merge, fix, delete, or archive. The extension does not maintain a failure counter and agents should not silently clean tools during unrelated work.

`register_tool` is the preferred agent-facing mutation API. It creates, updates, and deletes recipe files in `~/.pi/agent/recipes`; agents do not need to edit the files directly for normal registration. Direct file edits are still valid for operators and advanced agents. Runtime behavior is reactive: file creation, deletion, or edits in the user recipe root trigger validation and tool-set refresh, with invalid recipes surfaced as diagnostics rather than silently ignored.

Inspect the discovered registry with:

```text
inspect target=recipes view=status
inspect target=recipes view=doctor
inspect target=recipes view=summary verbose=true
```

The summary reports active, shadowed, invalid, disabled, and diagnostic entries so operators can answer why a tool is present, hidden, broken, or disabled. The doctor view keeps the same registry evidence but promotes an advisory action surface: compact output includes the highest-priority `top` remediation plus ordered actions for invalid/blocking, disabled, risky shell-boundary, and shadowed recipes. Verbose inspection keeps the structured `remediations`, `top_action`, diagnostic details, and blocked lower-priority candidate paths when a broken or disabled higher-priority recipe masks a fallback.

## Registering Tools

`register_tool` is the interactive API for listing, creating, updating, or deleting persistent tools. Call it without arguments to list registered tools.

```text
register_tool name=transcribe_audio \
  description="Transcribe an audio file" \
  template="~/bin/transcribe {file:path} {lang=ru} {model:string}"
```

```text
register_tool name=call_subagent \
  description="Run pi as a non-interactive sub-agent" \
  template="pi -p --model {model} --no-tools {prompt}" args="prompt:string,model:string"
```

Use `update=true` to overwrite an existing tool. Omit `template` and co-located recipe fields during update to keep the previous execution binding.

`template` may also be a standard command-template sequence for multi-step tools. Timeout is disabled by default; add explicit positive `timeout` values when individual steps should fail closed:

```json
[
  "~/bin/tts --text {text} --out {mp3}",
  { "timeout": 300000, "template": "ffmpeg -y -i {mp3} -c:a libopus {ogg}" }
]
```

For reusable actor workflows, register a small tool whose `template` points to an existing actor recipe instead of embedding the launch graph in the tool itself:

```text
register_tool name=docs_review \
  description="Start an async docs review actor" \
  template="docs_review" \
  args="scope:path,model:string"
```

This writes or updates `~/.pi/agent/recipes/docs_review.json` with a recipe-reference template. Its location in the user recipe root makes it a tool. If the referenced recipe contains `async: true`, calling the tool starts a detached actor run and returns metadata immediately. If `async` is omitted or false, the same recipe runs foreground and returns normal tool output.

When co-location is clearer than a separate file, `register_tool` writes the recipe fields directly into the user recipe file:

```json
{
  "description": "Start an async docs review",
  "async": true,
  "args": ["scope:path", "model:string"],
  "template": "pi -p --model {model} --tools read,bash \"Review {scope}\""
}
```

This is still not a cycle: the filename is the saved definition id, `async: true` selects detached run mode, and `template` remains the executable body.

Delete a tool with `template=null`:

```text
register_tool name=call_subagent template=null
```

## Stored Shape

Tool names come from recipe filenames in `~/.pi/agent/recipes`. Recipe files define `template`; it may be an inline command template, a command-template sequence, or an async recipe body. Template entries keep `template` last, matching the command-template readability rule. The commands above persist recipe files like this:

```json
{
  "description": "Transcribe an audio file",
  "template": "~/bin/transcribe {file:path} {lang=ru} {model:string}"
}
```

```json
{
  "description": "Run pi as a non-interactive sub-agent",
  "args": ["prompt:string", "model:string"],
  "template": "pi -p --model {model} --no-tools {prompt}"
}
```

## Args and Defaults

When `args` is omitted, `pi-actors` derives tool parameters from placeholders in `template`:

```text
template="~/bin/transcribe {file:path} {lang=ru} {model:string}"
```

The optional `args` field is an explicit placeholder declaration, matching the command-template standard. Untyped declarations remain valid:

```json
{ "args": ["file", "lang"] }
```

Typed declarations are progressive and compact; they improve generated tool schemas and runtime validation without requiring authors to write JSON Schema. Types can be declared either in `args` or directly on template placeholders.

Use the metadata-first style when the command line is long and readability benefits from keeping the executable string short:

```json
{
  "args": [
    "file:path",
    "out_dir:path",
    "request_timeout:int",
    "speed:number",
    "dry_run:bool",
    "mode:enum(check,fix)"
  ],
  "defaults": {
    "timeout": "60000",
    "speed": "1.5",
    "dry_run": "true",
    "mode": "check"
  },
  "template": "tool --file {file} --out {out_dir} --timeout {request_timeout} --speed {speed} --dry-run {dry_run} --mode {mode}"
}
```

Use the inline-first style when a compact tool is clearer as one self-contained template:

```text
template="tool --file {file:path} --out {out_dir:path} --timeout {request_timeout:int=60000} --speed {speed:number=1.5} --dry-run {dry_run:bool=true} --mode {mode:enum(check,fix)=check}"
```

Supported compact types are `string` (implicit), `path`, `int`, `number`, `bool`, and `enum(a,b)`. Defaults should be stored in `defaults`, written inline as `{name=default}`, or supplied through interactive shorthand. Shorthand such as `args="file,lang=ru"` and typed shorthand such as `request_timeout:int=60000` are normalized before persistence. When both `args` and template placeholders provide a type for the same name, explicit `args` wins.

Defaults are applied before substitution, with resolution order runtime values → stored `defaults` → inline default → error. Missing required values are rejected before or during execution. Typed runtime values are normalized before substitution: `int` and `number` values become numeric strings, booleans become `true`/`false`, and enums must match one of the declared values.

When typed normalization or template value resolution fails at runtime, the tool error includes a compact usage hint:

```text
Invalid arguments for tool "check_tool": Argument mode must be one of: check, fix.

Expected call shape for check_tool:
check_tool({
  "file": "<file>",
  "mode": "check"
})
Required: file
Optional: mode
```

Template recipe tools derive public arguments from the referenced or co-located command template when the recipe is available locally. Explicit `args` is still available when the public tool surface should be narrower or defaulted differently, or when a file-backed recipe is not available during registration. Runtime values are passed as `values`; async recipe tools also accept optional `run_id` to override the generated run id.

## File Argument Naming

For tools that accept a local file path, use `file` as the canonical argument name.

Avoid using `filename` for full paths. `filename` usually means a basename/display name, while `file` can represent a concrete local file path.
