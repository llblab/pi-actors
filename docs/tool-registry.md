# Tool Registry

`pi-auto-tools` stores registered command-template and job-launch tools in `~/.pi/agent/auto-tools.json` and registers them automatically on session start.

This document is the local adaptation of the portable [Command Template Standard](./command-templates.md).

## Registering Tools

`register_tool` is the interactive API for listing, creating, updating, or deleting persistent tools. Call it without arguments to list registered auto-tools.

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

Use `update=true` to overwrite an existing tool. Omit `template` and co-located job fields during update to keep the previous execution binding.

`template` may also be a standard command-template sequence for multi-step tools. Long-running agent calls should set explicit `timeout` values because the command-template default is 30 seconds:

```json
[
  "~/bin/tts --text {text} --out {mp3}",
  { "timeout": 30000, "template": "ffmpeg -y -i {mp3} -c:a libopus {ogg}" }
]
```

For long-running agentic work, register a small tool whose `template` points to a reusable job recipe instead of embedding a large parallel template in the tool itself:

```text
register_tool name=shader_ring_job \
  description="Start the shader ring job" \
  template="shader-ring-8-parallel.json" \
  args="theme,out_dir"
```

This stores the job recipe path in the registry as `template`. Calling the tool follows `tool → template → job → template`: it starts `~/.pi/agent/jobs/shader-ring-8-parallel.json` through the template-job runtime, and the job file supplies the executable template. The call returns job metadata immediately.

When co-location is clearer than a separate file, the registry entry may include job envelope fields directly beside tool metadata:

```json
{
  "review_docs": {
    "description": "Start an async docs review",
    "job": "review-docs",
    "template": "pi -p --model openai-codex/gpt-5.5 --tools read,bash \"Review {scope}\""
  }
}
```

This is still not a cycle: `job` names the async run envelope, and `template` remains the executable body. Co-located job entries must not define `tool`.

Delete a tool with `template=null`:

```text
register_tool name=call_subagent template=null
```

## Stored Shape

Tool names come from the top-level registry keys. Tool entries define `template`; it may be an inline command template, a job recipe JSON path/name, or the body of a co-located job recipe when `job` is also present. Template entries keep `template` last, matching the command-template readability rule. The commands above persist entries like this:

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
  "shader_ring_job": {
    "description": "Start the shader ring job",
    "args": ["theme", "out_dir"],
    "template": "shader-ring-8-parallel.json"
  }
}
```

## Args and Defaults

When `args` is omitted, `pi-auto-tools` derives tool parameters from placeholders in `template`:

```text
template="~/bin/transcribe {file} {lang=ru} {model=whisper-large-v3-turbo}"
```

The optional `args` field is only an explicit placeholder declaration, matching the command-template standard. Defaults should be stored in `defaults` or written inline as `{name=default}`; legacy interactive shorthand such as `args="file,lang=ru"` is normalized before persistence.

Defaults are applied before substitution, with resolution order runtime values → stored `defaults` → inline default → error. Missing required values are rejected before or during execution.

Job recipe tools derive public arguments from the referenced or co-located command template when the job recipe is available locally. Explicit `args` is still available when the public tool surface should be narrower or defaulted differently, or when a file-backed recipe is not available during registration. Runtime values are passed to the job as `values`. Every job recipe tool also accepts optional `job_id` to override the generated run id.

## File Argument Naming

For tools that accept a local file path, use `file` as the canonical argument name.

Avoid using `filename` for full paths. `filename` usually means a basename/display name, while `file` can represent a concrete local file path.
