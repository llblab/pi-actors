# Changelog

## 0.14.3: Pipeline Termination Mailbox Consistency

- `[Recipe Library]` Added `control.cancel` and `control.kill` mailbox accepts to packaged async pipeline recipes that previously advertised only `control.stop`. Impact: `inspect view=mailbox` now exposes the full actor-native termination set consistently across high-level pipeline actors.
- `[Tests]` Expanded packaged recipe coverage so all async `pipeline-*` recipes must expose `control.stop`, `control.cancel`, and `control.kill`. Impact: future pipeline recipes cannot silently regress to partial termination mailbox contracts.

## 0.14.2: Release Readiness Package Evidence

- `[Recipe Library]` Added `utility-package-summary` evidence to `pipeline-release-readiness` between changelog extraction and validation. Impact: release readiness reports can consider package metadata and package contents summary without adding publish automation.
- `[Docs]` Updated task-first and recipe-library docs to describe the enriched release-readiness pipeline. Impact: the documented task-first candidate map now matches the implemented recipe composition.

## 0.14.1: Backlog Vocabulary Reconciliation

- `[Docs]` Reconciled backlog status text after the message-only inspection release. Impact: project context no longer claims `inspect view=events` is retained and describes operations snapshots as actor-message tails instead of event tails.

## 0.14.0: Message-Only Run Inspection

- `[Actor Tools]` Removed `inspect view=events` as a public compatibility alias. Impact: run actor message streams are inspected only with `inspect view=messages`, keeping the public observation vocabulary aligned with actor messages.
- `[Docs]` Updated README and async-run/actor-message docs to remove the events inspection view and point operators to `inspect view=messages`. Impact: examples and tool descriptions no longer teach the transitional events alias.

## 0.13.5: Actor Message Snapshot Wording

- `[Docs]` Replaced remaining task-first and recipe-library event-tail wording for async-run operations with actor-message tail terminology. Impact: operations guidance now matches the `message_file` recipe surface and `inspect view=messages` actor vocabulary.
- `[Utilities]` Updated the `recipe-utils.mjs run-ops-snapshot` usage text from `<event-file>` to `<message-file>`. Impact: helper diagnostics no longer teach the old public noun.

## 0.13.4: Interactive Recipe Termination Contracts

- `[Recipe Library]` Added actor-native `control.stop`, `control.cancel`, and `control.kill` mailbox accepts to interactive artifact/message/fanout recipes and the music player recipe. Impact: `inspect view=mailbox` now advertises the run termination messages that the actor runtime supports for these long-lived recipe actors.

## 0.13.3: Actor Vocabulary Cleanup

- `[Docs]` Removed remaining public FIFO/outbox phrasing from actor-message/template-recipe docs and runtime prompt guidance. Impact: agent and operator guidance now consistently describes `spawn`, `message`, and `inspect` without transport-specific vocabulary.
- `[Recipe Library]` Removed the legacy `event_file` default from async-run operations recipes. Impact: the recipe surface now uses only `message_file` for run actor-message inputs.

## 0.13.2: Async Run Actor Vocabulary Docs

- `[Docs]` Reframed `docs/async-runs.md` around actor messages and run-local control channels, keeping file names and transport details in implementation sections. Impact: the async-run standard now separates public `spawn`/`message`/`inspect` behavior from storage/transport mechanics more clearly.

## 0.13.1: Public Actor Vocabulary Docs

- `[Docs]` Replaced remaining public README and recipe-library wording that described run coordination as events, FIFO, or outbox paths with actor-message and run-local control-channel terminology. Impact: operator-facing docs now teach the actor vocabulary first while keeping transport details in the async-run implementation reference.

## 0.13.0: Actor-Native Control Surface

- `[Actor Messages]` Removed `runtime.cancel` and `runtime.kill` termination aliases from `message to=run:<id>`. Impact: run termination now uses only actor-native `control.stop`, `control.cancel`, and `control.kill`; runtime-prefixed control names are no longer treated as public API.

## 0.12.15: Run Operations Message File Vocabulary

- `[Recipe Library]` Renamed async-run operations recipe inputs from `event_file` to `message_file`, with legacy `event_file` retained only as an internal default fallback. Impact: public recipe args align with the actor-message vocabulary while existing value-based launches can still supply the old key.
- `[Recipe Utilities]` Renamed `run-ops-snapshot` output from `events` to `messages`. Impact: operations reports now describe run outbox records as actor messages instead of runtime events.

## 0.12.14: Actor Message Inspection Alias

- `[Actor Messages]` Added `inspect view=messages` for run actors, with `events` retained as a compatibility alias for the same outbox-backed actor messages. Impact: the public inspection vocabulary now matches the actor/message model while preserving existing event-oriented diagnostics.

## 0.12.13: Structured Run Operations Recommendations

- `[Recipe Utilities]` Changed `utility-run-ops-snapshot` recommendations from shell-like suggestion strings to structured `message` and `inspect` call objects. Impact: async-run operations reports now preserve the actor API shape directly and avoid reintroducing command-string parsing into coordinator handoffs.

## 0.12.12: Async Command Summary Hygiene

- `[Observability]` Kept async `command.done` summaries bounded while preserving full argv-shaped command details in event payloads. Impact: long prompted fanouts keep diagnostic fidelity without flooding coordinator follow-ups with huge command lines.

## 0.12.11: Recipe Import Diagnostics Hotfix

