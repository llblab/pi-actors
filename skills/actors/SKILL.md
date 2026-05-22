---
name: actors
description: Highest-density practical guide for pi-actors. Read this skill whenever prompt and tools are not enough for spawn, message, inspect, actor runs, tools, recipes, command templates, async lifecycle, mailboxes, artifacts, and local orchestration mechanics.
metadata:
  version: 0.16.2
---

# Actors (pi-actors)

`pi-actors` turns trusted local capabilities into addressable actors. This skill is the compact operator/reference layer for the extension itself: tools, nouns, lifecycle, message protocol, recipes, and common edge cases. It is not a multi-agent strategy guide; use a swarm skill for decomposition, quorum design, reviewer lenses, and consensus methodology.

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
- **Run actor**: one detached execution instance addressable as `run:<id>` with status, logs, messages, mailbox metadata, files, and artifacts.
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
- Addresses: `run:<id>`, `branch:<run>/<branch>`, `tool:<name>`, `coordinator`, `session:<id>`.
- Standard termination messages: `control.stop`, `control.cancel`, `control.kill`.

Check `inspect view=mailbox` before domain-specific messages.

### `inspect` — observe intentionally

```json
{ "target": "run:repo-health", "view": "status" }
{ "target": "run:repo-health", "view": "tail", "lines": "80" }
{ "target": "run:repo-health", "view": "messages" }
{ "target": "run:repo-health", "view": "artifacts" }
{ "target": "tool:music_player", "view": "status" }
{ "target": "recipes", "view": "status" }
{ "target": "coordinator", "view": "status" }
```

Views:

- `status`: lifecycle, pid, values, progress, result, compact summary.
- `tail`: recent stdout/stderr/log tail.
- `messages`: actor messages emitted by the run.
- `mailbox`: declared accepts/emits contract.
- `files`: run state directory file list.
- `artifacts`: declared artifact paths/status.
- `recipes` target: registry summary for active, shadowed, invalid, disabled, and diagnostic recipe entries.

