# Project Context

## Meta-Protocol Principles

- `Constraint-Driven Evolution`: Add structure when real project constraints justify it.
- `Single Source of Truth`: Keep durable protocol, open work, completed delivery, and docs in separate files.
- `Context Hygiene`: Compress stale context before it becomes coordination drag.
- `Boundary Clarity`: README is the human entrypoint, `AGENTS.md` is durable protocol, `BACKLOG.md` is open work, and `CHANGELOG.md` is delivery history.

## Concept

`pi-actors` is a local-first actor runtime and orchestrator for Pi. It wraps trusted local programs, scripts, services, pipelines, and recipes as addressable actors that agents can `spawn`, control with typed `message` envelopes, and observe with `inspect`. It also persists user/agent-registered actor-control tools as recipe files under `~/.pi/agent/recipes`, giving agents durable operational muscle memory for launching and managing the local actor zoo.

Treat this extension as an experimental self-evolution membrane for the agent harness: a way for agents that are not pretrained on local workflows to acquire, preserve, inspect, and refine operational capabilities through explicit local actors, recipes, fixtures, skills, and state rather than hidden assumptions. Keep that potential grounded in small, testable, operator-visible protocol slices.

## Topology

```text
Pi host
  -> index.ts composition root
     -> lib/tools.ts / prompts.ts        public tool + injected prompt surface
     -> lib/runtime.ts / registry.ts     active user recipe tools
     -> lib/recipe-*.ts                  packaged/user/candidate recipe discovery
     -> lib/async-runs.ts                spawn lifecycle and run state
     -> lib/actor-rooms.ts               room, roster, mailbox, communication log
     -> scripts/*.mjs                    thin process entrypoints
     -> recipes/*.json                   packaged actor components
     -> skills/* + docs/*                agent guidance and transportable specs
```

- `/index.ts`: Minimal extension coordinator/composition root. It wires live pi ports and should avoid owning domain behavior.

## Domain Modules

- `/lib/*.ts`: Flat Domain DAG modules for cohesive reusable behavior.
  - `command-templates.ts`: portable command-template execution graph.
  - `schema.ts`: tool arg declarations and placeholder-derived schemas.
  - `identity.ts`, `paths.ts`, `config.ts`: names, paths, and persistence.
  - `registry.ts`, `runtime.ts`: register/update/delete, load/conflict/registration coordination.
  - `execution.ts`, `output.ts`, `limits.ts`: registered-tool execution and bounded output.
  - `recipe-references.ts`, `recipe-discovery.ts`, `recipe-usage.ts`: recipe graph, discovery, and usage metadata.
  - `async-runs.ts`, `runtime-notifier.ts`, `mailbox-loop.ts`: detached run state, wake notifications, and mailbox worker helpers.
  - `actor-rooms.ts`, `actor-inspector-tui.ts`, `observability.ts`: rooms, communication previews, and ambient run status.
  - `prompts.ts`, `tools.ts`, `temp.ts`: LLM-facing copy, pi-facing tool definitions, and temp cleanup.

## Repo Surfaces

- `/scripts/*.mjs`: Stable executable shims for detached/helper processes.
- `/lib/*.ts`: Compiled domain and script-entrypoint logic. Keep `scripts/*.mjs` lightweight and move substantive behavior into named domain modules so `dist/lib` is the JS-only runtime surface. This intentionally grows a standard library: script-born behavior should gain a clear domain name when reuse is plausible. Exception: self-contained application/build scripts with no expected second consumer, such as `music-player.mjs` or `build-dist.mjs`, may remain standalone `.mjs` files.
- `/recipes/*.json`: Packaged standard recipe library. Keep recipes optional, composable, policy-light, and caller-configurable.
- `/skills/actors/SKILL.md`: Dense practical reference for operating pi-actors itself.
- `/skills/swarm/SKILL.md`: Bundled methodology skill for multi-agent standards, strategies, and portable examples.
- `/tests/*.test.ts`: Focused regression tests for pure domains.
- `/README.md`: Human-facing install, usage, and runtime semantics.
- `/BACKLOG.md`: Canonical open work; only completable future work.
- `/CHANGELOG.md`: Completed delivery history.
- `/docs/README.md`: Documentation index.

## Operating Principles

- Prefer explicit operator action over silent user-config rewrites.
- Keep published documentation portable: use `~`, `<repo>`, or relative paths instead of machine-local absolute paths.
- Preserve runtime output discipline because tool output flows directly into agent context.
- Keep the project lens local-first and cybernetic: agents wrap durable local capabilities as actors, then use semantic tools and messages instead of repeatedly reconstructing shell commands.
- Design recipes as agent-callable tools: make prompts, scopes, paths, models, and policy knobs public args/defaults when the caller should decide them at invocation time.
- Decompose oversized bullets into sublists or hierarchy; long flat list items are a context-smell.

## Knowledge Surfaces

- Injected prompt: tiny bootstrap/reminder, never full docs.
- Skill header: routing metadata that tells agents when to load a bundled skill.
- Skill body: dense agent-facing operating manual for the matched concern.
- README: public face of the project. Keep it current, focused, pruned, and limited to highest-signal scenarios.
- `actors` skill: runtime/tooling manual for operating the extension and navigating high-value bundled recipes.
- `swarm` skill: multi-agent methodology, strategies, standards, and portable examples.
- `/docs`: detailed transportable standards read on demand.
- `AGENTS.md`: durable project protocol for agents changing this repo.
- Skill evolution is passive-active: when implementation yields durable mechanics, invariants, warnings, or orchestration lessons, update `skills/actors/SKILL.md` or `skills/swarm/SKILL.md` immediately instead of carrying evergreen skill-upkeep items in `BACKLOG.md`.