- `[Template Recipes]` Added regression coverage proving imported recipe nodes execute correctly under a repeated parallel parent (`imports` + `repeat` + object `template`). Impact: the suspected composition blocker is now guarded as supported behavior instead of relying on manual smoke interpretation.
- `[Observability]` Expanded command details in foreground execution results and async `command.start`/`command.done` events from executable-only labels to full argv-shaped launch strings. Impact: failed fanout branches no longer appear as misleading `pi && pi && ...` summaries when the real command was `pi -p --model ...` with a long prompt.
- `[Spawn]` Allowed the public `spawn` schema to accept inline object command-template configs, not only strings and arrays. Impact: agents can launch object-form templates with `parallel`, `repeat`, `failure`, and nested `template` directly through `spawn` as documented.

## 0.12.10: Actor Ownership and Recipe Operations

- `[Actor Messages]` Added actor-native `control.stop`, `control.cancel`, and `control.kill` handling for run termination while retaining `runtime.cancel` and `runtime.kill` as compatibility aliases. Impact: public examples can use the same control-message vocabulary declared by recipe mailboxes instead of preserving runtime action names.
- `[Actor Messages]` Added `inspect target=tool:<name>` support for registered tool actor status/schema contracts. Impact: tool actors can now be intentionally observed through the same actor vocabulary used to invoke them with `message to=tool:<name>`.
- `[Recipe Library]` Added `pipeline-artifact-bundle`, a task-first handoff pipeline that composes optional validation, deterministic artifact writing, machine-readable manifest generation, deterministic manifest writing, and an actor-message handoff. Impact: callers who explicitly want filesystem writes can produce paired artifact and manifest paths as one reusable bundle workflow.
- `[Component Recipes]` Aligned `subagent-tools` and `subagents-prompts` with the common subagent policy knobs for `model`, `thinking`, `tools`, and `output_format`. Impact: prompt launchers and prompt fanout can be tuned through the same public controls as the richer subagent atoms.
- `[Recipe Library]` Added `utility-run-ops-snapshot` and routed `pipeline-async-run-ops` through it so run summaries, event tails, and stale/terminal recommendations stay in one structured input. Impact: async-run operations reports no longer lose summary context before normalization and can suggest `inspect` or `control.stop` messages without executing them.
- `[Actor Messages]` Added `inspect target=coordinator` support for current-session run inventory. Impact: the coordinator actor can now be intentionally observed without spelling out the session id.
- `[Actor Messages]` Added `message to=session:<id>` support for run-owned session-directed follow-ups. Impact: explicit session checkpoints now use the same actor envelope as coordinator follow-ups while preserving run-owner checks.
- `[Actor Messages]` Hardened `message to=session:<id>` routing to require an owned sender run. Impact: unowned or cross-session runs cannot synthesize session-directed follow-ups.
- `[Actor Messages]` Applied coordinator-session ownership checks to addressed run, branch, and coordinator message routes when a session context is available. Impact: actor messages now fail closed before controlling or emitting from runs owned by another coordinator session.
- `[Actor Messages]` Applied the same coordinator-session ownership gate to direct `inspect target=run:<id>` views. Impact: explicit run inspection no longer leaks cross-session run details when the current session is known.
- `[Actor Messages]` Tightened `inspect target=coordinator` to require a current coordinator session instead of falling back to all runs. Impact: callers without session context must use explicit `session:<id>` or `session:all` inventory.

## 0.12.9: Actor Runtime Hotfix

- `[Async Runs]` Protected the `runs` state root from session-start temp pruning, tightened live-run status around owned runner processes, and kept non-Linux FIFO control usable without `/proc`-only checks. Impact: long-lived actors are less likely to disappear or be misclassified during startup and stale PID reuse is reduced on Linux.
- `[Actor Messages]` Preserved coordinator-bound actor message `body` and `metadata` through outbox parsing and follow-up formatting, with bounded body previews. Impact: checkpoint and decision messages reach the coordinator with the useful payload instead of only the summary line.
- `[Observability]` Reduced generic `command.done` follow-up noise by keeping successful final leaf completions diagnostic while still bubbling failures and in-flight parallel branch completions. Impact: long sequential pipelines no longer flood the launching coordinator with low-value leaf-completion messages.
- `[Output]` Moved truncated full-output files under `~/.pi/agent/tmp/pi-actors/outputs`. Impact: oversized tool output now follows the extension temp-directory contract instead of using system temp.

## 0.12.8: Usage Hint Documentation

- `[Docs]` Documented runtime actor-tool argument usage hints in README and tool-registry docs, and covered missing template-value hints separately from typed value errors. Impact: users and agents can discover the self-correction behavior without reading tests.

## 0.12.7: Tool Argument Usage Hints

- `[Tools]` Added compact usage hints to runtime actor-tool argument errors when typed normalization or placeholder resolution fails. Impact: if an agent supplies a wrong enum/type value or misses a required template value after schema validation, the error now shows the expected call shape with required and optional fields.

## 0.12.6: Documentation Example Alignment

- `[Docs]` Replaced remaining shader-ring recipe examples in registry and template-recipe docs with the concrete docs-review actor recipe example, aligned test fixtures, and changed async-run outbox docs to show actor message envelopes without public delivery knobs. Impact: public docs now consistently demonstrate useful actor wrapping and keep coordinator attention policy out of recipe-authored message examples.

## 0.12.5: README Actor Recipe Example

- `[Docs]` Replaced the placeholder shader-ring onboarding recipe with a concrete async docs-review actor recipe that includes typed args, mailbox metadata, and a real launch template. Impact: README onboarding now demonstrates actor wrapping instead of an abstract placeholder.

## 0.12.4: Actor Runtime Positioning

- `[Docs]` Reframed README and package metadata around `pi-actors` as an actor runtime and orchestrator for agent-managed local processes, while preserving the persistent actor-tool registry as one capability. Impact: new readers see how templates, recipes, mailboxes, messages, artifacts, and run state turn any trusted local process into an agent-controllable actor.

