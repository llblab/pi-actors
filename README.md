# pi-actors

> Local Actor Kernel for Pi

![Actors](./banner.jpg)

`pi-actors` turns trusted local programs, scripts, recipes, services, pipelines, and sub-agents into addressable actors that agents can spawn, message, inspect, and compose.

It is not just a command registry. A tool is a verb. An actor is a noun with time: address, lifecycle, state, logs, mailbox, artifacts, and an interaction contract.

```text
program / process / service
→ command template
→ actor recipe
→ spawn
→ run:<id>
→ message / inspect / artifacts
```

## Core Contract

`pi-actors` compresses local agent orchestration to three durable verbs:

```text
spawn    create an addressable actor
message  send one typed envelope to one address
inspect  intentionally read state, logs, messages, contracts, or artifacts
```

Everything else is an adapter until proven otherwise.

Use `spawn` when work may outlive the current turn. Use `message` when the actor should be steered rather than restarted. Use `inspect` at decision points, after actor follow-ups, or during diagnosis. Do not build polling loops as the default coordination pattern.

## Install

```bash
pi install npm:@llblab/pi-actors
```

Or from git:

```bash
pi install git:github.com/llblab/pi-actors
```

## Address Surface

Actors and coordination endpoints are addressed with compact route strings:

```text
run:<id>                 one detached actor run
branch:<run>/<branch>    branch-local actor endpoint
room:<run>               shared run-local task room
coordinator              launching coordinator attention path
session:                 current session actor surface
session:all              cross-session inventory surface
tool:<name>              executable registered tool
```

Actor messages use one envelope shape:

```json
{
  "to": "run:review",
  "from": "coordinator",
  "type": "control.continue",
  "summary": "Continue after checkpoint",
  "body": "continue",
  "reply_to": "msg_123",
  "correlation_id": "task_456",
  "metadata": {}
}
```

Routing is inferred from `to`, actor ownership, and runtime policy. Recipes should expose semantic message types, not transport knobs.

## Golden Path

Create a reusable async actor recipe in the user recipe root:

```bash
mkdir -p ~/.pi/agent/recipes

cat > ~/.pi/agent/recipes/docs_review.json <<'JSON'
{
  "description": "Start an async docs review actor",
  "async": true,
  "args": ["scope:path", "model:string"],
  "mailbox": {
    "accepts": ["control.stop", "control.continue"],
    "emits": ["review.completed", "run.failed"]
  },
  "template": "pi -p --model {model} --no-tools \"Review {scope} for unclear actor-runtime onboarding. Return concise findings.\""
}
JSON
```

Because it lives under `~/.pi/agent/recipes/`, the file becomes a persistent agent tool by location. The filename is the tool id.

Start it:

```text
docs_review scope="README.md" model="current-review-model" run_id=docs_review
```

Inspect only when there is a reason:

```text
inspect target=run:docs_review view=status
inspect target=run:docs_review view=tail lines=80
inspect target=run:docs_review view=messages
inspect target=run:docs_review view=mailbox
```

Steer it through messages:

```text
message to=run:docs_review type=control.continue body=continue
message to=run:docs_review type=control.stop body=stop
```

## Actor Rooms

Every spawned run can have a shared room at `room:<run>`. A room is not a broker and not a chat app. It is a run-local coordination surface: append-only timeline, compact roster, member discovery, and previews.

Actors can join, post, leave, and discover peers:

```text
message \
  to=room:review \
  from=branch:review/security \
  type=actor.join \
  summary="Security reviewer joined" \
  body='{"role":"reviewer","caps":["security-review"],"claim":"Review auth boundary risks"}'
```

Inspect the room intentionally:

```text
inspect target=room:review view=status
inspect target=room:review view=previews
inspect target=room:review view=roster
inspect target=room:review view=contacts
inspect target=room:review view=messages
```

Room posts require a same-run sender, so unrelated runs do not pollute the roster. Direct messages and room messages use the same envelope; only the address changes.

## Registry Model

The persistent tool surface is file-discovered:

```text
~/.pi/agent/recipes/*.json
```

That directory is operator-managed executable memory.

Rules:

