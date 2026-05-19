# pi-actors

Actor runtime and persistent local tool registry extension for the pi coding agent.

`pi-actors` is a local-first, cybernetic actor layer for agents. It is MCP-adjacent in spirit, but instead of waiting for external servers to define every capability, the agent can turn trusted local commands, scripts, and recipes into durable tools itself. Those tools persist across reloads as a kind of operational muscle memory: short semantic names, typed args, reusable recipes, and async runs replace repeated shell reconstruction.

## Start Here

- [Project Context](./AGENTS.md)
- [Open Backlog](./BACKLOG.md)
- [Changelog](./CHANGELOG.md)
- [Documentation](./docs/README.md)

## Key Features

- **Local-First Tool Memory**: Lets agents create and persist their own trusted local tools, forming durable operational muscle memory instead of one-off shell commands.
- **Commands Become Capabilities**: Turns stable local workflows into semantic agent tools, so the agent chooses what it can do instead of reconstructing how to run shell commands.
- **Actor Tool Registry**: Stores actor-control tool definitions in `~/.pi/agent/actors-tools.json` and registers them automatically on session start.
- **Compact Semantic Interface**: Exposes short tool names, descriptions, named args, and defaults instead of long paths, positional command-arg order, and repeated command boilerplate.
- **Safer Local Automation**: Wraps trusted command templates as narrow tools using split-first command-arg construction, placeholder substitution, and no shell evaluation.
- **Reusable Building Blocks**: Makes skill scripts, sub-agent wrappers, diagnostics, and project workflows available as composable agent capabilities.
- **Immediate Updates**: Registered and updated tools become callable in the active session; deleted tools are removed from active tools and fully disappear after reload.
- **Bounded Output**: Tool stdout is returned to the agent with truncation safeguards; full oversized output is saved to a temp file.
- **Template Recipes**: Stores reusable command-template JSON under `~/.pi/agent/recipes/*.json`; recipes can import other recipes, reuse defaults, declare ordered named `artifacts`, and run foreground or declare `async: true` for detached lifecycle.
- **Actor Runs**: Starts detached recipe or inline-template runs as addressable actors backed by state files under `~/.pi/agent/tmp/pi-actors`.
- **Context Onboarding**: Injects a compact system-prompt note explaining templates, recipes, async runs, tasks, and agent fanout so installed sessions have the mental model available by default.
- **Coordinator-Scoped Run Observability**: Shows at least one stable triangle per running async run started by the current agent session, adds triangles for active parallel branches, then injects compact completion events only back to the launching coordinator when attention is needed.

## Install

From npm:

```bash
pi install npm:@llblab/pi-actors
```

From git:

```bash
pi install git:github.com/llblab/pi-actors
```

## Mental Model

`pi-actors` has one execution idea that grows in place:

```text
command
→ command template
→ template recipe
→ registered tool
→ async run
```

- A **command** is one concrete local process.
- A **command template** is the reusable shape of that process, with named placeholders.
- A **template recipe** is saved JSON containing a template plus defaults and run mode.
- A **registered tool** gives a command template or recipe a stable agent-facing name.
- An **async run** is one execution instance with state, logs, script-authored events, status, tail, message send, cancel, and kill.

The template remains the execution language. The recipe is saved actor configuration. `async: true` is the detached lifecycle switch. The extension injects this compact mental model into the system prompt on each agent turn, including where to look first (`README.md`, `docs/README.md`, recipe/async docs, and `recipes/`) so an agent asked to inspect pi-actors can quickly understand the model and start composing async subagents or other long-running recipes.

## Operator Onboarding

Start with foreground templates for short deterministic work:

```text
register_tool name=lint_docs description="Lint docs" template="npm run lint:docs"
```

Move to async recipes when work is long-running, parallel, or agentic:

```json
{
  "name": "shader-ring-8-parallel",
  "async": true,
  "parallel": true,
  "template": ["..."]
}
```

Expose a reusable recipe as a normal capability:

```text
register_tool name=shader_ring description="Start shader ring" template="shader-ring-8-parallel.json" args="theme,out_dir"
```

`Task` is the user's work item. `Template` is the execution graph. `Recipe` is saved JSON. `Run` is one execution instance with status, logs, cancellation, and ambient triangles.

## Compose Recipes With Imports

Recipes can import other recipe files and reuse them as named nodes. This keeps reusable steps small while letting a parent recipe decide whether the combined graph runs foreground or as one async run.

`review-one.json`:

```json
{
  "name": "review-one",
  "args": ["scope:string", "model:string"],
  "defaults": { "model": "openai-codex/gpt-5.5" },
  "template": "pi -p --model {model} --no-tools \"Review {scope}\""
}
```

`review-pair.json`:

```json
{
  "name": "review-pair",
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

Register only the parent when that is the operator-facing capability:

```text
register_tool name=review_pair \
  description="Start a parallel async docs review" \
  template="review-pair.json"