## 0.12.3: Package Metadata Hygiene

- `[Package]` Normalized npm repository metadata to the canonical `git+https://` URL form. Impact: npm publish no longer needs to auto-correct package metadata.

## 0.12.2: Registry Migration Notes

- `[Docs]` Added explicit rename migration instructions for copying `~/.pi/agent/auto-tools.json` or the short-lived `~/.pi/agent/tools.json` to `~/.pi/agent/actors-tools.json`. Impact: operators keep control of config migration while the package avoids silent rewrites of old registry files.

## 0.12.1: Actor Tool Registry Name

- `[Registry]` Renamed the new pi-actors registry filename from `tools.json` to `actors-tools.json`. Impact: the persisted config name now clearly describes actor-control tools instead of implying every pi tool belongs to this extension.

## 0.12.0: Rename to pi-actors

- `[Rename]` Renamed the package and current public surface from `@llblab/pi-auto-tools` / `pi-auto-tools` to `@llblab/pi-actors` / `pi-actors`, moved the persistent registry filename from `auto-tools.json` to `tools.json`, and moved runtime state defaults from `~/.pi/agent/tmp/pi-auto-tools` to `~/.pi/agent/tmp/pi-actors`. Impact: the package name now matches the actor API model introduced in 0.10-0.11, while the durable registry becomes the generic pi agent tools config.

## 0.11.0: Actor API Compression

- `[Actor Messages]` Added `tool:<name>` message routing to invoke executable pi tools through the same addressed envelope used for run, branch, and coordinator actors, added validated deterministic `utility-actor-message` wrapping for recipe-authored actor-message records with envelope-shaped public args and correlation/reply metadata, renamed the prompted message-producing recipe to `subagent-message`, aligned it with the same public field names, migrated artifact pipelines to use deterministic envelopes, and updated README/async/component/command-template docs, runtime prompt guidance, and music-player usage text to prefer actor `message`/`spawn`/`inspect` vocabulary for coordination examples. Removed recipe-level `events` delivery policy, recipe-authored delivery knobs, the public message-envelope `delivery` field, the duplicate recipe-authored `event` alias, stale `event` import aliases, the public `async_run` tool registration, and the music-player `event_delivery` recipe arg from the public surface so `mailbox` remains the single recipe message contract and runtime routing owns coordinator attention policy. Split generic atomic JSON persistence out of registry config so async-run state no longer depends on the registry-config domain. Impact: tool calls, diagnostics, runtime stop/kill, and recipe-authored message records participate in the actor/message protocol without adding another durable verb or relying on prompted JSON shape for deterministic pipelines, while local domain ownership stays clearer.
- `[Recipe Library]` Added mailbox metadata to all async packaged recipes, including prompt launchers, quorum, core subagent atoms, the review coordinator, and pipelines, with regression coverage requiring mailbox declarations for async packaged recipes. Impact: async subagent launchers and composed pipelines now advertise their basic control, completion, artifact, and domain-result message surface to `inspect view=mailbox`.

## 0.10.0: Actor Orchestration and Artifact Pipelines

- `[Actor Messages]` Began the 0.10 communication convergence with a draft actor/message protocol, pure address/envelope normalization helpers, recipe `mailbox` metadata, public `spawn`, `message`, and `inspect` tools for `run:<id>` actors as high-level adapters over async start/send/status/tail/events/artifacts/files, actor envelope fields on generic `command.done` and music-player track outbox events, coordinator-bound `message` routing through run outboxes, branch-addressed `message` routing through parent run mailboxes, and async-run docs/prompt guidance centered on `spawn`/`message`/`inspect`, mailbox preservation coverage, recipe validation summaries for mailbox declarations, and mailbox metadata on checkpoint/follow-up/event recipes, mailbox persistence in async run metadata, `inspect view=mailbox`, and route-aware default message delivery, artifact recipe mailbox metadata, and clarified prepared-vs-written artifact-report semantics, and deterministic `utility-artifact-write` support for accepted prepared artifacts, and an opt-in `pipeline-artifact-write` recipe for write-capable artifact flows, a successful `pipeline-artifact-write` smoke (`artifact-write-smoke-010`), `inspect` support for `session:<id>` run status, and `spawn` support for state/artifact metadata. Impact: the next API can consolidate actor creation, upward events, downward commands, and intentional inspection around addressed endpoints while existing async run transports remain implementation details.

## 0.9.0: Async Observability Polish

- `[Async Observability]` Ambient triangles now reflect active parallel branches inside a running async recipe, while still showing at least one triangle per active run. Impact: multi-agent fanout such as one run with three parallel subagents is visible as three active triangles instead of one.
- `[Async Observability]` Terminal `done` and `failed` transitions now send compact Markdown follow-up context with compressed artifact/run-file paths to the launching coordinator, while intentional `cancel`, `kill`, and control-stop completions remain synchronous-only. Documentation now centers the reactive control loop where upward outbox/follow-up events pair with explicit `async_run action=send` commands downward. Impact: successful async recipes bubble a top-level completion event back into the initiating agent turn without flooding context with repeated state-dir prefixes or duplicate stop notifications, and coordinators have a clear alternative to sleep-poll loops, and examples avoid sleep-then-status smoke patterns.
- `[Async Observability]` The generic async runner now emits `command.done` outbox events for leaf commands, with explicit recipe-level `events.command.done.delivery` controlling whether branch completions are stored, notified, or sent as follow-up context; packaged multi-agent fanout recipes default branch completion to `followup`. Impact: parallel subtask completion bubbles through the run outbox for multi-agent recipes without hardcoding transport calls or relying on hidden reserved args.
- `[Template Recipes]` Added recipe-level named `artifacts` for ordered artifact manifests, distinct from command-template `output` and default stdout. Impact: async completion and bubbled subtask events can report stable paths such as `report` and `summary`, including placeholder-derived artifact paths.

