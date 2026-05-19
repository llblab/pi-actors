# pi-actors

Actor runtime and orchestrator for agent-managed local processes.

`pi-actors` turns local programs, scripts, services, recipes, and long-running processes into addressable actors that agents can start, message, inspect, and compose. A music player, a sub-agent fanout, a repo-health pipeline, or any trusted local process can become an actor when it has a template-backed launch path, a mailbox contract, and observable runtime state.

The persistent tool registry is still useful: it lets agents keep durable operational muscle memory for trusted local commands and wrappers. But the project lens is broader than stored tools. `pi-actors` is a local-first orchestration runtime for wrapping capabilities as agent-managed entities with explicit interfaces.

## Start Here

- [Project Context](./AGENTS.md)
- [Open Backlog](./BACKLOG.md)
- [Changelog](./CHANGELOG.md)
- [Documentation](./docs/README.md)

## What It Is

`pi-actors` is the runtime layer that lets a pi agent turn a local capability into a controllable actor:

```text
program/process/service
→ command template
→ actor recipe
→ spawn
→ addressable actor
→ message / inspect / artifacts
```

An actor can be:

- A sub-agent running `pi -p` in a clean context.
- A background music player controlled by `player.next` or `player.pause` messages.
- A validation or repo-health pipeline that reports completion and artifacts.
- A parallel quorum review with branch-level progress.
- Any trusted local process with a launch template and a useful control surface.

The key move is not just “register a command.” It is to wrap a process in an agent-readable contract:

- **Launch**: `spawn` starts the actor from a template or recipe.
- **Interface**: `mailbox` declares accepted and emitted message types.
- **Control**: `message` sends typed envelopes to runs, branches, tools, or the coordinator.
- **Observation**: `inspect` reads status, logs, messages, mailbox metadata, files, and artifacts intentionally.
- **Persistence**: `artifacts` and state files make outcomes durable.
- **Memory**: `actors-tools.json` stores reusable actor-control wrappers across sessions.

## Key Features

- **Actor Runtime**: Starts local templates and recipes as addressable `run:<id>` actors with state, logs, message mailboxes, cancellation, and artifacts.
- **Agent-Managed Processes**: Wraps sub-agents, media players, pipelines, diagnostics, and other local programs as controllable entities instead of one-off commands.
- **Message-Oriented Control**: Uses `spawn`, `message`, and `inspect` as the public coordination vocabulary for start, control, and observation.
- **Mailbox Contracts**: Lets recipes declare what messages they accept and emit, so agents can discover how to interact with an actor.
- **Actor Tool Registry**: Stores persistent actor-control tool definitions in `~/.pi/agent/actors-tools.json` and registers them automatically on session start.
- **Command Template Substrate**: Keeps process launch portable with named placeholders, typed args, defaults, sequences, guarded nodes, retries, failure policy, and `parallel: true` fanout.
- **Composable Actor Recipes**: Stores reusable recipe JSON under `~/.pi/agent/recipes/*.json`; recipes can import other recipes, reuse defaults, declare artifacts, and opt into detached actor lifecycle with `async: true`.
- **Coordinator-Scoped Observability**: Shows ambient triangles for active actor runs and sends compact completion or request-for-attention follow-ups only to the launching coordinator.
- **Bounded Context Impact**: Returns compact output by default, truncates oversized stdout, and keeps full logs/artifacts in files for intentional inspection.
- **Local-First Tool Memory**: Still lets agents create durable semantic tools from trusted commands so they do not repeatedly reconstruct shell invocations.

## Install

From npm:

```bash
pi install npm:@llblab/pi-actors
```

From git:

```bash
pi install git:github.com/llblab/pi-actors
```

## Rename Migration

`pi-actors` reads persistent actor-control tools from:

```text
~/.pi/agent/actors-tools.json
```

If you previously used `pi-auto-tools`, copy the old registry intentionally:

```bash
cp ~/.pi/agent/auto-tools.json ~/.pi/agent/actors-tools.json
```

If you installed the brief `0.12.0`/`0.12.1` line and created `tools.json`, copy that file instead:

```bash
cp ~/.pi/agent/tools.json ~/.pi/agent/actors-tools.json
```

The extension does not silently rewrite old registry files; keep or delete the old file after confirming the new registry loads as expected.