```

Imported recipes are recipe definitions, not nested async runs. The parent recipe's `async: true` creates one run with one state dir; imported recipes contribute command-template graph, args, defaults, and values.

## Register Tools

`register_tool` lists, registers, updates, or deletes persistent tools. Call it without arguments to list the current registry.

### Local command: transcription

`pi-actors` is useful for exposing stable local commands as normal tools. For example, register an STT command:

```text
register_tool name=transcribe \
  description="Transcribe a local audio file" \
  template="/path/to/stt --file {file} --lang {lang=ru}"
```

### Template recipe

For reusable workflows, keep the large template in a recipe file and register a small tool:

```text
register_tool name=shader_ring \
  description="Start the shader ring recipe" \
  template="shader-ring-8-parallel.json" \
  args="theme,out_dir"
```

If the recipe file contains `async: true`, calling `shader_ring` starts a detached run and returns metadata immediately. If `async` is omitted or false, the same recipe runs foreground and returns normal tool output.

A recipe can also be co-located in `actors-tools.json` when keeping metadata and the recipe body together is clearer:

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

A co-located recipe entry still cannot define `tool`; it must own `template` directly.

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

The commands above persist entries like this in `~/.pi/agent/actors-tools.json`; tool names come from the top-level keys. Stored entries keep `template` last so flags and metadata are read before executable content:

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
  "shader_ring": {
    "description": "Start the shader ring recipe",
    "args": ["theme", "out_dir"],
    "template": "shader-ring-8-parallel.json"
  }
}
```

This file is the durable actor-tool registry. `register_tool` is the interactive API; `actors-tools.json` is the persisted state that is loaded on future sessions.

## Manage Run Actors

Use `spawn` when a command template may outlive the current turn. It starts the work now as an addressable actor, returns immediately with state metadata, and keeps ordinary files under `~/.pi/agent/tmp/pi-actors/runs/<run>` for later inspection.

Start from an inline template as an addressable run actor:

```json
{
  "as": "run:docs-review",
  "template": "pi -p --model openai-codex/gpt-5.5 --no-tools {prompt}",
  "values": {
    "prompt": "Review docs/spec.md for contradictions."
  }
}
```

Do not check it on a timer. Let follow-up events arrive from the run, then react to a run-local request or redirect a long-lived recipe without polling/restarting it:

```json
{ "to": "run:docs-review", "type": "control.continue", "body": "continue" }
```

Read recent events or logs only after a follow-up asks for inspection, at a real decision point, or during diagnosis:

```json
{ "target": "run:docs-review", "view": "tail", "lines": "80" }
```

Reusable local recipes live in `~/.pi/agent/recipes/*.json`; recipe tools honor each file's `async` flag. Use `spawn` for explicit detached starts from a file or inline template, and `inspect target=session:<id> view=runs status=running` or `inspect target=session:all view=runs` for explicit inventory/diagnosis. List output includes `tool` and `recipe` when the launcher recorded that source context.

## Recipe Library

Packaged standard recipes live under root `recipes/` with helper scripts under root `scripts/`. They are reusable library definitions, not automatically installed operator policy.

The subagent component recipes start non-interactive pi subagents as async runs or compose component recipes into higher-level coordinator pipelines. Use the no-tools recipe for the safest default, the explicit-tool variant when a bounded tool allowlist is needed, or the prompts fanout parent recipe to see imported subagent recipe nodes composed into one async run:

```text
register_tool name=subagent_prompt \
  description="Start an async no-tools pi subagent" \
  template="subagent-prompt.json"

register_tool name=subagent_tools \
  description="Start an async pi subagent with an explicit tool allowlist" \
  template="subagent-tools.json"

register_tool name=subagents_prompts \
  description="Start parallel no-tools subagents from a prompt array as one async run" \
  template="subagents-prompts.json"

subagent_prompt prompt="Review docs/async-runs.md for unclear wording." run_id=docs-review
subagent_tools prompt="Inspect package metadata and report risks." tools="read,bash" run_id=package-review
subagents_prompts \
  prompts='["Review README.md for unclear release-onboarding wording. Return concise findings.","Review docs/template-recipes.md for unclear recipe-import wording. Return concise findings."]' \
  run_id=review-prompts
inspect target=run:review-prompts view=tail
```

The music player recipe starts a local file, URL, directory, or playlist as an async run, keeps the agent unblocked, shows the ambient triangle indicator in the launching coordinator, and can be controlled with addressed `message` calls. The standard library ships one Node.js wrapper recipe:

```text
register_tool name=music_player \
  description="Start async music player playback through the Node.js wrapper" \
  template="music-player.json" \
  args="source:string,loop:bool=true,volume:int=70,player:enum(auto,mpv,ffplay,cvlc,play)=auto"

music_player source="~/Music" volume=55 run_id=music
message to=run:music type=player.next body=next
message to=run:music type=player.pause body=pause
message to=run:music type=player.play body=play
message to=run:music type=player.stop body=stop
```

See [`docs/recipe-library.md`](./docs/recipe-library.md) for install notes and recipe requirements.

## Runtime Contract