- User recipes in `~/.pi/agent/recipes/` are tools by location;
- Recipe filenames define tool ids;
- User recipes override same-name lower-priority recipes;
- Packaged recipes are standard-library components, not automatically installed operator policy;
- `register_tool` creates, updates, lists, or deletes user recipe files through the normal agent interface.

Example foreground tool:

```text
register_tool name=transcribe_audio \
  description="Transcribe a local audio file" \
  template="~/bin/transcribe {file:path} {lang=ru} {model:string}"
```

Example recipe-backed tool:

```text
register_tool name=docs_review \
  description="Start an async docs review actor" \
  template="docs_review" \
  args="scope:path,model:string"
```

Inspect the discovered registry:

```text
inspect target=recipes view=status
inspect target=recipes view=summary verbose=true
```

## Command Templates

A command template is the portable launch substrate. It can be a string, a sequence, or a composed graph.

Templates support:

- Named placeholders: `{file}`, `{model}`, `{prompt}`;
- Compact types: `string`, `path`, `int`, `number`, `bool`, `enum(a,b)`;
- Defaults: `{lang=ru}`, `{dry_run:bool=true}`;
- Fallback and small ternary forms;
- Sequences with stdin flow;
- Parallel nodes;
- Retries, recovery, failure policy, delays, and guarded execution;
- Async run values such as `{run_id}`, `{state_dir}`, `{actor_address}`, `{default_room}`, and `{communication_file}`.

The template owns execution shape. The recipe owns saved metadata, defaults, imports, mailbox, and artifacts. The run actor owns detached lifecycle, state, messages, cancellation, and inspection.

## Recipe Library

Packaged recipes live under `recipes/` and helper scripts live under `scripts/`.

The library includes:

- Sub-agent launchers;
- Review, critic, planner, verifier, merger, judge, normalizer, and artifact atoms;
- Quorum and lens-style pipelines;
- Repo-health, release-summary, research-synthesis, development-tasking, docs-maintenance, and room-swarm pipelines;
- Coordinator-locker and actor-message utilities;
- Local music-player actor recipe.

Packaged recipes are building blocks. Copy them into `~/.pi/agent/recipes/` or register tools that point at them when they should become durable operator-facing capabilities.

## When To Use What

Use a foreground registered tool when the work is short, bounded, and does not need lifecycle.

Use an async recipe or `spawn` when the work is long-running, service-like, parallel, agentic, artifact-producing, or needs later control.

Use `room:<run>` when multiple actors in the same run need shared context, roster discovery, or group-visible progress.

Use artifacts when outputs should survive context compression.

Use mailbox declarations when an actor has a stable conversational surface.

## Safety Boundary

`pi-actors` is local-first, not sandbox-first.

Commands execute directly without shell evaluation where possible, but trusted executables still run with the same system permissions as Pi. Only register commands, scripts, recipes, and paths you trust.

High-risk templates such as shells, interpreter eval modes, and broad filesystem mutation may surface warnings, but the runtime is not a security boundary.

Prefer:

- Narrow commands;
- Explicit paths;
- Typed args;
- Bounded timeouts for bounded work;
- Explicit tool allowlists for sub-agents;
- Deterministic utility recipes for filesystem writes;
- Human approval for destructive or external side effects.

## Non-Goals

`pi-actors` is NOT:

- A generic workflow DSL;
- A remote agent interoperability protocol;
- A heavyweight broker or chat subsystem;
- A sandbox;
- A facade that hides logs, artifacts, ownership, or local side effects;
- A polling-first async runner.

Its job is narrower: make trusted local capabilities addressable, messageable, inspectable, and reusable by agents.

## Documentation

Start here:

- [Project context](./AGENTS.md)
- [Changelog](./CHANGELOG.md)
- [Open backlog](./BACKLOG.md)
- [Documentation index](./docs/README.md)
- [Actors skill](./skills/actors/SKILL.md)
- [Swarm skill](./skills/swarm/SKILL.md)

Core docs:

- [Command templates](./docs/command-templates.md)
- [Template recipes](./docs/template-recipes.md)
- [Async runs](./docs/async-runs.md)
- [Actor messages](./docs/actor-messages.md)
- [Tool registry](./docs/tool-registry.md)
- [Recipe library](./docs/recipe-library.md)

## License

MIT
