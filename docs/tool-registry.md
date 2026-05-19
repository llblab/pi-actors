# Tool Registry

`pi-actors` stores registered actor-control command-template tools and template-recipe launchers in `~/.pi/agent/actors-tools.json` and registers them automatically on session start.

This document is the local adaptation of the portable [Command Template Standard](./command-templates.md).

## Rename Migration

`pi-actors` reads only `~/.pi/agent/actors-tools.json` as its registry source. When moving from `pi-auto-tools`, copy the previous registry explicitly:

```bash
cp ~/.pi/agent/auto-tools.json ~/.pi/agent/actors-tools.json
```

If a short-lived `~/.pi/agent/tools.json` file exists from the early `pi-actors` rename window, copy that file instead:

```bash
cp ~/.pi/agent/tools.json ~/.pi/agent/actors-tools.json
```

No automatic rewrite is performed so operators can decide when to retire old config files.

## Registering Tools

`register_tool` is the interactive API for listing, creating, updating, or deleting persistent tools. Call it without arguments to list registered tools.

```text
register_tool name=transcribe_groq \
  description="Transcribe audio files using Groq Whisper API" \
  template="~/.pi/agent/skills/groq-stt/scripts/transcribe.mjs {file} {lang=ru} {model=whisper-large-v3-turbo}"
```

```text
register_tool name=call_subagent \
  description="Run pi as a non-interactive sub-agent" \
  template="pi -p --model {model=openai-codex/gpt-5.5} --no-tools {prompt}"
```

Use `update=true` to overwrite an existing tool. Omit `template` and co-located recipe fields during update to keep the previous execution binding.

`template` may also be a standard command-template sequence for multi-step tools. Timeout is disabled by default; add explicit positive `timeout` values when individual steps should fail closed:

```json
[
  "~/bin/tts --text {text} --out {mp3}",
  { "timeout": 300000, "template": "ffmpeg -y -i {mp3} -c:a libopus {ogg}" }
]
```

For reusable actor workflows, register a small tool whose `template` points to an actor recipe instead of embedding the launch graph in the tool itself:

```text
register_tool name=docs_review \
  description="Start an async docs review actor" \
  template="docs-review.json" \
  args="scope:path,model:string=openai-codex/gpt-5.5"
```

This stores the recipe path in the registry as `template`. If `~/.pi/agent/recipes/docs-review.json` contains `async: true`, calling the tool starts a detached actor run and returns metadata immediately. If `async` is omitted or false, the same recipe runs foreground and returns normal tool output.

When co-location is clearer than a separate file, the registry entry may include recipe fields directly beside tool metadata:

```json
{
  "review_docs": {
    "description": "Start an async docs review",
    "name": "review-docs",
    "async": true,
    "template": "pi -p --model openai-codex/gpt-5.5 --tools read,bash \"Review {scope}\""
  }
}
```

This is still not a cycle: `name` names the saved definition when it differs from the tool key, `async: true` selects detached run mode, and `template` remains the executable body. Co-located recipe entries must not define `tool`.

Delete a tool with `template=null`:

```text
register_tool name=call_subagent template=null
```

## Stored Shape

Tool names come from the top-level registry keys. Tool entries define `template`; it may be an inline command template, a template recipe JSON path/name, or the body of a co-located template recipe when `async` or entry-local `name` is present. Template entries keep `template` last, matching the command-template readability rule. The commands above persist entries like this:

```json
{
  "transcribe_groq": {
    "description": "Transcribe audio files using Groq Whisper API",
    "template": "~/.pi/agent/skills/groq-stt/scripts/transcribe.mjs {file} {lang=ru} {model=whisper-large-v3-turbo}"
  },
  "call_subagent": {
    "description": "Run pi as a non-interactive sub-agent",
    "template": "pi -p --model {model=openai-codex/gpt-5.5} --no-tools {prompt}"
  },
  "docs_review": {
    "description": "Start an async docs review actor",
    "args": ["scope:path", "model:string=openai-codex/gpt-5.5"],
    "template": "docs-review.json"
  }
}
```

## Args and Defaults

When `args` is omitted, `pi-actors` derives tool parameters from placeholders in `template`:

```text
template="~/bin/transcribe {file} {lang=ru} {model=whisper-large-v3-turbo}"
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