## Mental Model

`pi-actors` separates launch mechanics from actor semantics:

```text
command template = how to start work
actor recipe     = saved actor definition
spawn            = create actor instance
message          = connect/control actors
inspect          = observe intentionally
artifacts        = persist outcomes
mailbox          = declare interaction contract
```

- A **command** is one concrete local process.
- A **command template** is the reusable launch shape for that process, with named placeholders.
- An **actor recipe** is saved JSON containing a template, defaults, imports, mailbox metadata, artifacts, and optional detached lifecycle.
- A **registered tool** gives a template or actor recipe a stable agent-facing name.
- A **run actor** is one execution instance with state, logs, actor messages, mailbox metadata, status, cancellation, and kill control.

The template remains the execution substrate. The recipe is the actor definition. `async: true` opts into detached actor lifecycle. `spawn` creates actors, `message` connects or controls them, and `inspect` observes them without teaching agents to poll blindly.

## Operator Onboarding

Start with foreground templates when the work is short and deterministic:

```text
register_tool name=lint_docs description="Lint docs" template="npm run lint:docs"
```

Move to actor recipes when work is long-running, parallel, service-like, or agentic:

```json
{
  "name": "docs-review",
  "async": true,
  "args": ["scope:path", "model:string"],
  "defaults": {
    "model": "openai-codex/gpt-5.5"
  },
  "mailbox": {
    "accepts": ["control.stop"],
    "emits": ["review.completed", "run.failed"]
  },
  "template": "pi -p --model {model} --no-tools \"Review {scope} for unclear actor-runtime onboarding. Return concise findings.\""
}
```

Expose a reusable actor recipe as a normal capability:

```text
register_tool name=docs_review description="Start an async docs review actor" template="docs-review.json" args="scope:path,model:string=openai-codex/gpt-5.5"
```

`Task` is the user's work item. `Template` is the execution graph. `Actor recipe` is saved JSON. `Run` is one actor instance with status, logs, messages, cancellation, artifacts, and ambient triangles.

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

## Register Actor-Control Tools

`register_tool` lists, registers, updates, or deletes persistent actor-control tools. Call it without arguments to list the current registry. These tools are convenient handles for creating or invoking actors, not the whole runtime model.

### Local command: transcription

`pi-actors` is also useful for exposing stable local commands as normal tools. For example, register an STT command:

```text
register_tool name=transcribe \
  description="Transcribe a local audio file" \
  template="/path/to/stt --file {file} --lang {lang=ru}"
```

### Template recipe

For reusable actor workflows, keep the large template and mailbox contract in a recipe file and register a small tool:

```text
register_tool name=docs_review \
  description="Start an async docs review actor" \
  template="docs-review.json" \
  args="scope:path,model:string=openai-codex/gpt-5.5"
```