Let terminal notifications arrive; avoid sleep-poll loops except during diagnosis.

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
  "name": "my-task",
  "async": true,
  "args": ["path:path", "model:string"],
  "defaults": {},
  "mailbox": {
    "accepts": ["control.stop", "control.cancel", "control.kill"],
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
7. Recipe identity comes from the filename basename when `name` is omitted.
8. Keep packaged recipes generic: no machine-local paths, no private companion identities, no project-specific defaults unless the recipe is explicitly project-specific.
9. Do not ship concrete model-version defaults in packaged recipes; expose `model`, `models`, and stage-specific model args so the caller must choose current policy at launch.

Priority for same-name recipes:

1. No recipe: no capability.
2. Packaged pi-actors recipe: standard-library declarative actor component.
3. Explicit ad hoc user recipe file outside `~/.pi/agent/recipes`.
4. User recipe in `~/.pi/agent/recipes/*.json`: highest-priority operator tool surface.

Only matching filename ids compete. Higher priority shadows lower priority. An invalid or `disabled: true` higher-priority recipe blocks fallback so the agent does not silently run standard-library behavior when a user override is broken or intentionally disabled.

Muscle-memory lens: every recipe in `~/.pi/agent/recipes/*.json` becomes an easy-to-call tool by default. This is intentionally sticky: successful local patterns can quickly become durable agent muscle memory. The tradeoff is tool-surface clutter; accidental or one-off tools behave like persistent intrusive thoughts until an agent/operator focuses on cleanup.

Usage lens: user recipes may carry extension-maintained launch metadata such as `usage.calls` and `usage.last_called`. The extension increments the counter when it starts that concrete recipe; agents should not hand-edit counters as part of normal recipe maintenance. Treat usage as evidence for usefulness analysis: heavily used recipes are good candidates for promotion, documentation, or stronger tests; unused recipes are cleanup or `tool: false` candidates. Do not use failure counts as a primary usefulness signal because failures may reflect bad caller judgment rather than bad recipes. Do not delete or demote solely from counters without operator approval.

Cleanup rule: periodically inspect `~/.pi/agent/recipes` as the live muscle-memory set. For each stale, duplicate, too-specific, or low-value recipe, choose one explicit action: keep as a tool, set `tool: false` to retain recipe-only memory, merge into a better recipe, or delete/archive the file. Prefer demotion over deletion when the recipe may still be useful as a component. Never silently remove tools during unrelated work.

## Registered Tools

`register_tool` persists trusted local capabilities as recipe files in `~/.pi/agent/recipes/*.json`.

Use it when a command/template/recipe should become durable agent muscle memory. Prefer typed args or placeholder-derived args; use `update=true` for replacement and `template=null` or `template=""` for deletion. `register_tool` should create/update/delete recipe files in the user recipe root; direct file editing is allowed but is the lower-level path.

Tool templates may be:

- A foreground command template.
- A file-backed recipe name/path.
- A complete recipe body, optionally `async: true`.

The user recipe root is the default tool set; packaged recipes are the lower-priority standard library and opt into tool exposure with `tool: true`. Ideal runtime behavior is reactive: create/edit/delete recipe files, validate them, then connect valid tools or surface diagnostics without requiring agents to hand-maintain a separate registry.

## Recipe Navigator

Use packaged recipes by name with `spawn file=<name>` for async actors, or register/call them as tools when repeated use deserves a stable shortcut. The links below point to recipe files shipped with this extension; read the JSON for args, defaults, mailbox, artifacts, and imports.

### Coordination and Services

- [`coordinator-locker`](../../recipes/coordinator-locker.json): queue + acquire/renew/release lease locks + journaled coordinator messages.
- [`utility-coordinator-lock-snapshot`](../../recipes/utility-coordinator-lock-snapshot.json): one-shot JSON snapshot of a coordinator-locker state directory.
- [`music-player`](../../recipes/music-player.json): background local/URL/directory/playlist playback actor controlled by messages.

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
- Task-first workflows: [`pipeline-architect-coordinator`](../../recipes/pipeline-architect-coordinator.json), [`pipeline-research-synthesis`](../../recipes/pipeline-research-synthesis.json), [`pipeline-development-tasking`](../../recipes/pipeline-development-tasking.json), [`pipeline-checkpoint-continuation`](../../recipes/pipeline-checkpoint-continuation.json), [`pipeline-media-library`](../../recipes/pipeline-media-library.json).

### Utilities

- Repo/release evidence: [`utility-git-status`](../../recipes/utility-git-status.json), [`utility-git-log`](../../recipes/utility-git-log.json), [`utility-changelog-head`](../../recipes/utility-changelog-head.json), [`utility-changelog-section`](../../recipes/utility-changelog-section.json), [`utility-package-summary`](../../recipes/utility-package-summary.json), [`utility-skill-summary`](../../recipes/utility-skill-summary.json).
- Validation/state: [`utility-validation-wrapper`](../../recipes/utility-validation-wrapper.json), [`utility-validate-recipe`](../../recipes/utility-validate-recipe.json), [`utility-run-summary`](../../recipes/utility-run-summary.json), [`utility-run-ops-snapshot`](../../recipes/utility-run-ops-snapshot.json), [`utility-run-state-files`](../../recipes/utility-run-state-files.json), [`utility-jsonl-tail`](../../recipes/utility-jsonl-tail.json).
- Artifacts/media/messages: [`utility-artifact-manifest`](../../recipes/utility-artifact-manifest.json), [`utility-artifact-write`](../../recipes/utility-artifact-write.json), [`utility-actor-message`](../../recipes/utility-actor-message.json), [`utility-markdown-index`](../../recipes/utility-markdown-index.json), [`utility-playlist-scan`](../../recipes/utility-playlist-scan.json), [`utility-playlist-build`](../../recipes/utility-playlist-build.json).

Deep inventory: [`docs/recipe-library.md`](../../docs/recipe-library.md).

## Operating Patterns

- **Short deterministic command**: call foreground registered tool or command template.
- **Long job/service/fanout**: `spawn` async recipe, then inspect/messages/artifacts.
- **One-off experiment**: inline `template`; promote after repeat use.
- **Reusable workflow**: recipe with public knobs, mailbox, artifacts, docs.
- **Subagent/swarm execution**: actor mechanics here; methodology belongs to swarm guidance.
- **Coordinated workers**: spawn `coordinator-locker` when several actors need a shared queue, acquire/renew/release resource leases, or a journaled coordination point.
- **Release/review pipeline**: pi-actors can prepare evidence, summaries, and artifacts; external actions such as commit, PR, merge, tag, and publish require the appropriate gated release workflow.

## Complementary Methodology Engines

pi-actors is the local execution engine for methodology skills. A methodology skill can define abstract patterns such as lens swarm, quorum, task cards, lock discipline, or clean-context merge; pi-actors turns those patterns into concrete local actors, recipes, queues, leases, artifacts, and messages.

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
6. Use `message` for explicit control or domain commands.
7. Promote repeated inline forms to recipes.
8. Update docs/context when changing public behavior.

## Common Pitfalls

- Treating actor mechanics as multi-agent methodology.
- Repeating inline templates instead of promoting recipes.
- Omitting stable run ids for work that needs follow-up.
- Sending domain messages without checking `mailbox`.
- Reading only stdout and missing actor messages/artifacts.
- Baking local absolute paths into published docs or reusable recipes.
- Creating recipes that perform external side effects without explicit operator gates.
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