## 0.8.0: Semantic Recipe API

- `[Release]` Reframed the 0.8 line around semantic recipe inputs instead of leaking CLI fragments or historical node shapes. Impact: current docs focus on `async`, `parallel`, `when`, typed args, and recipe imports as the active API.
- `[Command Templates]` Replaced public execution `mode: "parallel"` with boolean `parallel: true` for command-template and recipe fanout. Impact: the execution API now matches `async: true` style boolean modifiers, and packaged recipes/docs/tests no longer use enum-like execution mode for a two-state choice.
- `[Recipe Design]` Reviewed remaining `mode`-named surfaces after the migration and removed the unused `utility-jsonl-tail` mode arg. Impact: execution mode became boolean, while multi-value user policy knobs such as merge mode, continuation mode, playlist output mode, and CLI `mode:enum(...)` examples remain enums because they are not reducible to true/false without losing names.
- `[Command Templates]` Added `{name??fallback}` nullish coalescing and `{name?truthy:falsy}` ternary placeholder selection, then migrated `utility-validate-recipe` from `all_flag:string` to `all:bool`. Impact: recipes can expose semantic values while mapping empty fallbacks or optional CLI strings without leaking raw flag fragments into public args.
- `[Command Templates]` Allowed numeric node control fields such as `timeout`, `delay`, and `retry` to read placeholder values, for example `timeout: "{timeout_ms}"`. Impact: recipes can expose configurable execution policy while keeping public arg names distinct from node field names.
- `[Docs]` Added explicit layer-ownership sections to command-template, template-recipe, and async-run standards. Impact: portable execution syntax, saved recipe configuration, and detached lifecycle primitives are now documented as separate layers with clear non-goals.
- `[Command Templates]` Added node-level `when` guards for conditional template execution. Impact: recipes can branch optional steps with semantic boolean inputs while skipped sequence nodes preserve stdin flow.
- `[Component Recipes]` Replaced raw `tool_args` CLI fragments with semantic `tools` inputs mapped through ternary placeholders. Impact: subagent component recipes expose tool access policy without making callers assemble `pi` CLI flag strings.
- `[Command Templates]` Removed the public `critical` alias in favor of `failure: "root"`. Impact: failure handling now has one explicit strategy surface instead of a boolean alias plus enum.
- `[Recipe Library]` Replaced the public `timeout` arg in `utility-validation-wrapper` with `timeout_ms:int`, then feeds it into node-level `timeout`. Impact: callers can configure execution bounds without reusing command-template control-field names as public args.

## 0.7.1: Recipe Library Hotfix

- `[Component Recipes]` Added `docs/component-recipes.md`, seed subagent component examples for review, verification, merge, quorum, checkpoint, follow-up, normalization, and one composed review coordinator. Impact: pi-auto-tools now has an explicit weak component-recipe contract for composing higher-level subagent coordinators without introducing a monolithic swarm DSL.
- `[Template Recipes]` Allowed recipe-envelope sequence templates to contain recipe import nodes and added packaged-example import resolution coverage. Impact: composed recipes can keep public args/defaults at the recipe envelope while sequencing imported component recipes.
- `[Component Recipes]` Expanded seed components with model/thinking/tool/output/evidence/risk policy knobs, added critic and judge atoms, and added review-readiness, quorum-review, and architect-coordinator pipeline examples. Impact: the toolkit now demonstrates both flexible atoms and second-order coordinator recipes.
- `[Component Recipes]` Added planner, evidence-map, contradiction-map, task-card, and conflict-report atoms; strengthened checkpoint/follow-up parameterization with resume and continuity policies; and added research-synthesis, checkpoint-continuation, and development-tasking pipelines. Impact: component composition now covers research, resumable/degraded handoff, and bounded implementation planning patterns.
- `[Recipe Library]` Promoted packaged recipes from `examples/recipes` to root `recipes`, moved the music-player helper to `scripts/music-player.mjs`, renamed the music recipe to `music-player.json`, and removed the parallel shell-wrapper variant. Impact: recipes are now treated as the standard library surface instead of isolated experiments, with one maintained Node.js music-player wrapper.
- `[Component Recipes]` Added artifact and event atoms plus `pipeline-artifact-report`. Impact: component pipelines now demonstrate durable artifact-shaped output and outbox-event-shaped handoff without requiring a live subagent smoke run.
- `[Recipe Library]` Added utility recipes for Markdown index listing, JSONL/event tailing, scoped validation commands, run-state file listing, changelog-head reading, and playlist scanning. Impact: the standard library now includes non-subagent operator utilities alongside coordinator components and pipelines.
- `[Recipe Library]` Added `scripts/recipe-utils.mjs` plus helper-backed utilities for run summaries, playlist building, and changelog section extraction. Impact: repeated utility parsing/listing logic now has one small maintained helper family instead of growing opaque recipe command strings.
- `[Recipe Design]` Added `docs/task-first-recipes.md` to derive high-level recipes from operator/coordinator tasks before filling missing atoms. Impact: standard-library growth now has a top-down design map alongside atom-first component expansion.
- `[Recipe Library]` Added `pipeline-release-readiness`, the first task-first high-level pipeline, composed from changelog extraction, validation wrapping, release review, and artifact reporting. Impact: release prep now demonstrates deriving a coordinator recipe from an operator task and reusing existing cells.
- `[Recipe Library]` Added git status/log utilities and `pipeline-repo-health`. Impact: repository-health reporting now has a task-first pipeline composed from local utilities, validation, normalization, and artifact reporting.
- `[Recipe Library]` Added `pipeline-async-run-ops`, composed from run summary, event tail, normalization, and artifact reporting cells. Impact: async run inspection now has a task-first operations pipeline without needing live subagent execution.
- `[Recipe Library]` Added `pipeline-docs-maintenance` and expanded `subagent-artifact` with a validation policy knob. Impact: documentation maintenance now has a task-first pipeline, and artifact-producing components can declare acceptance checks.
- `[Recipe Library]` Expanded playlist building with `paths|m3u|inline` output modes and added `pipeline-media-library`. Impact: media-library workflows now have a task-first pipeline and playlist utilities are more parameterized for playback or artifact use.
- `[Recipe Library]` Added `utility-artifact-manifest` backed by `scripts/recipe-utils.mjs`. Impact: utility recipes now include a safer structured transform that turns artifact paths into machine-readable JSON metadata.
- `[Recipe Library]` Updated `utility-run-summary` to derive live status from async-run `progress.json` and `result.json` instead of only static `run.json` metadata. Impact: operations and parallel utility smokes report completed and failed runs accurately after runner exit.
- `[Recipe Library]` Added `utility-package-summary` backed by `scripts/recipe-utils.mjs`. Impact: release-readiness and repository-health recipes can consume bounded package metadata without hand-written JSON parsing in recipe command strings.
- `[Command Templates]` Allowed object-valued nested templates to execute as nested command-template configs, including repeated imported recipe nodes. Impact: packaged coordinator recipes such as `subagent-review-coordinator` can fan out imported subagent components in parallel and continue through verifier, merger, judge, and normalizer stages.
- `[Recipe Library]` Added `scripts/validate-recipe.mjs` plus `utility-validate-recipe`. Impact: operators and agents can validate one saved template recipe or a directory of packaged recipes through the same recipe/run layer they use for other utility workflows.
- `[Async Runs]` Changed coordinator notifications to be driven by run-state file watcher events instead of a fast polling loop, while suppressing duplicate async notifications for already-handled `failed` and `cancelled` terminal states. Ambient run triangles now count unfinished async run instances rather than internal command-template branches; reload smoke confirmed concurrently started independent subagent runs show simultaneous triangles when held open. Impact: coordinators can start multi-agent runs, continue other work, and rely on exceptional terminal/outbox events to initiate follow-up rather than manually polling status in a loop.

