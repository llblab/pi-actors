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

The npm package is dist-first for JavaScript-only runtimes: default Pi metadata points at compiled `dist/` entrypoints and mirrored runtime assets. Source TypeScript and source skills remain in the package for TypeScript-native runtimes through optional source metadata.

## Address Surface

Actors and coordination endpoints are addressed with compact route strings:

```text
run:<id>               one detached actor run
branch:<run>/<branch>  branch-local actor endpoint
room:<run>             shared run-local task room
coordinator            launching coordinator attention path
session:               current session actor surface
session:all            cross-session inventory surface
tool:<name>            executable registered tool
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

Room posts require a same-run sender, so unrelated runs do not pollute the roster. Direct messages and room messages use the same envelope; only the address changes. Direct `branch:<run>/<branch>` messages are private: they are forwarded through the parent run mailbox and recorded in the recipient branch inbox for worker protocols that consume queued branch work. For selected-recipient multicast, send to `room:<run>` with `metadata.recipients` set to same-run `branch:<run>/<branch>` addresses; this keeps one room transcript entry while forwarding branch-targeted copies.

## Actor Inspector

The terminal actor inspector is hidden by default. When opened without an explicit size, it shows 12 log rows by default. Use it when async actors are actively coordinating:

```text
/actors-inspector-toggle
/actors-inspector-toggle 20
/actors-inspector-filter room
/actors-inspector-filter direct
/actors-inspector-filter unread
/actors-inspector-filter branch front
/actors-inspector-filter mention checkpoint
/actors-inspect 3
```

The table is compact and optimistic by default: bounded route/type/summary/body previews, capped noisy room rows, branch-local inbox previews, stable event ids in selected-message details, and an inline roster summary in the form `name/role` that wraps only when needed. Active roster members use the target color; members that sent `actor.leave` remain visible as inactive/muted participants from the current run. Use `unread` to focus queued branch inbox work and `branch <name>` / `current-branch <name>` to focus one branch's room/direct/inbox traffic. Rows with `metadata.requires_response=true` show a `!` attention marker. `/actors-inspect <number>` opens the selected row as a full-message view and marks it read for the current session filter; toggle again to return to the table or close it. Actor display names come from room `actor.join` roster metadata or branch addresses, keeping debugger output plain and name-driven.

## Registry Model

The persistent tool surface is file-discovered:

```text
~/.pi/agent/recipes/*.json
~/.pi/agent/recipes/*.md
```

That directory is operator-managed executable memory.

Rules:

- User recipes in `~/.pi/agent/recipes/` are tools by location;
- Recipe filenames define tool ids;
- User recipes override same-name lower-priority recipes;
- Same-id JSON recipes shadow Markdown recipes in the same priority layer;
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

The template owns execution shape. The recipe owns saved metadata, defaults, imports, mailbox, and artifacts. JSON is the canonical precise recipe format; Markdown recipes use frontmatter plus fenced `template`/`json recipe` blocks for literate authoring and compile into the same model. The run actor owns detached lifecycle, state, messages, cancellation, and inspection. File-backed async recipes also provide child `pi -p` actors with a bounded JSONL recipe context bundle by default, including raw entry/import recipe records and a `"you_are_here": true` marker for the recipe node that launched the child. Set `"actor_context": false` or `"off"` in a recipe to suppress that context for minimal prompts.

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

Use an async recipe or `spawn` when the work is long-running, service-like, parallel, agentic, artifact-producing, or needs later control. When a directly spawned inline/ad hoc actor or a recipe outside the user recipe root completes successfully, pi-actors sends the launching agent a follow-up note to offer saving that pattern as a durable recipe/tool under `~/.pi/agent/recipes`; the agent should ask first and never auto-save.

Use `room:<run>` when multiple actors in the same run need shared context, roster discovery, or group-visible progress.

Use artifacts when outputs should survive context compression.

Use mailbox declarations when an actor has a stable conversational surface.

## Platform Support

Core actor state, inspection, foreground tools, and basic async runs are portable Node.js behavior. Run-local messaging and stop/kill use a platform adapter under the same `message` API: Unix-compatible recipes can use their existing local control endpoint, while native Windows recipes can expose a Windows-native endpoint in run state. Some packaged scripts still depend on Unix tools and are WSL/Linux/macOS-only until migrated; their public recipe surface should stay `spawn` / `message` / `inspect` either way.

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
