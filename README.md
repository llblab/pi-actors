# pi-auto-tools

Persistent template-backed tool registry extension for the pi coding agent.

## Start Here

- [Project Context](./AGENTS.md)
- [Open Backlog](./BACKLOG.md)
- [Changelog](./CHANGELOG.md)
- [Documentation](./docs/README.md)

## Key Features

- **Persistent Tools**: Stores tool definitions in `~/.pi/agent/auto-tools.json` and registers them automatically on session start.
- **Command Templates**: Wraps trusted local commands as callable pi tools using split-first argv construction, placeholder substitution, and no shell evaluation.
- **Skill Scripts as Tools**: Registers scripts from agent skills, such as STT/TTS helpers, as ordinary agent tools.
- **Named Defaults**: Declares tool args as comma-separated names with optional defaults, e.g. `file,lang=ru,model=voxtral-mini-latest`.
- **Immediate Updates**: Registered and updated tools become callable in the active session; deleted tools are removed from active tools and fully disappear after reload.
- **Bounded Output**: Tool stdout is returned to the agent with truncation safeguards; full oversized output is saved to a temp file.

## Install

From npm:

```bash
pi install npm:@llblab/pi-auto-tools
```

From git:

```bash
pi install git:github.com/llblab/pi-auto-tools
```

## Register Tools

`register_tool` registers, updates, or deletes one persistent tool.

### Skill script: transcription

`pi-auto-tools` is useful for exposing scripts from agent skills as normal tools. For example, register a Groq STT skill script:

```text
register_tool name=transcribe_groq \
  description="Transcribe audio files using Groq Whisper API" \
  template="~/.agents/skills/groq-stt/scripts/transcribe.sh {file} {lang} {model}" \
  args="file,lang=ru,model=whisper-large-v3-turbo"
```

### Sub-agent

```text
register_tool name=call_subagent \
  description="Run pi as a non-interactive sub-agent" \
  template="pi -p --model {model} --no-tools {prompt}" \
  args="prompt,model=openai-codex/gpt-5.5"
```

Use `update=true` to overwrite an existing tool. Omit `template` during update to keep the previous template:

```text
register_tool name=call_subagent \
  description="Run a focused pi sub-agent without tools" \
  args="prompt,model=openai-codex/gpt-5.5" \
  update=true
```

Delete a tool:

```text
register_tool name=call_subagent template=null
```

## Resulting Config

The commands above persist entries like this in `~/.pi/agent/auto-tools.json`:

```json
{
  "transcribe_groq": {
    "name": "transcribe_groq",
    "description": "Transcribe audio files using Groq Whisper API",
    "template": "~/.agents/skills/groq-stt/scripts/transcribe.sh {file} {lang} {model}",
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

This file is the durable registry. `register_tool` is the interactive API; `auto-tools.json` is the persisted state that is loaded on future sessions.

## Runtime Contract

- Tool names are normalized to snake_case.
- Reserved built-in names are blocked.
- Templates are split into shell-like words first, then placeholders are substituted per argv token.
- Commands execute through `pi.exec` without shell evaluation.
- For local file path args, prefer `{file}` over ambiguous `{filename}`.
- Stored `script` entries are rejected with migration guidance.

See [`docs/command-templates.md`](./docs/command-templates.md) for the full command-template contract.

## Notes

- Only register trusted local commands. Registered tools run with the same system permissions as pi.
- `index.ts` is a small composition root; reusable behavior lives in flat `/lib` domains covered by focused tests.

## License

MIT