## 0.7.0: Command Template Checkpoints

- `[Command Templates]` Added `failure: "continue|branch|root"` propagation, with `critical: true` retained as a backward-compatible root-abort alias. Impact: templates can stop only the current branch, keep sibling parallel branches alive, or abort the root explicitly.
- `[Command Templates]` Extended `retry` from leaf commands to sequence and parallel nodes. Impact: validator groups can retry as one bounded unit instead of requiring wrapper scripts for simple checkpoint loops.
- `[Command Templates]` Added `recover` cleanup templates between failed retry attempts, with fail-closed recovery semantics. Impact: retried groups can reset worktrees, clear generated files, or release local state before the next attempt without adding arbitrary loops or goto-style control flow.
- `[Command Templates]` Changed the default command timeout from 30 seconds to disabled. Impact: long-running templates no longer need `timeout: 0`; bounded commands should set an explicit positive `timeout` when they must fail closed.
- `[Command Templates]` Added typed `array` args, `{items[index]}` placeholder selection, `repeat: "{items.length}"`, and recursive placeholder resolution for defaults. Impact: repeated template nodes can derive fanout width and per-branch values from an agent-supplied array, enabling compact subagent fanout recipes.
- `[Template Recipes]` Split saved JSON definitions from async execution by adding explicit `name` and `async: true` semantics. Impact: recipe files can run foreground or detached, while async runs keep lifecycle/state/logs; file-backed recipes may rely on the filename as their canonical id.
- `[Async Runs]` Renamed the public async adapter from `template_job` to `async_run`, renamed public run selection to `run_id`, moved recipe lookup to `~/.pi/agent/recipes`, moved runtime state to `~/.pi/agent/tmp/pi-auto-tools/runs`, and renamed internal job modules/files to recipe/async-run language. Impact: the 0.7 API is intentionally breaking but now matches the template/recipe/run model before release.
- `[Tool Registry]` Removed legacy raw `job`/`recipe` launcher fields from registry loading; use `template` with optional `name` and `async` for co-located recipes. Impact: stale pre-0.7 launcher configs fail loudly instead of being silently normalized into the new API.
- `[Docs]` Split the old template-jobs umbrella into separate command-template, template-recipe, async-run, tool-registry, and experimental-recipe documents, then removed the obsolete compatibility page before release. Impact: each standard now has a dedicated reference instead of preserving stale umbrella terminology.
- `[Async Runs]` Allowed `failure` and `recover` as recipe envelope flags for inline or file-backed async runs, including placeholder derivation from recipe-level recovery templates. Impact: detached runs and async recipe tools can use the same checkpoint semantics as foreground registered tools.
- `[Async Runs]` Changed cancel/kill to signal the owned runner process group when available, with a pid fallback. Impact: background child processes such as audio players stop with the async run instead of being orphaned.
- `[Async Runs]` Classify stopped runs as `cancelled` or `killed` after the runner exits, and tailor terminal follow-up text for those statuses. Impact: operator-requested stops no longer look like unexplained `exited` runs.
- `[Async Runs]` Changed async management tool output from full JSON to compact text by default, with `verbose: true` preserving full JSON for diagnostics. Impact: start/status/cancel/list calls no longer flood agent context with internal runner metadata.
- `[Async Runs]` Added source metadata (`tool`, `recipe`, `recipe_file`) to run state and a `status` filter for `async_run action=list`. Impact: operators can distinguish music, timers, subagents, and other run categories in one shared async state root.
- `[Async Runs]` Downgraded cancelled-run terminal notifications from error to info and suppressed follow-up context for successful `done` and intentional `cancelled` transitions. Impact: happy-path async completions no longer interrupt the agent flow.
- `[Async Runs]` Ensured ambient status always shows at least one triangle per running async run, with additional triangles for reported active parallel branches. Impact: the footer reflects currently active run trees even while a runner has not reported branch-level activity yet.
- `[Async Runs]` Added `async_run action=send` for newline-delimited messages to a running recipe's Unix FIFO at `<state_dir>/control.fifo`. Impact: tool calls can control long-running scripts through a simple recipe-local IPC endpoint on Linux, macOS, or WSL without adding a second recipe or a workflow engine.
- `[Async Runs]` Added script-authored outbox events through `<state_dir>/outbox.jsonl`, `async_run action=events`, and optional coordinator-scoped `notify`/`followup` delivery. Impact: async recipes can report state changes back to the launching agent without hidden tool calls, schedulers, or a second execution language.
- `[Template Recipes]` Added recipe-layer `imports` with cycle checks, `{ "name": "alias" }` template nodes, `{alias.defaults.key}` / `{alias.values.key}` references, missing-value fallbacks, small ternaries, and command-template-shaped imported recipe typing. Impact: file-backed recipes can compose other recipes and reuse their value containers without making command-template core depend on the recipe registry or async-run lifecycle state.
- `[Experimental Recipes]` Replaced the packaged background music example with paired controllable music player recipes for shell and Node.js wrappers. Impact: operators can register async `music_player_sh` or `music_player_mjs` playback for files, URLs, directories, and playlists, then control play, pause, next, previous, status, and stop by run id through `async_run action=send`.
- `[Experimental Recipes]` Added `music-player.mjs` as a Node.js alternative to the shell music-player wrapper with the same CLI, playlist expansion, state files, and FIFO control contract. Impact: the paired recipe files differ only by executable wrapper and show that recipes can point directly at shell scripts or Node.js scripts.
- `[Experimental Recipes]` Added direct first-argument control commands (`pause`, `resume`, `toggle`, `next`, `previous`, `stop`, `status`) to both music-player wrappers. Impact: scripts can be driven as `music-player.sh next <state-dir>` while the recipe still uses `play` explicitly to start playback.
- `[Experimental Recipes]` Renamed the public music-player input from `playlist` to typed `source:string` and documented directory scanning. Impact: callers can pass `source="~/Music"`, a file, URL, playlist file, or inline list without creating a playlist first.
- `[Experimental Recipes]` Declared the music-player `command` as a typed enum recipe arg and moved its default `play` into recipe `defaults`. Impact: the recipe metadata now keeps command type/defaults with the rest of the public template contract while the recommended registered tool can still expose the narrower playback surface.
- `[Experimental Recipes]` Added music-player track-change outbox events with configurable `event_delivery` defaulting to `log`. Impact: agents can inspect current/previous track changes with `async_run action=events` and opt into live notifications or follow-up context only when desired.
- `[Experimental Recipes]` Added `subagent-prompt.json`, an async no-tools pi subagent recipe with explicit string args. Impact: operators have a packaged example for starting a non-interactive subagent as a detached run and inspecting it through normal async-run lifecycle tools.
- `[Experimental Recipes]` Added `subagent-tools.json`, an async pi subagent recipe with a required explicit `tools:string` allowlist. Impact: operators can start tool-enabled subagents without weakening the safer no-tools default example.
- `[Experimental Recipes]` Added `subagents-prompts.json`, an async parent recipe that repeats one imported `subagent-prompt.json` node over a public `prompts:array` input. Impact: the release package includes a concrete example of recipe import composition that runs parallel subagents as one async run while keeping concrete prompts configurable at tool call time.
- `[Safety]` Added lightweight high-risk template warnings for shell interpreters, eval modes, destructive removal, and broad filesystem mutation. Impact: operators see trust-boundary warnings in registration/runtime details without blocking existing trusted tools.
- `[Docs]` Folded legacy job-primitives notes into async-run and template-recipe docs and removed the internal Russian collaborative-subagents research brief from the release package. Impact: release docs have clear async/recipe sources of truth and only polished English public documentation.
- `[Docs]` Added a collaborative subagent branch adapter pattern for async runs, including scope-file handoff, parallel runner recipe shape, coordinator responsibilities, degraded partial success, and the boundary between pi-auto-tools runtime state and swarm/project policy. Impact: operators can prototype isolated branch subagent runs without turning pi-auto-tools into a swarm orchestrator.
- `[Docs]` Polished release onboarding around the template/recipe/run layering and added an async parent recipe example composed from imported recipe definitions. Impact: new operators can see how imports compose reusable recipes without implying nested async runs or a workflow engine.
- `[Prompts]` Reworked the onboarding system prompt to teach the local-first cybernetic tool-memory lens, template/recipe/run layers, recipe imports, async fanout, tool registration, and first docs/examples to inspect. Impact: agents with the extension loaded can discover the format and start using async recipes/subagents with less repository-specific prompting.