If the recipe file contains `async: true`, calling `docs_review` starts a detached run and returns metadata immediately. If `async` is omitted or false, the same recipe runs foreground and returns normal tool output.

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
  "docs_review": {
    "description": "Start an async docs review actor",
    "args": ["scope:path", "model:string=openai-codex/gpt-5.5"],
    "template": "docs-review.json"
  }
}
```

This file is the durable actor-tool registry. `register_tool` is the interactive API; `actors-tools.json` is the persisted state that is loaded on future sessions.

## Manage Actors

Use `spawn` when a command template, service, pipeline, or recipe may outlive the current turn. It starts the work now as an addressable actor, returns immediately with state metadata, and keeps ordinary files under `~/.pi/agent/tmp/pi-actors/runs/<run>` for later inspection.

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

Do not check it on a timer. Let follow-up actor messages arrive from the run, then react to a run-local request or redirect a long-lived recipe without polling/restarting it:

```json
{ "to": "run:docs-review", "type": "control.continue", "body": "continue" }
```

Read recent actor messages or logs only after a follow-up asks for inspection, at a real decision point, or during diagnosis:

```json
{ "target": "run:docs-review", "view": "tail", "lines": "80" }
```

Reusable local recipes live in `~/.pi/agent/recipes/*.json`; recipe tools honor each file's `async` flag. Use `spawn` for explicit detached starts from a file or inline template, and `inspect target=coordinator view=runs status=running`, `inspect target=session:<id> view=runs status=running`, or `inspect target=session:all view=runs` for explicit inventory/diagnosis. List output includes `tool` and `recipe` when the launcher recorded that source context.

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

- Actor-control tool names are normalized to snake_case.
- Reserved built-in names are blocked.
- Templates are split into shell-like words first, then placeholders are substituted per command arg.
- Tool args are derived from placeholders when `args` is omitted.
- Typed arg declarations are progressive: `file:path`, `request_timeout:int=60000`, `speed:number=1.5`, `dry_run:bool=true`, `prompts:array`, and `mode:enum(check,fix)=check` can live in `args` or inline placeholders such as `{request_timeout:int=60000}`. They generate narrower tool schemas and runtime validation while existing untyped `args` and placeholders keep working.
- `{arg=default}` inline defaults resolve after runtime values and stored `defaults`; `{arg??fallback}` handles empty/null fallback values; `{flag?--flag:}` ternaries map small truthy/falsy values to strings such as optional CLI flags.
- Runtime actor-tool argument errors include a compact usage hint when typed normalization or template value resolution fails, including example call shape plus required and optional fields.
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
- `spawn`, `message`, and `inspect` are high-level actor adapters. `spawn` creates `run:<id>` actors from recipes or inline templates with optional state/artifact metadata, `message` sends one typed envelope to `run:<id>` mailboxes, `branch:<run>/<branch>` mailboxes, `tool:<name>` calls, or coordinator/session attention paths, and `inspect` intentionally reads `run:<id>` status/tail/messages/mailbox metadata, coordinator/session run status, or registered `tool:<name>` contracts while the broader actor/message protocol is refined.
- `spawn`, `message`, and `inspect` are the public async coordination vocabulary. Low-level async actions map to this actor API: start belongs to `spawn`; send/control/stop/kill belongs to `message`; status/tail/messages/list belongs to `inspect`. Use `inspect view=messages` for actor-envelope streams. Use `control.stop`, `control.cancel`, and `control.kill` for run termination; runtime-prefixed control aliases are no longer part of the public surface.
- Actor management returns compact text by default; pass `verbose: true` to `inspect` when full JSON state is needed.
- Detached runs inject `{run_id}` and `{state_dir}` into template values for run-local artifacts or recipe-specific control endpoints.
- Runtime actor messages are persisted in the run state dir; coordinator attention is inferred by the runtime, not exposed as recipe or message-envelope input. Follow-ups preserve bounded body previews and metadata for decision messages.
- Native Windows should use WSL or a recipe-specific transport for run-local message-controlled recipes; Linux uses stricter `/proc` runner ownership checks for stale PID protection.
- Registered tools may set `template` to a recipe JSON path/name; calling them follows that recipe's `async` mode.
- File-backed recipes may declare `imports` and embed imported recipes with `{ "name": "alias" }` nodes, or read `{alias.defaults.key}`, `{alias.defaults.key=fallback}`, and `{alias.values.key?yes:no}` references before command-template execution.
- Interactive sessions show ambient async activity as stable `▷` triangles aggregated across runs started by the current agent session. Each running async run contributes at least one triangle; parallel active branches can contribute more. One `▶` wave moves over the active set; terminal `done`/`failed`/unhandled `killed`/`exited` messages are delivered as compact follow-up context only to the launching coordinator agent, while intentional `cancel`, `kill`, and `stop` actions stay silent because the action already reports synchronously. Failed commands and in-flight parallel branch completions can bubble through `command.done`; successful final leaf completions remain diagnostic to avoid sequential pipeline noise.
- Use `{file}` as the canonical local file path arg.
- Stored `script` entries are rejected with migration guidance.

See [`docs/command-templates.md`](./docs/command-templates.md) for the portable synchronous command-template contract; [`docs/template-recipes.md`](./docs/template-recipes.md) for saved recipe JSON; [`docs/async-runs.md`](./docs/async-runs.md) for detached lifecycle, state files, cancellation, and observability; [`docs/tool-registry.md`](./docs/tool-registry.md) for registry storage; and [`docs/recipe-library.md`](./docs/recipe-library.md) for the packaged standard recipe library.

## Notes

- Only register trusted local commands. Registered tools run with the same system permissions as pi.
- `index.ts` is a small composition root; reusable behavior lives in flat `/lib` domains covered by focused tests.

## License

MIT