- Tool names are normalized to snake_case.
- Reserved built-in names are blocked.
- Templates are split into shell-like words first, then placeholders are substituted per command arg.
- Tool args are derived from placeholders when `args` is omitted.
- Typed arg declarations are progressive: `file:path`, `request_timeout:int=60000`, `speed:number=1.5`, `dry_run:bool=true`, `prompts:array`, and `mode:enum(check,fix)=check` can live in `args` or inline placeholders such as `{request_timeout:int=60000}`. They generate narrower tool schemas and runtime validation while existing untyped `args` and placeholders keep working.
- `{arg=default}` inline defaults resolve after runtime values and stored `defaults`; `{arg??fallback}` handles empty/null fallback values; `{flag?--flag:}` ternaries map small truthy/falsy values to strings such as optional CLI flags.
- `template: [...]` sequences execute left to right; each successful step passes stdout to the next step on stdin.
- Object nodes may set `parallel: true`; children receive the same stdin and joined stdout flows to the next sequence step.
- Parallel nodes use soft-quorum semantics: failed branches are reported as degraded coverage unless failure propagation escalates to the root.
- For long-running work or agentic fanout, prefer `async: true` recipes or `spawn` so lifecycle and ambient activity status remain visible.
- Timeout is disabled by default; set a positive `timeout` on bounded commands that should fail closed. Numeric node fields may read placeholders such as `timeout: "{timeout_ms}"`.
- Nodes may set `when` to skip conditional work and `delay` in milliseconds to wait before launch; delay is not inherited.
- Failed steps default to `failure: "continue"`, which records the failure and continues with empty stdin.
- `failure: "branch"` stops the current sequence/subtree without cancelling sibling parallel branches; `failure: "root"` aborts the composition.
- `retry` retries a leaf or whole node on non-zero exit; default attempts is `1`.
- `recover` runs a cleanup command template between failed retry attempts and stops retries if cleanup fails.
- Commands execute directly without shell evaluation, but trusted executables still run with the same permissions as pi.
- Obvious high-risk templates such as shells, interpreter eval modes, and broad filesystem mutation surface lightweight warnings without blocking existing tools.
- `async: true` on a recipe selects detached run lifecycle; omitted or false async runs the recipe foreground through registered tools.
- Layer boundaries stay explicit: command templates define synchronous execution graphs; template recipes add saved JSON metadata/import resolution and named `artifacts`; async runs add detached lifecycle, state, IPC, and observability.
- `spawn`, `message`, and `inspect` are high-level actor adapters. `spawn` creates `run:<id>` actors from recipes or inline templates with optional state/artifact metadata, `message` sends one typed envelope to `run:<id>` mailboxes, `branch:<run>/<branch>` mailboxes, `tool:<name>` calls, or the coordinator attention path, and `inspect` intentionally reads `run:<id>` status/tail/events/mailbox metadata or `session:<id>` run status while the broader actor/message protocol is refined.
- `spawn`, `message`, and `inspect` are the public async coordination vocabulary. Low-level async actions map to this actor API: start belongs to `spawn`; send/control belongs to `message`; status/tail/events/list belong to `inspect`; stop/kill are runtime control messages with synchronous results.
- Actor management returns compact text by default; pass `verbose: true` to `inspect` when full JSON state is needed.
- Detached runs inject `{run_id}` and `{state_dir}` into template values for run-local artifacts or recipe-specific control endpoints.
- Runtime actor messages are stored in `<state_dir>/outbox.jsonl`; coordinator attention is inferred by the runtime, not exposed as recipe or message-envelope input.
- Native Windows should use WSL or a recipe-specific transport for FIFO-controlled recipes.
- Registered tools may set `template` to a recipe JSON path/name; calling them follows that recipe's `async` mode.
- File-backed recipes may declare `imports` and embed imported recipes with `{ "name": "alias" }` nodes, or read `{alias.defaults.key}`, `{alias.defaults.key=fallback}`, and `{alias.values.key?yes:no}` references before command-template execution.
- Interactive sessions show ambient async activity as stable `▷` triangles aggregated across runs started by the current agent session. Each running async run contributes at least one triangle; parallel active branches can contribute more. One `▶` wave moves over the active set; terminal `done`/`failed`/unhandled `killed`/`exited` messages are delivered as compact follow-up context only to the launching coordinator agent, while intentional `cancel`, `kill`, and `stop` actions stay silent because the action already reports synchronously. Packaged multi-agent fanout recipes emit `command.done` messages by default so parallel subtask completions reach the coordinator.
- Use `{file}` as the canonical local file path arg.
- Stored `script` entries are rejected with migration guidance.

See [`docs/command-templates.md`](./docs/command-templates.md) for the portable synchronous command-template contract; [`docs/template-recipes.md`](./docs/template-recipes.md) for saved recipe JSON; [`docs/async-runs.md`](./docs/async-runs.md) for detached lifecycle, state files, cancellation, and observability; [`docs/tool-registry.md`](./docs/tool-registry.md) for registry storage; and [`docs/recipe-library.md`](./docs/recipe-library.md) for the packaged standard recipe library.

## Notes

- Only register trusted local commands. Registered tools run with the same system permissions as pi.
- `index.ts` is a small composition root; reusable behavior lives in flat `/lib` domains covered by focused tests.

## License

MIT
