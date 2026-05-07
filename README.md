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
- **Template Jobs**: Starts detached template jobs from inline config, registered tools, or `~/.pi/agent/jobs/*.json`, with generic status, tail, list, and cancel actions backed by simple state files under `~/.pi/agent/tmp/pi-auto-tools`.
- **Job Launch Tools**: Registers lightweight tools that start reusable job recipes directly, keeping large parallel agent templates in `~/.pi/agent/jobs/*.json` while exposing a compact callable button to the agent.
- **Context Onboarding**: Injects a compact system-prompt note explaining templates, jobs, tasks, and agent fanout so installed sessions have the mental model available by default.
- **Ambient Job Observability**: Shows one stable triangle per active job sub-agent across all running jobs in the interactive status line, then injects a compact completion event when a job finishes.

## Install

From npm:

```bash
pi install npm:@llblab/pi-auto-tools
```

From git:

```bash
pi install git:github.com/llblab/pi-auto-tools
```

## Mental Model

`pi-auto-tools` has one execution idea that grows in place:

```text
command
→ command template
→ registered tool
→ template job
```

- A **command** is one concrete local process.
- A **command template** is the reusable shape of that process, with named placeholders.
- A **registered tool** gives a command template or job recipe a stable agent-facing name.
- A **template job** runs a command template detached, writes state and logs, and lets the agent return later with `status`, `tail`, or `cancel`.

The template remains the execution language. The job is the async envelope. For large agent fanout, prefer `tool → job recipe → template(mode: "parallel")`: the tool is the button, the job is the lifecycle, and the template is the execution graph. The extension also injects this compact mental model into the system prompt on each agent turn so new operators do not need to read every doc before using jobs.

## Operator Onboarding

Start with foreground templates for short deterministic work:

```text
register_tool name=lint_docs description="Lint docs" template="npm run lint:docs"
```

Move to jobs when work is long-running, parallel, or agentic:

```text
template_job action=start file=shader-ring-8-parallel
```

Use a job-backed tool when the job recipe is reusable and should feel like a normal capability:

```text
register_tool name=shader_ring_job description="Start shader ring" job="shader-ring-8-parallel" args="theme,out_dir"
```

`Task` is the user's work item. `Template` is the execution graph. `Job` is one async runtime execution with status, logs, cancellation, and ambient triangles.

## Register Tools

`register_tool` lists, registers, updates, or deletes persistent tools. Call it without arguments to list the current registry.

### Local command: transcription

`pi-auto-tools` is useful for exposing stable local commands as normal tools. For example, register an STT command:

```text
register_tool name=transcribe \
  description="Transcribe a local audio file" \
  template="/path/to/stt --file {file} --lang {lang=ru}"
```

### Job launcher

For long-running agentic work, keep the large parallel template in a reusable job recipe and register a small launcher tool:

```text
register_tool name=shader_ring_job \
  description="Start the shader ring job" \
  job="shader-ring-8-parallel" \
  args="theme,out_dir"
```

Calling `shader_ring_job` starts `~/.pi/agent/jobs/shader-ring-8-parallel.json` as a detached template job. Job-backed tools return job metadata immediately and accept optional `job_id` to override the generated run id.

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

The commands above persist entries like this in `~/.pi/agent/auto-tools.json`; tool names come from the top-level keys. Stored entries keep `template` last so flags and metadata are read before executable content:

```json
{
  "transcribe": {
    "description": "Transcribe a local audio file",
    "template": "/path/to/stt --file {file} --lang {lang=ru}"
  },
  "call_subagent": {
    "description": "Run pi as a non-interactive sub-agent",
    "template": "pi -p --model {model=openai-codex/gpt-5.5} --no-tools {prompt}"
  },
  "shader_ring_job": {
    "description": "Start the shader ring job",
    "args": ["theme", "out_dir"],
    "job": "shader-ring-8-parallel"
  }
}
```

This file is the durable registry. `register_tool` is the interactive API; `auto-tools.json` is the persisted state that is loaded on future sessions.

## Run Template Jobs

Use `template_job` when a command template may outlive the current turn. It starts the work now, returns immediately with state metadata, and keeps ordinary files under `~/.pi/agent/tmp/pi-auto-tools/jobs/<job>` for later inspection.

Start from an inline template:

```json
{
  "action": "start",
  "job": "docs-review",
  "template": "pi -p --model openai-codex/gpt-5.5 --no-tools {prompt}",
  "values": {
    "prompt": "Review docs/spec.md for contradictions."
  }
}
```

Check it later:

```json
{ "action": "status", "job": "docs-review" }
```

Read recent events or logs:

```json
{ "action": "tail", "job": "docs-review", "lines": "80" }
```

Reusable local recipes live in `~/.pi/agent/jobs/*.json` and can be started with `action=start` plus `file`. The package does not ship root-level job examples because model names, tool names, and review policy are local operator choices.

## Runtime Contract

- Tool names are normalized to snake_case.
- Reserved built-in names are blocked.
- Templates are split into shell-like words first, then placeholders are substituted per command arg.
- Tool args are derived from placeholders when `args` is omitted.
- `{arg=default}` inline defaults resolve after runtime values and stored `defaults`.
- `template: [...]` sequences execute left to right; each successful step passes stdout to the next step on stdin.
- Object nodes may set `mode: "parallel"`; children receive the same stdin and joined stdout flows to the next sequence step.
- Parallel nodes use soft-quorum semantics: non-critical branch failures are reported as degraded coverage, not treated as total failure.
- For long-running agentic fanout, prefer wrapping the parallel template in `template_job` so async lifecycle and ambient sub-agent status remain visible.
- Long-running agent branches should set explicit `timeout` values above the 30s default.
- Nodes may set `delay` in milliseconds to wait before launch; delay is not inherited.
- Non-critical composition step failures continue with empty stdin; `critical: true` aborts the sequence.
- `retry` retries a step immediately on non-zero exit; default attempts is `1`.
- Commands execute directly without shell evaluation.
- `template_job` provides a minimal template job envelope around the same command-template contract.
- `template_job` uses `action: start | status | tail | list | cancel`.
- `template_job action=start` can run a template job JSON `file`, an inline `template`, or a registered auto-tool by `tool` name.
- Registered tools may use `job` instead of `template`; calling them starts the named job recipe asynchronously and returns job metadata.
- Interactive sessions show ambient job sub-agent activity as stable `▷` triangles aggregated across all running jobs, with one moving `▶` wave over the active set; terminal job events are delivered as compact follow-up context so the agent can inspect or react.
- Use `{file}` as the canonical local file path arg.
- Stored `script` entries are rejected with migration guidance.

See [`docs/command-templates.md`](./docs/command-templates.md) for the portable command template, template job, and temp-directory contract; [`docs/job-primitives.md`](./docs/job-primitives.md) for the pi-auto-tools job adapter; and [`docs/tool-registry.md`](./docs/tool-registry.md) for the registry storage shape.

## Notes

- Only register trusted local commands. Registered tools run with the same system permissions as pi.
- `index.ts` is a small composition root; reusable behavior lives in flat `/lib` domains covered by focused tests.

## License

MIT
