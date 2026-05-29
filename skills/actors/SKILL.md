---
name: actors
description: Highest-density practical guide for pi-actors. Read this skill whenever prompt and tools are not enough for spawn, message, inspect, actor runs, tools, recipes, command templates, async lifecycle, mailboxes, artifacts, and local orchestration mechanics.
metadata:
  version: 0.30.0
---

# Actors (pi-actors)

`pi-actors` turns trusted local capabilities into addressable actors. This skill is the compact operator/reference layer for the extension itself: tools, nouns, lifecycle, message protocol, recipes, and common edge cases. It is not a multi-agent strategy guide; use a swarm skill for decomposition, quorum design, reviewer lenses, and consensus methodology.

Maintain this skill as the extension's agent-facing manual. When implementation changes reveal new durable mechanics, invariants, warnings, or safer operating patterns, update this skill alongside code/docs so future agents learn the current actor model instead of rediscovering it.

## Knowledge Surfaces

Context arrives in layers:

- **Injected prompt**: always present at extension load. It is a bootstrap/reminder of current verbs, paths, and runtime rules; it should not try to be documentation.
- **Skill header**: automatically matched by agents from `name`/`description`. Its job is to signal: if pi-actors use is unclear, read this skill body.
- **This skill body**: highest-density practical reference. It should explain extension operation from multiple angles and link to deeper docs without becoming a changelog or swarm-methodology guide.
- **README**: human entrypoint. It explains what pi-actors is, why it matters, benefits, rhythm, and representative scenarios; it is not automatically in agent context.
- **Docs**: transportable standards by domain: command templates, recipes, async runs, actor messages, registry, recipe library; read on demand.
- **AGENTS.md**: project context for agents changing pi-actors: architecture constraints, durable conventions, do/don't rules, validation; read for repo work.

## Core Nouns

```text
Trusted local capability
  -> Command template          execution graph
  -> Recipe                    saved actor definition
  -> spawn                     starts one run instance
  -> run:<id>                  addressable actor

Trusted local capability
  -> Command template or recipe
  -> register_tool             persists an agent-callable wrapper
  -> tool:<name>               addressable tool actor
```

- **Command template**: portable execution graph. String leaf, sequence array, or object node with controls.
- **Recipe**: saved JSON definition wrapping a template with args, defaults, imports, mailbox, artifacts, metadata, and optional `async: true`.
- **Run actor**: one detached execution instance addressable as `run:<id>` with status, logs, messages, mailbox metadata, files, communication snapshot, and artifacts.
- **Room actor**: shared timeline + roster endpoint addressable as `room:<run>`; every spawned run gets `room:<run>`.
- **Tool actor**: registered persistent capability addressable as `tool:<name>` and callable through the generated tool or `message`. `tool:pi-actors` is reserved for runtime/status inspection.
- **Coordinator/session**: the current pi session endpoint that receives bounded actor follow-ups.
- **Mailbox**: public interaction contract: message types the actor accepts/emits.
- **Artifact**: named durable output path declared by a recipe/run.

## Three Verbs

### `spawn` — create a run actor

Use for long work, background services, subagents, fanout, pipelines, and reusable recipes.

```json
{
  "as": "run:repo-health",
  "file": "pipeline-repo-health",
  "values": { "path": "/repo" },
  "artifacts": { "report": "/tmp/repo-health.md" }
}
```

Rules:

- Use `file`/`recipe` for saved recipes; bare names resolve under `~/.pi/agent/recipes`.
- Use inline `template` for one-off experiments; promote useful repeats to recipes.
- When a successful actor follow-up suggests persistence, decide whether the pattern deserves durable tool memory; call `register_tool` yourself only when the evidence is strong, and ask before writing the user recipe root.
- Use stable `as` names when you will inspect or message the actor later.
- `async: true` on the recipe is the detached run switch.

### `message` — send a typed envelope

```json
{
  "to": "run:repo-health",
  "type": "control.cancel",
  "summary": "Cancel stale repo-health run",
  "body": {}
}
```

Envelope fields:

- Required: `to`, `type`.
- Useful: `summary`, `body`, `from`, `reply_to`, `correlation_id`, `metadata`.
- Addresses: `run:<id>`, `branch:<run>/<branch>`, `room:<run>`, `tool:<name>`, `coordinator`, `session:<id>`.
- Room posts require `from` from the same run (`run:<run>` or `branch:<run>/<branch>`).
- Runtime termination message: `control.kill` is the only documented actor message that kills a run. `control.stop` and `control.cancel` are actor-local mailbox vocabulary only when a recipe declares and handles them. Terminal retention messages: `control.archive`, `control.prune`.