## 0.6.1: Pi SDK Scope Hotfix

- `[Packaging]` Migrated the pi SDK peer dependency and extension type imports from the legacy `@mariozechner/pi-coding-agent` scope to `@earendil-works/pi-coding-agent`. Impact: package metadata matches the current Endrilla/Earendil pi package namespace.

## 0.6.0

- `[Typed Args]` Added progressive typed command-template argument declarations for `string`, `path`, `int`, `number`, `bool`, and `enum(...)` compact forms in both `args` and inline template placeholders. Impact: registered tools can expose narrower generated schemas and validate/normalize runtime values without requiring JSON Schema authoring or separate `args` metadata for simple templates.
- `[Compatibility]` Kept existing untyped `args` and shorthand defaults fully compatible while normalizing typed shorthand such as `timeout:int=60000` into canonical stored declarations plus `defaults`. Impact: existing `auto-tools.json` entries continue to load unchanged.
- `[Docs]` Documented typed args in the command-template standard, tool registry guide, README, and backlog state, including metadata-first and inline-first authoring styles. Impact: operators can adopt typed declarations incrementally while choosing the most readable shape for each tool.

## 0.5.6: Coordinator-Scoped Job Notifications Hotfix

- `[Job Observability]` Scoped async job ambient status and terminal follow-up context to the agent session that started the job. Impact: multiple pi agents sharing the same job state root can run independent async jobs without receiving each other's completion messages or sub-agent indicators, while explicit `status`/`tail` inspection by job id remains available.
- `[Template Jobs]` Added `template_job action=kill` as a forceful `SIGKILL` escape hatch for stuck owned job runners, with the same cwd/runner ownership checks as graceful `cancel`. Impact: operators can recover from unresponsive detached jobs without unsafe broad process killing.
- `[Release]` Added a tag-triggered GitHub Actions release workflow that verifies the `vX.Y.Z` tag matches `package.json`, extracts the matching `CHANGELOG.md` section, and publishes a GitHub Release automatically.
- `[Backlog]` Clarified that typed command-template argument declarations must be progressive: current untyped `args` declarations continue to work unchanged while typed forms are added.

