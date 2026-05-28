---
name: actors
description: Highest-density practical guide for pi-actors. Read this skill whenever prompt and tools are not enough for spawn, message, inspect, actor runs, tools, recipes, command templates, async lifecycle, mailboxes, artifacts, and local orchestration mechanics.
metadata:
  version: 0.26.1
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
- **Tool actor**: registered persistent capability addressable as `tool:<name>` and callable through the generated tool or `message`.
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

## Stable Multi-Actor Review Rules

- Prefer independent read-only reviewers for review swarms. Use shared room messages for coordination signals and observability, not for letting reviewers converge early, unless the task explicitly asks for collaborative discussion.
- Treat inspector-visible communication logs as recipe-quality evidence. Full room/direct timelines show whether recipes coordinate clearly, emit useful summaries, over-chat, miss handoffs, choose poor message types, or need better mailbox/artifact conventions. Use `inspect room:<run> view=messages|previews`, `inspect run:<id> view=communication`, and the actor inspector table/full-message views to improve recipes after real runs.
- Smoke-test provider/model availability before launching expensive fanout, or choose a provider known to be configured in this environment. A failed provider fanout creates noisy run transitions without useful review signal.
- Keep one public communication model: `spawn` creates actors, `message` sends typed envelopes, and `inspect` observes. Avoid adding public side channels or storage nouns when a normal actor address/view can express the operation.
- Keep route and semantic type separate. Direct, room, coordinator, and session messages may share `type`; delivery behavior comes from `to`.
- Any UI, summary, or aggregate view that scans run directories must apply coordinator/session ownership filters before exposing summaries or body previews.
- Treat `communication.json` as visible actor context, not a global mutable truth table. Run-level snapshots should identify the run actor; branch-local snapshots should identify the branch actor.
- Prefer same-run provenance checks on lateral actor routes. If `from` is accepted for room or branch routes, validate that it belongs to the addressed run.

## Persistent Backlog Implementers

When using actors as backlog implementers, avoid one-shot subagents that exit after one task. Use long-lived branch actors and keep task selection with the coordinator:

1. Coordinator assigns a concrete backlog slice with `task.assign`.
2. Actor posts `task.claim` to `room:<run>` before editing.
3. Actor executes and validates the slice.
4. Actor posts `task.result` and `awaiting_assignment`.
5. Actor stays alive until the coordinator sends another `task.assign` or an explicit `control.kill`.

Use `front`/`back` actors for opposite backlog ends when reducing overlap. Implementer workflows should be packaged as reusable recipe composition, not bespoke scripts: use `coordinator-locker` for queue/assignment/locking, subagent launcher recipes for execution cells, actor-message utility recipes for structured handoffs, and `lib/mailbox-loop.ts` helpers when writing mailbox-consuming workers. Mailbox loops should claim one run or branch inbox message at a time, mark success as `handled`, mark exceptions as `failed`, and treat only `control.kill` as the generic loop termination message; `control.stop` and `control.cancel` are actor-domain messages only when the recipe declares and handles them. Bounded drains may process available work until `control.kill` or a max-message guard. If the existing recipe library cannot express the scenario, add missing reusable component recipes first, then compose the higher-level workflow from them. Supervisors should route coordinator assignments by `body.actor`, preserve the assignment as an object rather than a JSON string, and keep stopped-worker summaries tied to the original actor list.

Current packaged building blocks:

- `coordinator-locker`: long-lived queue/lock coordinator for assignment and resource ownership.
- `subagent-prompt`, `subagent-tools`, `subagents-prompts`: execution launchers for one or many agent prompts.
- `utility-actor-message`: deterministic actor-message envelope construction for handoffs/results.
- `utility-run-ops-snapshot` and `pipeline-async-run-ops`: inspect live runs/messages before deciding the next assignment.

The missing higher-level persistent backlog-implementer workflow is intentionally future work until it can be expressed from reusable recipe cells.

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