Check `inspect view=mailbox` before domain-specific messages.

### `inspect` — observe intentionally

```json
{ "target": "run:repo-health", "view": "status" }
{ "target": "run:repo-health", "view": "tail", "lines": "80" }
{ "target": "run:repo-health", "view": "messages" }
{ "target": "run:repo-health", "view": "communication" }
{ "target": "run:repo-health", "view": "artifacts" }
{ "target": "room:repo-health", "view": "status" }
{ "target": "room:repo-health", "view": "roster" }
{ "target": "room:repo-health", "view": "contacts" }
{ "target": "room:repo-health", "view": "previews" }
{ "target": "tool:pi-actors", "view": "status" }
{ "target": "tool:music_player", "view": "status" }
{ "target": "recipes", "view": "status" }
{ "target": "coordinator", "view": "status" }
```

Views:

- `status`: lifecycle, pid, values, progress, result, compact summary.
- `tail`: recent stdout/stderr/log tail.
- `messages`: actor messages emitted by the run, or room timeline entries for `room:*`.
- `communication`: run/branch communication snapshot with self/root/default-room/member/contact hints.
- `roster`: room member list with address, role, parent, caps, claim, status, and last seen.
- `contacts`: roster-derived direct-message targets without full roster metadata.
- `previews`: TUI-ready bounded room message previews with timestamp/from/to/type/summary/body_preview.
- `mailbox`: declared accepts/emits contract for runs; queued direct branch inbox messages for `branch:<run>/<branch>` with `id`, status, route/type, and queue/handling timestamps.
- `files`: run state directory file list.
- `artifacts`: declared artifact paths/status.
- `recipes` target: registry summary for active, shadowed, invalid, disabled, and diagnostic recipe entries.

Actor inspector commands:

- `/actors-inspector-toggle [rows]`: open/close the compact table or set row count; default is 12 log rows when no size is supplied.
- `/actors-inspector-filter all|room|direct|broadcast|unread|branch <name>|current-branch <name>|mention <text>`: narrow table previews without changing room/run state.
- `/actors-inspect <number>`: open one visible row as a full-message view.

The table is compact and optimistic by default: bounded body previews, capped noisy room rows, branch-local inbox previews, stable event ids in selected-message details, and an inline roster summary in the form `name/role` that wraps only when needed. Use `unread` for queued branch inbox work and `branch <name>` / `current-branch <name>` for one branch's room/direct/inbox traffic. Rows with `metadata.requires_response=true` show a `!` attention marker. `/actors-inspect <number>` marks that row read for the current session filter. Active roster members use the target color; members that sent `actor.leave` stay visible as inactive/muted participants from the current run. Actor display names come from `actor.join` bodies (`display`) or branch addresses, keeping debugger output plain and name-driven.

Let terminal notifications arrive; avoid sleep-poll loops except during diagnosis.

## Runtime Communication Rules

- Keep one public communication model: `spawn` creates actors, `message` sends typed envelopes, and `inspect` observes. Avoid adding public side channels or storage nouns when a normal actor address/view can express the operation.
- Keep route and semantic type separate. Direct, room, coordinator, and session messages may share `type`; delivery behavior comes from `to`.
- Treat inspector-visible communication logs as recipe evidence. Use `inspect room:<run> view=messages|previews`, `inspect run:<id> view=communication`, and the actor inspector table/full-message views to improve mailbox/artifact conventions after real runs.
- Any UI, summary, or aggregate view that scans run directories must apply coordinator/session ownership filters before exposing summaries or body previews.
- Treat `communication.json` as visible actor context, not a global mutable truth table. Run-level snapshots should identify the run actor; branch-local snapshots should identify the branch actor.
- Prefer same-run provenance checks on lateral actor routes. If `from` is accepted for room or branch routes, validate that it belongs to the addressed run.

## Command Template Standard

Forms:

```json
"npm test -- {file}"
["npm run typecheck", "npm test"]
{ "parallel": true, "template": ["job-a", "job-b"] }
```

Controls:

- `args`, `defaults`: public placeholder declarations and defaults.
- `parallel: true`: fanout child nodes.
- `when`: conditional execution.
- `timeout`, `delay`, `retry`: timing and retry controls; string placeholders are allowed where supported.
- `failure`: `continue`, `branch`, or `root` propagation.
- `recover`: cleanup between retry attempts.
- `repeat`: repeated node expansion.
- `output`: output behavior selection.