## 0.5.5

- `[Template Job Shape]` Allowed job recipe files to place command-template node flags such as `mode`, `timeout`, `retry`, `critical`, `args`, and `defaults` at the job top level beside `job`. Impact: parallel jobs can use the compact shape `{ "job": "name", "mode": "parallel", "template": [...] }` without an unnecessary nested template wrapper.
- `[Template Job Defaults]` Clarified that `state_dir` is optional and defaults to the extension job-state directory derived from the job id. Impact: recipe files only need `job` and `template` unless they intentionally override state placement.
- `[Command Template Repeat]` Added `repeat` expansion with zero-based `{index}`, wrapped zero-based `{prev}`/`{next}`, `{repeat}`, underscore-padded forms such as `{_index}`, and limited arithmetic expressions such as `{_(index+1)}`. Impact: repeated parallel or sequence templates can be written once instead of copy-pasting near-identical branches while keeping human numbering explicit.

## 0.5.4

- `[Co-located Job Recipes]` Allowed registered tool entries to include job envelope fields directly when they also define `template`. Impact: operators can keep small or local job recipes in `auto-tools.json` without introducing `job.tool` cycles or a separate recipe file.
- `[Job Recipe Args]` Derived tool args from available file-backed and co-located job recipe templates when `args` is omitted. Impact: job recipes keep the same optional `args`/`defaults` behavior as command templates while explicit `args` remains an override.
- `[Docs]` Split the synchronous Command Template Standard from the async Template Job Standard. Impact: command templates remain portable and backwards-compatible across extensions, while jobs are documented as an optional async extension.

## 0.5.3

- `[Job Recipe References]` Replaced registered-tool `job` bindings with `template` job recipe references. Impact: the registry has one executable binding field, job files must own a `template`, and job recipes can no longer point back to tools.
- `[Runtime Boundary]` Enforced the `tool → template → job → template` graph across runtime, docs, and tests. Impact: jobs stay lightweight async envelopes, cyclic shortcuts such as `tool.job` and `job.tool` are rejected, and job recipe tools keep their public args explicit.

## 0.5.2

- `[Job Launch Tools]` Added job-backed registered tools. A tool may now define `job` instead of `template`; calling it starts the named template-job recipe asynchronously and returns job metadata. Impact: heavyweight agent fanout can keep `template(mode: "parallel")` inside `~/.pi/agent/jobs/*.json` while exposing a compact callable tool.
- `[Docs]` Documented the `tool → job recipe → template(mode: "parallel")` model across README and adapter docs. Added compact operator onboarding and the `task` vs `template` vs `job` distinction. Impact: job recipes can become the source of truth for async agent scenarios instead of duplicating large templates in tool definitions, and new operators get the job mental model without reading every subsystem note.

## 0.5.1

- `[Job Observability]` Made detached job status triangles use runner-reported active command counts across all running jobs instead of only process-tree probing. Impact: async parallel jobs keep stable per-sub-agent indicators while work is active, with the animation wave moving across the current aggregate set.
- `[Docs]` Clarified that template jobs own async lifecycle and ambient sub-agent visibility, while command templates still own sequence and parallel execution shape. Impact: agentic fanout should use `job(template(mode: "parallel"))` instead of blocking foreground orchestration.

## 0.5.0