Muscle-memory lens: `~/.pi/agent/recipes/*.json` and `*.md` are the agent's capability memory. Every recipe in that directory becomes an easy-to-call tool automatically and survives into later sessions. Agents grow this memory either by calling `register_tool`, which writes recipe files there under the hood, or by deliberately editing those recipe files. Treat this directory like `MEMORY.md` for executable habits: useful local patterns belong there; packaged recipes elsewhere are reusable components, not tools.

Usage lens: user recipes may carry extension-maintained launch metadata such as `usage.calls` and `usage.last_called`. The extension increments the counter when it starts that concrete recipe; agents should not hand-edit counters as part of normal recipe maintenance. Treat usage as evidence for usefulness analysis: heavily used recipes are good candidates for promotion, documentation, or stronger tests; unused recipes are cleanup candidates. Do not use failure counts as a primary usefulness signal because failures may reflect bad caller judgment rather than bad recipes. Do not delete or demote solely from counters without operator approval.

Promotion lens: successful transient/ad hoc actor runs are evidence, not commands. If the run was repeatable, parameterized, safe enough, and likely useful later, the agent may promote it by calling `register_tool` with a concise name, typed args/defaults, and a reviewed template or recipe path. Do not wait for UI buttons; do not auto-register every success; do not persist temp paths, secrets, one-off prompts, or project-private assumptions without normalization and approval.

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

## Recipe Navigator

Use packaged recipes by name with `spawn file=<name>` for async actors, or register/call them as tools when repeated use deserves a stable shortcut. The links below point to recipe files shipped with this extension; read the JSON for args, defaults, mailbox, artifacts, and imports.

### Coordination and Services

- [`coordinator-locker`](../../recipes/coordinator-locker.json): queue + acquire/renew/release lease locks + journaled coordinator messages + platform-adapted control metadata.
- [`locker`](../../recipes/locker.json): modular queue + acquire/renew/release lease locks + journaled locker messages + platform-adapted control metadata.
- [`utility-coordinator-lock-snapshot`](../../recipes/utility-coordinator-lock-snapshot.json): one-shot JSON snapshot of a coordinator-locker state directory.
- [`music-player`](../../recipes/music-player.json): background local/URL/directory/playlist playback actor controlled by messages.
- [`actor-worker`](../../recipes/actor-worker.json): canonical mailbox-backed branch worker reference that claims branch inbox work, emits room-visible task lifecycle messages, writes compact `worker-status.json`, optionally writes per-task result artifacts under `worker-artifacts/`, surfaces stale-claim counts when `stale_claim_ms` is set, and terminates on `control.kill`.

### Subagent Atoms

- Launchers: [`subagent-prompt`](../../recipes/subagent-prompt.json), [`subagent-tools`](../../recipes/subagent-tools.json), [`subagents-prompts`](../../recipes/subagents-prompts.json).
- Review chain: [`subagent-review`](../../recipes/subagent-review.json), [`subagent-verify`](../../recipes/subagent-verify.json), [`subagent-merge`](../../recipes/subagent-merge.json), [`subagent-judge`](../../recipes/subagent-judge.json), [`subagent-normalize`](../../recipes/subagent-normalize.json).
- Planning/evidence: [`subagent-plan`](../../recipes/subagent-plan.json), [`subagent-task-card`](../../recipes/subagent-task-card.json), [`subagent-evidence-map`](../../recipes/subagent-evidence-map.json), [`subagent-contradiction-map`](../../recipes/subagent-contradiction-map.json), [`subagent-critic`](../../recipes/subagent-critic.json).
- Handoffs: [`subagent-checkpoint`](../../recipes/subagent-checkpoint.json), [`subagent-followup`](../../recipes/subagent-followup.json), [`subagent-message`](../../recipes/subagent-message.json), [`subagent-artifact`](../../recipes/subagent-artifact.json), [`subagent-conflict-report`](../../recipes/subagent-conflict-report.json).
- Composition: [`subagent-quorum`](../../recipes/subagent-quorum.json), [`subagent-review-coordinator`](../../recipes/subagent-review-coordinator.json), [`lens-swarm`](../../recipes/lens-swarm.json).