Placeholders:

- `{name}` required value.
- `{name=default}` inline default.
- `{name:type=default}` typed inline arg.
- `{value??fallback}` nullish fallback.
- `{flag?yes:no}` ternary fallback.

Templates are synchronous and portable. Recipes give them identity and lifecycle.

## Recipe Standard

Minimal actor recipe:

```json
{
  "async": true,
  "args": ["path:path", "model:string"],
  "defaults": {},
  "mailbox": {
    "accepts": ["control.kill"],
    "emits": ["command.done", "run.done", "run.failed"]
  },
  "artifacts": { "report": "{path}/report.md" },
  "template": "some-command {path} --model {model}"
}
```

Rules:

1. Every recipe owns `template` directly.
2. `async: true` makes spawned work a detached actor run.
3. Public knobs belong in `args`/`defaults`; hidden launch mechanics stay inside `template`.
4. Use `imports` to compose recipes; imported recipes are definitions, not nested async runs.
5. Declare `mailbox` for actors that accept or emit meaningful messages.
6. Declare `artifacts` for durable outputs the coordinator should inspect.
7. File-backed recipe identity comes from the filename basename; legacy top-level `name` fields are ignored by loaders.
8. File-backed async recipes pass child `pi -p` actors a bounded JSONL recipe context bundle by default: raw entry/import recipe records, derived `name`, import path/alias, and `"you_are_here": true` on the launching recipe node. Set `"actor_context": false` or `"off"` to suppress it for minimal prompts.
9. Keep packaged recipes generic: no machine-local paths, no private companion identities, no project-specific defaults unless the recipe is explicitly project-specific.
10. Do not ship concrete model-version defaults in packaged recipes; expose `model`, `models`, and stage-specific model args so the caller must choose current policy at launch.

Priority for same-id recipes:

1. No recipe: no capability.
2. Packaged pi-actors recipe: standard-library declarative actor component.
3. Explicit ad hoc user recipe file outside `~/.pi/agent/recipes`.
4. User recipe in `~/.pi/agent/recipes/*.json` or `*.md`: highest-priority operator tool surface.

Only matching filename ids compete. Higher priority shadows lower priority; within one priority layer, same-id JSON shadows Markdown. An invalid or `disabled: true` higher-priority recipe blocks fallback so the agent does not silently run standard-library behavior when a user override is broken or intentionally disabled.

Muscle-memory lens: pi-actors has two durable executable-memory layers.

1. `~/.pi/agent/recipes/*.json` and `*.md` are the agent's active capability memory. Every recipe in that directory becomes an easy-to-call tool automatically and survives into later sessions. Descriptions matter here because they become the tool's operator-facing title/context.
2. `~/.pi/agent/recipes/candidates/*.json` is candidate memory captured from successful inline `spawn template=...` runs. Candidates are not registered tools and do not enter the injected tool surface. They remain reusable by explicit path, e.g. `spawn file="~/.pi/agent/recipes/candidates/<name>.json"`, and can be promoted by moving or copying one level up into `~/.pi/agent/recipes`.

Agents grow active memory by calling `register_tool` or by deliberate recipe-file edits. They grow candidate memory by trying ad hoc actors successfully. Treat both as executable habits: candidates are the workbench/proving ground; root recipes are promoted muscle memory.

Usage lens: user recipes may carry extension-maintained launch metadata such as `usage.calls` and `usage.last_called`. The extension increments the counter when it starts that concrete recipe; agents should not hand-edit counters as part of normal recipe maintenance. Treat usage as evidence for usefulness analysis: heavily used recipes are good candidates for promotion, documentation, or stronger tests; unused recipes are cleanup candidates. Do not use failure counts as a primary usefulness signal because failures may reflect bad caller judgment rather than bad recipes. Do not delete or demote solely from counters without operator approval.

Promotion lens: successful transient/ad hoc actor runs are evidence, not commands. Inline spawns leave candidate recipes as replayable evidence, not active tools. If a candidate is repeatable, parameterized, safe enough, and likely useful later, the agent may promote it by moving/copying it into `~/.pi/agent/recipes` or by calling `register_tool` with a concise name, typed args/defaults, and a reviewed template or recipe path. Do not auto-register every success; do not promote temp paths, secrets, one-off prompts, or project-private assumptions without normalization and approval.