- `[Command Templates]` Added `mode` for template object nodes, with `sequence` as the default and `parallel` for concurrent child execution. Object-form examples and persisted tool entries now keep `template` last, with regression coverage for serialization order. Parallel nodes now expose soft-quorum branch labels, statuses, and coverage details. Added compact per-node `delay` in milliseconds for launch pacing without scheduler semantics. Impact: one `template` property now describes sequential and parallel command trees with stable flag-first reading, graceful degradation, optional staged launch, and no separate workflow DSL.
- `[Template Jobs]` Added the unified `template_job` action tool for detached template job lifecycle: start, status, tail, list, and cancel. Jobs use state files, log files, a thin runner process, and stale-state cancellation guardrails. `template_job action=start` can start from a template job JSON file, an inline command template, or a registered auto-tool name. Job state now defaults to `~/.pi/agent/tmp/pi-auto-tools/jobs` and stale temp entries are pruned on session start. Impact: Swarm-style async orchestration can move generic process observation into pi-auto-tools while domain quorum semantics stay in Swarm.
- `[Job Observability]` Added ambient interactive UI status for active sub-agent count and compact completion events for detached jobs. Removed persistent prompt-area widgets and done/exited counters. The running indicator now shows one `▷` per concrete sub-agent with a faster moving dim `▶` wave, single-subagent blink, and a late-sorting status key. Impact: long-running swarms are visible while active, then become actionable context only when they finish.
- `[Command Template Standard]` Folded template job and temp-directory primitives into `docs/command-templates.md`; `docs/job-primitives.md` is now the pi-auto-tools adapter note. Impact: the portable standard is self-contained and consumers point inward instead of chaining across external standards.
- `[Template Job Library]` Added `~/.pi/agent/jobs/*.json` as the reusable template job library. Kept reusable recipes as documentation guidance instead of packaged root files because model and tool names are local policy. Impact: async recipes can be reused compactly without expanding tool config or shipping operator-specific examples.
- `[Registry Tools]` Made `register_tool` callable without args to return a compact list of registered auto-tools. Impact: agents can inspect the extension registry without reading `auto-tools.json` directly.
- `[Registry Activation]` Made every successful `register_tool` call activate all registered auto-tools in the current session. Impact: registered tools stay fresh and callable immediately after list, register, update, or delete operations.
- `[Release Validation]` Added `npm run validate` for CI and release checks. Impact: TypeScript, extension import, tests, and dry-run packing are available through one command.
- `[Docs]` Reworked README and job docs around a compact mental model: command, command template, registered tool, template job. Impact: the new async job concept is easier to explain without implying a scheduler or second workflow language.

## 0.4.0

- `[Command Templates]` Prepared the 0.4.0 runtime profile for the current portable command-template contract: default 30s command timeout, per-step retry propagation, fail-open composition for non-critical failures, and `critical: true` abort semantics. Impact: registered auto-tools now follow the portable command-template runtime profile.
- `[Docs]` Cleaned the backlog and synchronized README plus command-template docs with the strengthened 0.4.0 contract. Impact: release notes, open work, and user-facing runtime semantics now describe the same behavior.

## 0.3.0

- `[Architecture]` Renamed the command-template domain from `lib/templates.ts` to `lib/command-templates.ts` and moved auto-tools-specific arg/schema helpers into `lib/schema.ts`. Impact: the portable standard stays copyable while registry-specific schema derivation remains local.
- `[Command Templates]` Migrated runtime helpers to the current shared command-template standard: string shorthand configs, inline `{arg=default}` defaults, derived tool args, missing-value errors, relative executable expansion, sequence expansion, direct execution with stdin, and timeout escalation. Impact: `pi-auto-tools` now follows the portable command-template regression surface, loads current inline-default `auto-tools.json` entries without `name`/`label`/`args`/`defaults`, and can run multi-step template-backed tools.
- `[Registry]` Canonical persisted object entries now omit redundant `name` and `label`; object keys supply tool names, and runtime labels derive from tool names. Impact: `auto-tools.json` follows the command-template standard more closely while legacy `name`/`label` fields are accepted and normalized away.
- `[Docs]` Harmonized the portable command-template standard wording, using `template`/`args`/`defaults`, command-arg terminology, and `{file}` as the canonical local file path arg. Impact: the docs describe the integration contract without `argv`, `command`, or `{filename}` ambiguity.

## 0.2.1

- `[Docs]` Split command-template documentation into a portable standard core (`docs/command-templates.md`) and local registry adaptation (`docs/tool-registry.md`). Impact: the shared command-template contract can be copied across extensions without coupling their internals, while `pi-auto-tools` keeps its registry storage shape documented separately.

## 0.2.0

- `[Breaking Registry]` Replaced script-backed persistent tools with template-backed command registration. Tools now store `template`, named `args`, and optional `defaults`; legacy stored `script` entries are rejected with explicit migration guidance.
- `[Command Templates]` Standardized split-first invocation: templates are split into shell-like argv tokens before placeholder substitution, then executed through `pi.exec` without shell evaluation. Placeholder values containing spaces remain single argv values.
- `[Register Tool]` Updated `register_tool` to create, update, and delete template-backed tools, preserve existing templates on metadata/default updates, block reserved/external conflicts, persist atomically, and register tools immediately for the active session.
- `[Runtime Output]` Preserved bounded context output for registered tools: stdout is formatted for the agent, large outputs are tail-truncated, full output is saved to temp files, and command failures include useful stderr/stdout sections.
- `[Architecture]` Refactored the extension into a flat `/lib` Domain DAG with `index.ts` as a small namespace-domain composition root. Core domains now cover templates, args/identity, config, registry mutations, runtime coordination, tool definitions, output, prompts, paths, and execution.
- `[Packaging & Validation]` Removed the runtime `typebox` dependency from schema assembly, made `npm run check` import the extension entrypoint, added focused domain and architecture-guard tests, and verified package contents with dry-run packing plus live post-reload smoke.
- `[Docs]` Added command-template documentation as a portable standard, condensed README into a feature/usage format, documented skill-script and sub-agent registration examples alongside their resulting `auto-tools.json` state, documented `{file}` as the canonical local file path placeholder, and reset `BACKLOG.md` after all open work reached validated stop conditions.

## 0.1.1

- `[Registry]` Shipped the script-backed persistent tool registry. Impact: pi can register, update, delete, persist, and auto-load trusted local script tools from `~/.pi/agent/auto-tools.json`.