### Pipelines

- [`pipeline-release-readiness`](../../recipes/pipeline-release-readiness.json): changelog/package/skill/validation evidence → release review → artifact report.
- [`pipeline-release-summary`](../../recipes/pipeline-release-summary.json): evidence-only release summary, risk checklist, and PR body draft artifact without release side effects.
- [`pipeline-repo-health`](../../recipes/pipeline-repo-health.json): git/doc/validation evidence → normalized repository health report.
- [`pipeline-async-run-ops`](../../recipes/pipeline-async-run-ops.json): run summary + selected run messages → operations report.
- [`pipeline-docs-maintenance`](../../recipes/pipeline-docs-maintenance.json): docs index/review/planning → maintenance artifact.
- Artifacts: [`pipeline-artifact-report`](../../recipes/pipeline-artifact-report.json), [`pipeline-artifact-write`](../../recipes/pipeline-artifact-write.json), [`pipeline-artifact-bundle`](../../recipes/pipeline-artifact-bundle.json).
- Review gates: [`pipeline-quorum-review`](../../recipes/pipeline-quorum-review.json), [`pipeline-review-readiness`](../../recipes/pipeline-review-readiness.json).
- Task-first workflows: [`pipeline-architect-coordinator`](../../recipes/pipeline-architect-coordinator.json), [`pipeline-research-synthesis`](../../recipes/pipeline-research-synthesis.json), [`pipeline-development-tasking`](../../recipes/pipeline-development-tasking.json), [`pipeline-checkpoint-continuation`](../../recipes/pipeline-checkpoint-continuation.json), [`pipeline-media-library`](../../recipes/pipeline-media-library.json), [`pipeline-room-swarm`](../../recipes/pipeline-room-swarm.json). For room swarms, choose `mode` from `consensus`, `pipeline`, `fanout`, or `pool`; prefer `roles_path` for custom role JSON and keep role `name` ASCII-safe for branch addresses. Use `locker=true` when the swarm needs a coordinator-locker-backed artifact lock and journal.

### Utilities

- Repo/release evidence: [`utility-git-status`](../../recipes/utility-git-status.json), [`utility-git-log`](../../recipes/utility-git-log.json), [`utility-changelog-head`](../../recipes/utility-changelog-head.json), [`utility-changelog-section`](../../recipes/utility-changelog-section.json), [`utility-package-summary`](../../recipes/utility-package-summary.json), [`utility-skill-summary`](../../recipes/utility-skill-summary.json).
- Validation/state: [`utility-validation-wrapper`](../../recipes/utility-validation-wrapper.json), [`utility-validate-recipe`](../../recipes/utility-validate-recipe.json), [`utility-run-summary`](../../recipes/utility-run-summary.json), [`utility-run-ops-snapshot`](../../recipes/utility-run-ops-snapshot.json), [`utility-run-state-files`](../../recipes/utility-run-state-files.json), [`utility-jsonl-tail`](../../recipes/utility-jsonl-tail.json).
- Artifacts/media/messages: [`utility-artifact-manifest`](../../recipes/utility-artifact-manifest.json), [`utility-artifact-write`](../../recipes/utility-artifact-write.json), [`utility-actor-message`](../../recipes/utility-actor-message.json), [`utility-markdown-index`](../../recipes/utility-markdown-index.json), [`utility-playlist-scan`](../../recipes/utility-playlist-scan.json), [`utility-playlist-build`](../../recipes/utility-playlist-build.json).

Deep inventory: [`docs/recipe-library.md`](../../docs/recipe-library.md).

## Operating Patterns

