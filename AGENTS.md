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
     -> lib/tools*.ts / prompts.ts      public tool + injected prompt surface
     -> lib/runtime.ts / registry.ts     active user recipe tools
     -> lib/recipes-*.ts                 packaged/user/draft recipe discovery
     -> lib/async-runs.ts                spawn lifecycle and run state
     -> lib/rooms.ts               room, roster, mailbox, communication log
     -> scripts/*.mjs                    self-contained process entrypoints
     -> recipes/*.json                   packaged actor components
     -> skills/* + docs/*                agent guidance and transportable specs
```

- `/index.ts`: Minimal extension coordinator/composition root. It wires live pi ports and should avoid owning domain behavior.

## Domain Modules

- `/lib/*.ts`: Flat Domain DAG modules for cohesive reusable behavior.
  - `command-templates.ts`: portable command-template execution graph.
  - `tools-access.ts`: shared public tool access/session ownership guards and normalized mismatch diagnostics.
  - `tools-mailbox.ts`: mailbox contract normalization and accepted/emitted message type helpers for public tool responses.
  - `schema.ts`: tool arg declarations and placeholder-derived schemas.
  - `identity.ts`, `paths.ts`, `config.ts`: names, paths, and persistence.
  - `registry.ts`, `runtime.ts`: register/update/delete, load/conflict/registration coordination.
  - `execution.ts`, `execution-output.ts`, `limits.ts`: registered-tool execution and bounded output.
  - `recipes-references.ts`, `recipes-discovery.ts`, `recipes-usage.ts`, `draft-review.ts`, `draft-sleep.ts`, `tool-review.ts`, `tool-review-scheduler.ts`, `tool-review-transaction.ts`, `tool-review-lineage.ts`, `tool-review-lineage-transaction.ts`, `review-projection.ts`, `review-diagnostics.ts`, `review-control.ts`, `draft-consolidation.ts`, `draft-consolidation-transaction.ts`: recipe graph/discovery, automatic review admission, journaled filesystem and lineage execution/recovery, and bounded diagnostics.
  - `async-runs.ts`: detached run lifecycle facade; `runs-*` subdomains own artifacts, start guards, status, indexes, inbox/outbox, delivery, process control, and retention internals.
  - `runtime-notifier.ts`, `mailbox-loop.ts`: wake notifications and reusable run/branch mailbox worker loops.
  - `messages.ts`, `rooms.ts`, `recipes-context.ts`, `session-evidence.ts`, `inspector.ts`, `inspector-overlay.ts`, `observability.ts`: addressed message protocol, rooms, recipe prompt context, bounded/redacted child-session turns, inspector evidence/navigation, keyboard-driven overlay UI, and ambient run status.
  - `prompts.ts`, `temp.ts`: LLM-facing copy and temp cleanup.
  - `automatic-review-runtime.ts`, `run-ui-runtime.ts`, `inspector-command.ts`: session-bound review composition, ambient run-observability lifecycle, and Inspector host-command adapters kept outside the entrypoint.
  - `tools.ts`: public tool family composition and reserved tool names.
  - `tools-message.ts`: public `message` tool behavior, including run controls, branch/room routing, tool actor invocation, and delivery feedback.
  - `tools-inspect.ts`: public `inspect` tool behavior, including recipe registry, room/session/tool/run views, and observation formatting.
  - `tools-spawn.ts`: public `spawn` tool behavior, including actor launch, draft recipe capture, and launch diagnostics.
  - `tools-local.ts`: saved local capability execution, generated schemas, value normalization, and async recipe launch.
  - `tools-register.ts`: public `register_tool` behavior and schema for persisted local capability registration.
  - `tools-response.ts`: compact model-facing responses and next-action rendering shared by public tool execution paths.

## Repo Surfaces

- `/scripts/*.mjs`: Stable executables for detached/helper processes. Prefer self-contained script ownership; do not preemptively move script logic into `lib/` just to make scripts thin.
- `/lib/*.ts`: Compiled reusable domains for the extension/runtime. Move script behavior into `lib/` only when it has real non-script consumers or belongs to an existing reusable domain. Packaged JS-only execution, tests, or shim neatness alone do not justify a new `lib/` domain.
- `/recipes/*.json`: Packaged standard recipe library. Keep recipes optional, composable, policy-light, and caller-configurable.
- `/skills/actors/SKILL.md`: Dense practical reference for operating pi-actors itself.
- `/skills/swarm/SKILL.md`: Bundled methodology skill for multi-agent standards, strategies, and portable examples.
- `/tests/*.test.ts`: Focused regression tests for pure domains.
- `/README.md`: Human-facing install, usage, and runtime semantics. Keep it as a product/onboarding entrypoint rather than an implementation dump: identity → why it exists → core verbs → install → first run → address/message model → feature showcase → golden path → recipe memory → platform/safety/docs. Preserve both layers: strong local-actor-kernel positioning plus compact practical capability catalog.
- `/BACKLOG.md`: Canonical open work; only completable future work.
- `/CHANGELOG.md`: Completed delivery history.
- `/docs/README.md`: Documentation index.

## Operating Principles

- Automatic recipe evolution remains silent but mechanically fenced: no-tools reviewers select lifecycle/name operations from value-free structural projections without receiving recipe bodies, template/default values, authored prose, canonical names, draft basenames, raw content hashes, or filesystem paths; batch-local opaque occurrence IDs and equality-only content groups preserve decision correlation and deduplication, while sensitive active recipes stay outside model review as defense in depth, deterministic executors derive unchanged recipes from separate trusted captures, and safe-session activation separates approval from live registry mutation. `PI_ACTORS_AUTOMATIC_REVIEW=off` is the explicit startup opt-out and must disable both scheduling and safe-boundary activation while remaining visible in runtime status. Automatic portfolio review may keep, demote, rename, or deduplicate canonically identical recipes; replacement, split, and executable contract changes require explicit operator authoring. Transactions must hold canonical source/target locks, enforce compare-and-swap preconditions, preserve complete recipes, quarantine before commit, journal process-crash recovery phases, validate recovery CAS/hashes, and derive evidence from runtime outcomes. Prefer `register_tool draft=...` for a fenced manual single-draft override; deliberate filesystem promotion remains valid but may invalidate and defer an already captured batch.
- Keep published documentation portable: use `~`, `<repo>`, or relative paths instead of machine-local absolute paths.
- Preserve runtime output discipline because tool output flows directly into agent context. Tool result/error text contributes exactly one leading line break; Pi's renderer contributes the other break after the call header, producing one empty separator row without doubled gaps.
- Optimize every actor-facing surface for signal over volume: prefer compact state-backed hints and fewer concepts over broad explanatory prose or speculative guidance.
- Split broad domains proactively when the current name becomes a generic bucket. Prefer concise domain names that match actual ownership. `tools.ts` is the public tool family owner; decomposed tool subdomains use `tools-<part>.ts` (`tools-message.ts`, `tools-inspect.ts`, `tools-spawn.ts`) under that family. Keep only genuinely cross-family domains unprefixed (`schema.ts`); tool-only helpers stay under `tools-*`. If a `tools-*` helper becomes reused by non-tools domains, remove the `tools-` prefix in the same slice and update ownership comments/imports so the name matches its broader responsibility. Avoid redundant internal `actor-` file prefixes in this actor-scoped package unless the file is deliberately tied to a public actor-named recipe/script/docs surface.
- Until a stable release greater than `1.x.x`, favor context compression over compatibility shims: do not preserve legacy actor-facing names, aliases, fields, env vars, paths, or docs solely for backward compatibility when a clearer current term exists. Remove compatibility layers in the same slice that renames a concept, and record the break in `CHANGELOG.md`.
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
- Keep the model-facing concept ladder minimal: core is run actors, typed messages, intentional inspection, artifacts, and recipe/tool memory; group messaging, roster, branches, sessions, and diagnostics are advanced surfaces.
- Prefer one typed actor-message envelope for upward, downward, lateral, parent/branch, and branch/parent messages.
- Prefer actor addresses and inspect views over exposing FIFO, outbox, or status mechanics as public concepts.
- Keep route and semantic type separate: delivery behavior comes from `to`, while `type` describes intent.
- Treat dotted message types as the minimal action surface: `channel.action` should often be enough for script-backed actors, with `body` reserved for extra context or free-form prompts to LLM-backed actors.

## Runtime Contract

- Register trusted command templates with placeholder-derived args, progressive typed arg declarations, inline/default/`??`/ternary fallback, and split-first command argv construction.
- Serialize extension-authored recipe mutations with canonical-path locks across each complete check/read/write/runtime-update window; keep usage and lineage evidence in the locked `.usage/recipes/<recipe-name>.json` ledger plus path index so metadata cannot overwrite authored recipes, and do not replace keyed recipe locking with a broad registry lock. Launch accounting is the narrow exception: it briefly shares the portfolio transaction’s canonical recipe-root fence before taking index/ledger locks, so quarantine cannot make an already-authorized launch disappear; a source that changed before that fence rejects the stale launch and asks for reload.
- Keep command templates synchronous and portable; `async: true` is the detached run switch.
- Preserve node controls: `when`, positive `timeout`, `delay`, bounded `retry`, `failure`, and `recover` cleanup.
- Persist every async command's complete byte-exact stdout/stderr under command- and retry-specific run-state paths while keeping returned tails bounded and pipeline stdin complete.
- Keep async run state under `~/.pi/agent/tmp/pi-actors/runs` with injected `{run_id}` and `{state_dir}` values.
- Preserve event-driven observability with bounded reconciliation: file watchers accelerate durable retrying terminal follow-up notifications, while a conservative terminal-only interval recovers missed watcher activity, rearms degraded watchers, and never replays outbox traffic. Queue coordinator context through Pi follow-up delivery rather than steering so current work finishes before async results arrive and host follow-up batching policy can combine concurrent completions. Terminal delivery is at-least-once across the unavoidable send/handled-marker crash window; watch-triggered and periodic delivery share one live-runtime in-flight guard.
- When a deferred actor result gates the next step, wait for its terminal follow-up. Do not schedule continuation loops, repeatedly inspect, or mutate its reviewed scope while it runs; inspect early only on operator request, meaningful actor event, or diagnosis of an overdue/stuck run.
- Do not restore busy-polling examples, duplicate terminal notifications, or duplicate notifications for handled `cancel`, `kill`, or control-stop actions.

## Recipes And Registry

- `~/.pi/agent/recipes/*.json` is executable muscle memory: recipes there become persistent tools by location.
- Preserve filename identity, atomic writes, explicit operator-gated changes, and local transportability. Extension-authored draft creation must take the same canonical per-path mutation lock used by consolidation so source compare-and-swap and quarantine cannot race a writer.
- Recipe live reload must watch the parent when the user recipe root is absent, switch to the root watcher when it appears, and rearm after deletion/rename without polling or duplicate watcher ownership. Every callback must compare its exact watcher instance before closing, replacing, notifying, or scheduling so delayed callbacks from closed generations cannot affect the current watcher.
- Packaged/ad hoc recipes outside the agent root are components, not user tools.
- Register existing recipes by importing them from the user-root wrapper and using a `{ "name": "alias" }` template node; do not duplicate a ready recipe's script command, defaults, mailbox, or artifact contract in the wrapper.
- Skill-owned scripts must be exposed through skill-owned recipes first. If a local tool needs that capability, import the skill recipe via `{agent}/skills/<skill>/recipes/<recipe>.json` instead of calling `{agent}/skills/<skill>/scripts/*` directly.
- Tool definitions use `template`, not `script`, and built-in/core tool names must not be shadowed.
- Host registrations may remain visible because Pi cannot unregister dynamic definitions, but extension-local `message` and `inspect` lookup must consult the current runtime recipe registry before returning or executing a cached definition.
- Packaged recipe growth is demand-driven: prefer reusable components over speculative scenario catalogs.
- Recipe templates may point directly at executable helper scripts when the recipe owns that script boundary; keep script executable bits and avoid unnecessary `node` prefixes.

## Command And Recipe Layers

- Keep command-template semantics in `docs/command-templates.md`.
- Keep recipe storage/import/default/reference behavior in `docs/template-recipes.md`.
- Keep detached lifecycle/state/IPC behavior in `docs/async-runs.md`.
- Imported recipes are command-template-shaped definitions, not async-run instances.
- Valid chain: `tool → template → recipe → run → template`; reject cyclic shortcuts.
- Typed args support `string`, `path`, `int`, `number`, `bool`, `array`, and `enum(...)`.
- Preserve both metadata-first args and inline-first placeholder style.

## State, IO, And Safety

- Tool stdout and temp state must stay bounded and local; preserve complete high-volume streams in spill files with byte/truncation metadata, and never feed a truncated capture tail into pipeline stdin.
- Feedback hints must be evidence-backed, bounded, and action-shaped; prefer `next_actions` pointing to existing verbs over prose, and avoid hints when no concrete next step is justified.
- Keep tail truncation, full-output temp files, failure formatting, and centralized limits intact.
- Published docs must not include machine-local absolute paths.
- Any view scanning run directories must apply coordinator/session ownership filters before exposing summaries or previews.
- Actor Inspector remains evidence-first; its `Kill` action is available only for a focused owned running run, requires in-overlay confirmation, revalidates exact ownership/status at action time, routes through canonical `control.kill`, and renders bounded success/failure feedback without direct process signaling.
- Direct branch messages are active inbox queues; guard branch-local append/status rewrites with the branch inbox lock and keep claim/handled/failed transitions tested.
- Run-state launch and destructive retention require the runtime ownership marker bound to the canonical directory and run id; reject non-run directories, missing/mismatched markers, and symlink aliases rather than trusting `run.json`.
- Runner lifecycle and destructive process controls require the persisted cross-platform process identity proof (start time, command, and cwd where available), revalidated at authorization and immediately before signaling; dead, mismatched, or unsupported proofs stay distinct and fail closed rather than degrading to pid liveness. On Unix, only process-group `ESRCH` followed by another matching identity proof permits exact-pid fallback. Keep the residual post-read OS PID/PGID reuse window explicit because Node lacks one portable identity-stable group handle.
- Automatic draft review may schedule one silent review after ordinary `agent_end` only when twelve drafts exist and no actor is running; it must snapshot an exact batch, leave newer drafts for later, suppress routine terminal/outbox delivery, and never mutate recipes from the reviewer process.
- Automatic tool review seeds zero-call lineage without fabricating launches, admits only current non-sensitive revisions lacking a review fingerprint, captures exactly thirty-six oldest eligible active user tools, and uses the same silent post-turn/active-actor boundary. Completed output becomes a size-bounded immutable approval only after result validation plus source and target CAS; approval must not mutate the live registry. Approved filesystem mutation uses intent-before-mutation journaling and source quarantine, composition invokes it only during `session_start` before runtime tool loading, persists `lineage_pending`, and must finalize lineage before quarantine cleanup. Failed cycles persist bounded stage/error/remediation evidence; explicit `review.retry`/`review.reset` messages to `tool:pi-actors` may reset counters or disposable state, but reset must reject approved/transaction/lineage evidence that requires roll-forward recovery. Draft retry must preserve the original reviewer run once a transaction journal exists and derive lineage/evidence from that authenticated journal plan, never from later reviewer output.
- Parent-session teardown runs on every Pi `session_shutdown`, never ordinary `agent_end`: select discovered readable persisted `running` runs with the exact retiring session `ownerId`, carry immutable `run_instance_id` through canonical `control.kill`, serialize control against same-directory restart, fence teardown evidence to that generation, continue across partial failures, and leave terminal, ambiguous, changed-generation, or other-session runs untouched. Use unbounded teardown discovery, count unreadable/corrupt state as failures, and persist one bounded shutdown summary outside individual runs. Descendant Pi sessions remain separate exact owners and rely on their own shutdown hooks; hard termination keeps OS/manual orphan recovery as an honest boundary.
- Room/branch provenance checks should validate that accepted `from` addresses belong to the addressed run.

## Coordination And Lifecycle

- Persistent implementer workflows are recipe composition, not one-off scripts.
- Compose cells such as `coordinator-locker`, subagent launchers, actor-message utilities, and mailbox-loop helpers.
- Preserve JSON envelope object shape across handoffs.
- Keep locker state generic and thin; orchestration strategy belongs in the coordinator.
- Graceful actor retirement is opt-in through recipe/run metadata and must not infer retirement for persistent services or backlog implementers.
- Script helpers that spawn long-lived child processes should keep those children inside the async run's owned process group unless they also provide an explicit termination bridge; `control.kill` must not leave detached playback/service descendants alive.
- True daemon recipes are allowed, but daemon ownership belongs to the recipe/script contract: persist a pid or service handle, verify ownership before signaling, expose status/stop semantics, and bridge `control.kill` to daemon cleanup instead of relying on the generic runner to discover detached services.

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
