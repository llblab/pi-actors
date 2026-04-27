# pi-auto-tools

Persistent script-backed tool registry extension for the pi coding agent.

## Features

- Stores tool definitions in `~/.pi/agent/auto-tools.json`
- Registers persisted tools automatically on session start
- Wraps trusted local scripts/programs as callable pi tools
- Supports script arguments declared as comma-separated names
- Writes `auto-tools.json` atomically via temp file + rename
- Truncates large script output and saves full output to a temp file

## Install

From npm:

```bash
pi install npm:@llblab/pi-auto-tools
```

From git:

```bash
pi install git:github.com/llblab/pi-auto-tools
```

## Tool

`register_tool` registers, updates, or deletes one persistent tool.

```text
register_tool name=transcribe script=~/bin/transcribe args=file,lang \
  description="Transcribe an audio file" update=true
```

Omit `script` with `update=true` to keep the previous script while changing metadata.

Delete a tool:

```text
register_tool name=transcribe script=null
```

## Runtime

- Registered tools become callable immediately
- Tool definitions survive reloads and restarts
- Tool names are normalized to snake_case
- Reserved built-in names are blocked
- Scripts must exist and be executable

## Safety

Only register trusted local scripts. Registered tools run with the same system permissions as pi.
