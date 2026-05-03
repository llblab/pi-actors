# Tool Registry

`pi-auto-tools` stores registered command-template tools in `~/.pi/agent/auto-tools.json` and registers them automatically on session start.

This document is the local adaptation of the portable [Command Template Standard](./command-templates.md).

## Registering Tools

`register_tool` is the interactive API for creating, updating, or deleting persistent tools.

```text
register_tool name=transcribe_groq \
  description="Transcribe audio files using Groq Whisper API" \
  template="~/.pi/agent/skills/groq-stt/scripts/transcribe.sh {file} {lang} {model}" \
  args="file,lang=ru,model=whisper-large-v3-turbo"
```

```text
register_tool name=call_subagent \
  description="Run pi as a non-interactive sub-agent" \
  template="pi -p --model {model} --no-tools {prompt}" \
  args="prompt,model=openai-codex/gpt-5.5"
```

Use `update=true` to overwrite an existing tool. Omit `template` during update to keep the previous template.

Delete a tool with `template=null`:

```text
register_tool name=call_subagent template=null
```

## Stored Shape

The commands above persist entries like this:

```json
{
  "transcribe_groq": {
    "name": "transcribe_groq",
    "description": "Transcribe audio files using Groq Whisper API",
    "template": "~/.pi/agent/skills/groq-stt/scripts/transcribe.mjs {file} {lang} {model}",
    "args": ["file", "lang", "model"],
    "defaults": {
      "lang": "ru",
      "model": "whisper-large-v3-turbo"
    }
  },
  "call_subagent": {
    "name": "call_subagent",
    "description": "Run pi as a non-interactive sub-agent",
    "template": "pi -p --model {model} --no-tools {prompt}",
    "args": ["prompt", "model"],
    "defaults": {
      "model": "openai-codex/gpt-5.5"
    }
  }
}
```

## Args and Defaults

Every declared arg creates one placeholder with the same normalized name:

```text
args="file,lang=ru,model=whisper-large-v3-turbo"
template="~/bin/transcribe {file} {lang} {model}"
```

Defaults are applied before substitution. Missing required values are rejected by the generated tool schema before execution.

## File Argument Naming

For tools that accept a local file path, use `file` as the canonical argument name.

Avoid using `filename` for full paths. `filename` usually means a basename/display name, while `file` can represent a concrete local file path.