- **Short deterministic command**: call foreground registered tool or command template.
- **Long job/service/fanout**: `spawn` async recipe, then inspect/messages/artifacts.
- **One-off experiment**: inline `template`; promote after repeat use.
- **Reusable workflow**: packaged or user recipe with public knobs, mailbox, artifacts, docs.
- **Subagent/swarm execution**: compose packaged recipes/pipelines from smaller recipe cells; add missing generic cells to the extension rather than creating one-off external orchestration scripts.
- **Consensus-first build**: when many lenses should shape one artifact, have proposer subagents post room messages, then one named implementer writes, one QA reviewer checks, and one finalizer emits `run.done`; do not ask every lens to mutate the same artifact.
- **Coordinated workers**: spawn `coordinator-locker` when several actors need a shared queue, acquire/renew/release resource leases, or a journaled coordination point.
- **Release/review pipeline**: pi-actors can prepare evidence, summaries, and artifacts; external actions such as commit, PR, merge, tag, and publish require the appropriate gated release workflow.

## Complementary Methodology Engines

pi-actors is the local execution engine for methodology skills. A methodology skill can define abstract patterns such as lens swarm, quorum, task cards, lock discipline, consensus-first build, or clean-context merge; pi-actors turns those patterns into concrete local actors, recipes, queues, leases, artifacts, and messages.

Example mapping:

```text
methodology says: protect shared files
pi-actors does: spawn coordinator-locker, enqueue tasks, lease resources

methodology says: run reviewers then merge
pi-actors does: spawn review pipeline, inspect messages/artifacts
```

Keep the split clean: methodology chooses coordination shape; pi-actors supplies addressable local machinery.

## Lifecycle Discipline

1. Choose existing recipe/tool when available.
2. Spawn with a stable actor id for observable work.
3. Inspect `status` after launch.
4. Use notifications and `inspect`; do not busy-poll.
5. Read `messages` and `artifacts`, not only stdout.
6. Use `message` for explicit control or domain commands; treat direct branch messages as intended initiating work. Direct branch envelopes are queued under the recipient branch inbox and can be inspected with `inspect branch:<run>/<branch> view=mailbox`; queued entries have stable `id` values and internal `claimed` / `handled` / `failed` states for worker protocols and retries. Room messages are shared transcript/context.
7. Promote repeated inline forms to recipes.
8. Keep recipes small and shallow: files over 1 MiB or import chains deeper than 32 are rejected.
9. Update docs/context when changing public behavior; if the change affects how agents operate this extension, update this skill and the bundled prompt guidance too.

## Common Pitfalls

- Treating actor mechanics as multi-agent methodology.
- Repeating inline templates instead of promoting recipes.
- Creating task-specific external orchestration scripts when the scenario belongs in pi-actors as a reusable recipe/pipeline with prompts, roles, artifact paths, and model/tool policy passed as args.
- Embedding complex shell loops or Bash `${...}` parameter expansion directly in command templates; braces are pi-actors placeholders too, so put only generic trusted helper cells in packaged scripts when command-template composition is not enough.
- Omitting stable run ids for work that needs follow-up.
- Sending domain messages without checking `mailbox`.
- Expecting current room messages to wake prompt-only subagents; use direct branch messages or a runner protocol for initiating work.
- Reading only stdout and missing actor messages/artifacts.
- Assuming every packaged message-controlled script is native-Windows-ready; core run control is platform-adapted, but Unix-tool scripts must be migrated recipe by recipe.
- Baking local absolute paths into published docs or reusable recipes.
- Creating recipes that perform external side effects without explicit operator gates.
- Letting project insights live only in chat instead of updating BACKLOG/CHANGELOG/docs and, when agent behavior changes, the packaged skill or prompt guidance.
- Preserving old runtime/event/FIFO vocabulary instead of `spawn`/`message`/`inspect` and actor messages.

## Deep References

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
