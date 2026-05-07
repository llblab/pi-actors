# Tool Registry

`pi-auto-tools` stores registered command-template tools in `~/.pi/agent/auto-tools.json` and registers them automatically on session start.

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

Use `update=true` to overwrite an existing tool. Omit `template` during update to keep the previous template.

`template` may also be a standard command-template sequence for multi-step tools. Long-running agent calls should set explicit `timeout` values because the command-template default is 30 seconds:

```json
[
  "~/bin/tts --text {text} --out {mp3}",
  { "timeout": 30000, "template": "ffmpeg -y -i {mp3} -c:a libopus {ogg}" }
]
```

Delete a tool with `template=null`:

```text
register_tool name=call_subagent template=null
```

## Stored Shape

Tool names come from the top-level registry keys. Tool entries keep `template` last, matching the command-template readability rule. The commands above persist entries like this:

```json
{
  "transcribe_groq": {
    "description": "Transcribe audio files using Groq Whisper API",
    "template": "~/.pi/agent/skills/groq-stt/scripts/transcribe.mjs {file} {lang=ru} {model=whisper-large-v3-turbo}"
  },
  "call_subagent": {
    "description": "Run pi as a non-interactive sub-agent",
    "template": "pi -p --model {model=openai-codex/gpt-5.5} --no-tools {prompt}"
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

## File Argument Naming

For tools that accept a local file path, use `file` as the canonical argument name.

Avoid using `filename` for full paths. `filename` usually means a basename/display name, while `file` can represent a concrete local file path.
