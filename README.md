# pi-auto-tools

Persistent template-backed tool registry extension for the pi coding agent.

## Start Here

- [Project Context](./AGENTS.md)
- [Open Backlog](./BACKLOG.md)
- [Changelog](./CHANGELOG.md)
- [Documentation](./docs/README.md)

## Key Features

- **Commands Become Capabilities**: Turns stable local workflows into semantic agent tools, so the agent chooses what it can do instead of reconstructing how to run shell commands.
- **Persistent Tool Registry**: Stores tool definitions in `~/.pi/agent/auto-tools.json` and registers them automatically on session start.
- **Compact Semantic Interface**: Exposes short tool names, descriptions, named args, and defaults instead of long paths, positional command-arg order, and repeated command boilerplate.
- **Safer Local Automation**: Wraps trusted command templates as narrow tools using split-first command-arg construction, placeholder substitution, and no shell evaluation.
- **Reusable Building Blocks**: Makes skill scripts, sub-agent wrappers, diagnostics, and project workflows available as composable agent capabilities.
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

### Local command: transcription

`pi-auto-tools` is useful for exposing stable local commands as normal tools. For example, register an STT command:

```text
register_tool name=transcribe \
  description="Transcribe a local audio file" \
  template="/path/to/stt --file {file} --lang {lang=ru}"
```

### Sub-agent

```text
register_tool name=call_subagent \
  description="Run pi as a non-interactive sub-agent" \
  template="pi -p --model {model=openai-codex/gpt-5.5} --no-tools {prompt}"
```

Use `update=true` to overwrite an existing tool. Omit `template` during update to keep the previous template:

```text
register_tool name=call_subagent \
  description="Run a focused pi sub-agent without tools" \
  update=true
```

Delete a tool:

```text
register_tool name=call_subagent template=null
```

## Resulting Config

The commands above persist entries like this in `~/.pi/agent/auto-tools.json`; tool names come from the top-level keys:

```json
{
  "transcribe": {
    "description": "Transcribe a local audio file",
    "template": "/path/to/stt --file {file} --lang {lang=ru}"
  },
  "call_subagent": {
    "description": "Run pi as a non-interactive sub-agent",
    "template": "pi -p --model {model=openai-codex/gpt-5.5} --no-tools {prompt}"
  }
}
```

This file is the durable registry. `register_tool` is the interactive API; `auto-tools.json` is the persisted state that is loaded on future sessions.

## Runtime Contract

- Tool names are normalized to snake_case.
- Reserved built-in names are blocked.
- Templates are split into shell-like words first, then placeholders are substituted per command arg.
- Tool args are derived from placeholders when `args` is omitted.
- `{arg=default}` inline defaults resolve after runtime values and stored `defaults`.
- `template: [...]` sequences execute left to right; each successful step passes stdout to the next step on stdin.
- Non-critical composition step failures continue with empty stdin; `critical: true` aborts the sequence.
- `retry` retries a step immediately on non-zero exit; default attempts is `1`.
- Commands execute directly without shell evaluation.
- Use `{file}` as the canonical local file path arg.
- Stored `script` entries are rejected with migration guidance.

See [`docs/command-templates.md`](./docs/command-templates.md) for the portable command-template contract and [`docs/tool-registry.md`](./docs/tool-registry.md) for the registry storage shape.

## Notes

- Only register trusted local commands. Registered tools run with the same system permissions as pi.
- `index.ts` is a small composition root; reusable behavior lives in flat `/lib` domains covered by focused tests.

## License

MIT