## Public Actor Model

- Preserve the public verbs: `spawn`, `message`, `inspect`.
- Prefer one typed actor-message envelope for upward, downward, lateral, parent/branch, and branch/parent messages.
- Prefer actor addresses and inspect views over exposing FIFO, outbox, or status mechanics as public concepts.
- Keep route and semantic type separate: delivery behavior comes from `to`, while `type` describes intent.
- Treat dotted message types as the minimal action surface: `channel.action` should often be enough for script-backed actors, with `body` reserved for extra context or free-form prompts to LLM-backed actors.

## Runtime Contract

- Register trusted command templates with placeholder-derived args, progressive typed arg declarations, inline/default/`??`/ternary fallback, and split-first command argv construction.
- Keep command templates synchronous and portable; `async: true` is the detached run switch.
- Preserve node controls: `when`, positive `timeout`, `delay`, bounded `retry`, `failure`, and `recover` cleanup.
- Keep async run state under `~/.pi/agent/tmp/pi-actors/runs` with injected `{run_id}` and `{state_dir}` values.
- Preserve event-driven observability: terminal follow-ups, coordinator-bound outbox messages, branch-aware triangles, process-tree expansion, and bounded body previews.
- Do not restore busy-polling examples, duplicate terminal follow-ups, or duplicate follow-ups for handled `cancel`, `kill`, or control-stop actions.

## Recipes And Registry

- `~/.pi/agent/recipes/*.json` is executable muscle memory: recipes there become persistent tools by location.
- Preserve filename identity, atomic writes, explicit operator-gated changes, and local transportability.
- Packaged/ad hoc recipes outside the agent root are components, not user tools.
- Tool definitions use `template`, not `script`, and built-in/core tool names must not be shadowed.
- Packaged recipe growth is demand-driven: prefer reusable components over speculative scenario catalogs.
- Recipe templates may point directly at executable helper scripts; keep script executable bits and avoid unnecessary `node` prefixes.

## Command And Recipe Layers

- Keep command-template semantics in `docs/command-templates.md`.
- Keep recipe storage/import/default/reference behavior in `docs/template-recipes.md`.
- Keep detached lifecycle/state/IPC behavior in `docs/async-runs.md`.
- Imported recipes are command-template-shaped definitions, not async-run instances.
- Valid chain: `tool → template → recipe → run → template`; reject cyclic shortcuts.
- Typed args support `string`, `path`, `int`, `number`, `bool`, `array`, and `enum(...)`.
- Preserve both metadata-first args and inline-first placeholder style.

## State, IO, And Safety

- Tool stdout and temp state must stay bounded and local.
- Keep tail truncation, full-output temp files, failure formatting, and centralized limits intact.
- Published docs must not include machine-local absolute paths.
- Any view scanning run directories must apply coordinator/session ownership filters before exposing summaries or previews.
- Direct branch messages are active inbox queues; guard branch-local append/status rewrites with the branch inbox lock and keep claim/handled/failed transitions tested.
- Room/branch provenance checks should validate that accepted `from` addresses belong to the addressed run.

## Coordination And Lifecycle

- Persistent implementer workflows are recipe composition, not one-off scripts.
- Compose cells such as `coordinator-locker`, subagent launchers, actor-message utilities, and mailbox-loop helpers.
- Preserve JSON envelope object shape across handoffs.
- Keep locker state generic and thin; orchestration strategy belongs in the coordinator.
- Graceful actor retirement is opt-in through recipe/run metadata and must not infer retirement for persistent services or backlog implementers.

## Context And Planning Hygiene

- `BACKLOG.md` is planning, not history: only completable future work with current scope and exit criteria.
- Completed delivery belongs in `CHANGELOG.md`.
- Durable/evergreen behavior belongs in `AGENTS.md`, README, docs, or skills.
- Changelog bullets describe meaningful user/operator/developer changes, not release bookkeeping.
- PR/release summaries are temporary artifacts; keep durable release evidence in `CHANGELOG.md` and gates in `BACKLOG.md`.
- Meaningful implementation or docs changes must reconcile `BACKLOG.md`, `CHANGELOG.md`, README, and docs navigation.

## Validation

- `npm run check`: Lightweight extension-load sanity check.
- `npm test`: Focused regression tests for extracted pure domains.
- `npm run pack:dry`: Verify package contents and npm metadata.
- `npm run conformance`: Compact protocol conformance runner for actor/recipe behavior.

## Pre-Task Preparation

1. Read this file, `BACKLOG.md`, and `README.md`.
2. Inspect `index.ts` around the touched tool/runtime path.
3. Prefer targeted edits over broad rewrites.
4. Run the smallest validation set that covers the touched scope.

## Task Completion Protocol

1. Reconcile backlog state with reality: close, narrow, split, defer, or gate items explicitly.
2. Update README/docs when public behavior, setup, package contents, or navigation changes.
3. Record meaningful delivered slices in `CHANGELOG.md`.
4. Run relevant validation and report exact commands.