Cleanup rule: periodically inspect `~/.pi/agent/recipes` as the live muscle-memory set. For each stale, duplicate, too-specific, or low-value recipe, choose one explicit action: keep as a tool, move it out of the agent recipe root to retain recipe-only memory, merge into a better recipe, or delete/archive the file. Prefer moving over deletion when the recipe may still be useful as a component. Never silently remove tools during unrelated work.

## Registered Tools

`register_tool` persists trusted local capabilities as recipe files in `~/.pi/agent/recipes/*.json`; hand-authored Markdown recipes in the same directory are also discovered as tools.

Use it when a command/template/recipe should become durable agent muscle memory. Prefer typed args or placeholder-derived args; use `update=true` for replacement and `template=null` or `template=""` for deletion. `register_tool` should create/update/delete recipe files in the user recipe root; direct file editing is allowed but is the lower-level path.

Tool-registration lenses are open-ended prompts for deciding what deserves durable tool status:

1. **Reliability lens**: register wrappers for operations where agents commonly omit checks, run steps out of order, pass ambiguous inputs, or recover poorly from partial failure.
2. **Safety lens**: prefer read-only diagnostics, dry-runs, preflights, confirmations, or bounded adapters around high-impact operations before registering direct action tools.
3. **Context-affordance lens**: register tools whose mere presence in the injected capability list should steer agents toward the right operational habit.
4. **Existing-recipe lens**: scan already-authored recipes before inventing a new tool. Packaged recipes, ad hoc project recipes, and recipes co-located under skill directories are often the first candidates to copy/register into the user recipe root when they match a recurring local workflow.
5. **Composition lens**: register small semantic entrypoints over reusable recipe components instead of baking one large scenario-specific shell command into a tool.
6. **Portability lens**: keep recipe files transportable; make tool exposure a consequence of placement in `~/.pi/agent/recipes`, not recipe-owned markers or machine-local assumptions.

Default bias: register diagnostic/preflight tools before action tools, and promote existing recipes before writing new orchestration. A good persistent tool shrinks the chance of a subtle operational mistake, not just the number of keystrokes.

Tool templates may be:

- A foreground command template.
- A file-backed recipe name/path.
- A complete recipe body, optionally `async: true`.

The user recipe root is the default tool set by location. It accepts canonical JSON recipes and literate Markdown recipes with frontmatter plus fenced `template`/`json recipe` blocks; same-id JSON shadows Markdown in the same priority layer. Packaged recipes are lower-priority standard-library components and are not tools unless copied or registered into the agent recipe root. Ideal runtime behavior is reactive: create/edit/delete recipe files, validate them, then connect valid tools or surface diagnostics without requiring agents to hand-maintain a separate registry.

## Top Recipes

Use packaged recipes by name with `spawn file=<name>` for async actors, or register/call them as tools when repeated use deserves a stable shortcut.

- [`pipeline-room-swarm`](../../recipes/pipeline-room-swarm.json): room-visible swarm coordination with roles, rounds, optional locker, artifact synthesis, and `subagent_ttl_ms` for hard participant budgets.
- [`pipeline-repo-health`](../../recipes/pipeline-repo-health.json): git/doc/validation evidence → normalized repository health report.
- [`pipeline-release-readiness`](../../recipes/pipeline-release-readiness.json): changelog/package/skill/validation evidence → release review → artifact report.
- [`actor-worker`](../../recipes/actor-worker.json): canonical mailbox-backed branch worker reference for claim/handle/status/artifact patterns.
- [`coordinator-locker`](../../recipes/coordinator-locker.json): queue + lease locks + journaled coordinator messages for multi-actor ownership.

## Deep References

- `docs/actors-deep-reference.md` — recipe navigator, operating patterns, lifecycle discipline, pitfalls.
- `docs/command-templates.md` — execution graph semantics.
- `docs/template-recipes.md` — recipe storage, imports, defaults, references.
- `docs/async-runs.md` — detached lifecycle, state, cancellation, observability.
- `docs/actor-messages.md` — addressed envelope protocol and mailbox model.
- `docs/tool-registry.md` — persistent tool registry and generated tools.
- `docs/recipe-library.md` — packaged recipes.
- `docs/task-first-recipes.md` — deriving reusable pipelines from operator tasks.
- `docs/component-recipes.md` — reusable coordinator/subagent building blocks.

## One-Sentence Contract

Use pi-actors to wrap local capabilities as addressable actors: define launch with templates, preserve semantics in recipes/tools, start with `spawn`, communicate with `message`, observe with `inspect`, and hand off durable results through messages and artifacts.
