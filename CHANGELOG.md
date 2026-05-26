# Changelog

## Unreleased

- `[Prompts]` Clarified that recipe registry warnings are actionable maintenance: invalid or blocking recipes should be fixed, removed, or disabled rather than ignored.
- `[Backlog]` Pruned and refocused the backlog around reliability, actor-loop consolidation, protocol fixtures, follow-up deduplication, and portability reality checks.
- `[State]` Added resilient JSON/JSONL state reader helpers and routed room/inspector reads through them so malformed state records degrade instead of breaking previews; room status now reports state diagnostic counts.

## 0.23.0: Actor Manifests, Inspection, and Runtime Hygiene

- `[Tools]` Unified branch-envelope routing for direct branch messages and selected-recipient room multicast so both paths persist the same branch-local inbox shape before dispatching through the parent run mailbox.
- `[Async Runs]` Added attention semantics for coordinator-bound actor messages: `metadata.requires_response=true` now produces a follow-up while ordinary coordinator progress messages default to notification-level delivery.
- `[Registry]` Added `inspect target=recipes view=doctor` as an intentional recipe health surface with compact severity/action counts and structured verbose diagnostics.
- `[Async Runs]` Added artifact manifest resolution for string and object artifact declarations, including `exists`, `size`, `sha256`, and missing required artifact visibility in artifact inspection.
- `[Async Runs]` Added explicit terminal run retention controls via `control.archive` and `control.prune`, with active-run fail-closed behavior and optional artifact preservation during prune.
- `[Inspector]` Added stable event ids, needs-response markers, and session-local read markers to actor inspector previews and selected-item details.
- `[Registry]` Suppressed routine trusted `bash` wrapper diagnostics from startup warning notifications while keeping them available through recipe diagnostics surfaces.
- `[Async Runs]` Added a rebuildable run-state index for run listing and observability discovery, with corrupt-index fallback to recursive scan and nested-run-safe state directory entries.
- `[Testing]` Added `npm run conformance` for a compact CI-ready protocol conformance runner covering recipes, registry, spawn lifecycle, messaging, rooms, branch inboxes, ownership, artifacts, and attention semantics.
- `[Mailbox]` Added backward-compatible typed mailbox contracts with normalized inspection and advisory warnings for undeclared run message types.
- `[Output]` Centralized inspect, preview, and tool-output size limits so bounded output governance is shared across tools, room previews, and the actor inspector.
- `[Registry]` Added explicit mitigation guidance to command-template trust-boundary warnings for shells, eval modes, and broad filesystem mutation.
- `[Scripts]` Added top-of-file descriptions to packaged helper scripts so their purpose, boundaries, and policy ownership are clear when opened directly.
- `[Rooms]` Added room compaction metadata with dropped count, configured maximum, and first/last kept timestamps exposed through room status inspection.
- `[Recipes]` Improved usage telemetry with launch-kind counters (`tool`, `spawn`, `direct`) and explicit reset reasons when recipe content fingerprints change.
- `[Inspect]` Added `inspect target=recipes view=imports` to summarize recipe import aliases and source references for debugging recipe composition.

## 0.22.5: CI Stability Hotfix

- `[Tests]` Stabilized the Windows named-pipe control endpoint regression by keeping its synthetic run alive longer under slower full-suite CI scheduling.
- `[Tests]` Stabilized the coordinator-locker queue/lock smoke by waiting for assignment, renewal, and denial actor messages before stopping the helper, removing a FIFO processing race from main-branch validation.

## 0.22.4: Actor Isolation and Registry Diagnostics Hotfix

- `[Tests]` Added explicit regression coverage that ad hoc recipe files outside the user recipe root remain recipe components rather than automatically exposed tools, reinforcing the location-based tool exposure invariant.
- `[Registry]` Improved invalid recipe diagnostics for discovery summaries so JSON parse failures, missing templates, and malformed Markdown recipes keep actionable causes, structured severity, and suggested actions instead of collapsing to a generic invalid recipe message.
- `[Observability]` Keyed run transition observation by state directory instead of display run id so nested child runs or reused run names do not collide in terminal follow-ups and pruning state.
- `[Async Runs]` Normalized run-message delivery failures after durable inbox append: failures now preserve queued state details such as `queued`, `inbox_id`, and `delivery_error`, while successful FIFO, named-pipe, and mailbox-only deliveries also expose the inbox id.
- `[Tests]` Added explicit cross-session kill-control regression coverage so run ownership boundaries stay fail-closed for destructive actor controls as well as ordinary messages and inspection.
- `[Tests]` Added branch and room routing safety regressions for cross-run senders and invalid multicast recipients, including assertions that failed validation does not create branch inbox or room timeline records.
- `[Actor Rooms]` Hardened branch inbox reads and status rewrites against malformed JSONL lines; valid messages continue to update while corrupted record counts surface through branch mailbox inspection.
- `[Tests]` Added async lifecycle regression coverage for missing-result terminal status inference, preserving `cancelled`/`killed` over generic `exited`, and tail behavior when only event logs exist.
- `[Registry]` Allowed `register_tool` to persist object command-template configs with composition flags, aligning it with recipes and `spawn`, while preserving precise validation errors for invalid object templates.
- `[Registry]` Added deterministic live-reload regressions for invalid user updates blocking lower-priority fallback recipes and valid recovery refreshing the active tool schema without restart.
- `[Tools]` Preserved target tool failure shape through `message to=tool:<name>` by including the tool name, message type, bounded params preview, and original error on routed failures.
- `[Actors]` Tightened branch and room routing isolation so session-owned runs reject branch/room messages from a different current Pi session, keeping room state scoped to the owning actor tree.
- `[Tests]` Added executable protocol-example coverage for public actor-message, room join/leave, mailbox, spawn, and inspect examples so documentation drift fails in CI.

## 0.22.3: Idempotent GitHub Release Workflow Hotfix

- `[Release]` Made the tag-triggered GitHub Release workflow idempotent: existing releases are edited with the generated title and notes instead of failing when an operator already created the release for the tag.
- `[Context]` Added a changelog signal rule to project context and removed release-bookkeeping-only bullets from changelog history so future entries describe meaningful behavior rather than package-version metadata.

## 0.22.2: Portable Recipe Tool Exposure Hotfix

- `[Registry]` Stopped writing redundant exposure metadata during registration and aligned docs/tests around location-based tool exposure so recipes remain portable between user, ad hoc, and packaged roots.
- `[Skills]` Generalized the actors-skill tool-registration lenses and added existing recipe surfaces, including skill-local recipes, as first candidates for promotion into durable tools.

## 0.22.1: Tool Registration Lens Hotfix

- `[Skills]` Added tool-registration lenses to the packaged actors skill so agents prefer persistent tools for error-prone workflows, safe preflights around dangerous operations, and context-affordance shortcuts that should be visible in future sessions.

## 0.22.0: Cross-Platform Runtime Notification Layer

- `[Runtime]` Started the cross-platform notification layer with a file-backed advisory wake notifier (`wake.jsonl`), explicit initial/wake/poll reconciliation callbacks, periodic reconciliation fallback, and run-message/room-message/branch-inbox wake records. Run messages now persist a canonical inbox record before optional endpoint delivery, can accept mailbox-only control endpoints without FIFO/named-pipe transport, mark delivered endpoint messages `sent`, expose recent run inbox entries through `inspect view=mailbox`, and provide locked run-inbox claim/handle/fail helpers for runtime reconciliation loops. Files remain the canonical mailbox/event state for inspection and crash recovery.
- `[Docs/Tests]` Documented the "wake, not queue" runtime model, added cross-platform music-player smoke guidance, and added coverage for persisted wake events, missed `fs.watch` recovery through polling, and Windows named-pipe message wakes.
- `[Packaging]` Removed the root JavaScript entrypoint wrapper from packaged files and pointed extension metadata directly at the compiled `dist/index.js` output. Source checkouts keep `index.ts` as the only root entrypoint while installed packages load compiled JavaScript from `dist`.
- `[Docs/Prompts]` Removed stale FIFO-queue wording from branch-direct message docs and coordinator prompt injection so queued mailbox work is described consistently with the notification/runtime model. Clarified that worker-backed direct branch messages are runner-owned prompt steering, not coordinator follow-ups, while one-shot prompt children do not consume branch inbox records automatically.
- `[Recipes]` Migrated the packaged music-player control path from Unix FIFO commands to queued mailbox commands, preserving addressed `message` control while making the script align with mailbox-only runtime endpoints.
- `[Recipes]` Added a native Windows `wmp` music-player backend that drives legacy Windows Media Player through `powershell.exe`/COM, verifies `wmplayer.exe` in the standard Program Files locations, and includes mailbox-backed play, pause, next, previous, and stop controls.
- `[Recipes]` Reduced music-player mailbox overhead by using advisory wake records, `fs.watch` where available, and inbox file signatures so the loop avoids repeatedly locking and rereading an unchanged mailbox.
- `[Recipes]` Improved Unix-like playback by adding the macOS-native `afplay` backend, scanning additional common audio extensions, and running child players in their own process group so controls can signal the playback subtree directly.

## 0.21.0: Native Windows Actor Control and Literate Recipes

- `[Async Runs]` Added a platform-adapted run-control path: Unix FIFO behavior remains backward-compatible, native Windows can target named-pipe run-control endpoints recorded in run state, and run message receipts still update events and inbox state through the same actor-message path.
- `[Async Runs]` Added Windows process-tree termination planning for cancel/kill through `taskkill`, while preserving Unix process-group signaling semantics.
- `[Scripts]` Migrated `locker.mjs` and coordinator locker calls to platform-adapted control metadata: Unix still uses `control.fifo`, while native Windows can use a deterministic named-pipe endpoint with the same message protocol.
- `[Branch Messages]` Added bounded branch-inbox terminal retention during status transitions, preserving active queued/claimed work while compacting older handled/failed records for long-lived branch runners.
- `[Recipe Discovery]` Tightened trust-boundary diagnostics so combined short shell/eval flags such as `bash -lc` and nested recipe command-template objects are surfaced, including the packaged validation wrapper's trusted shell boundary.
- `[Rooms]` Recorded the backend decision to keep the current file-backed room adapter until real workflows need live subscriptions/fanout or shared mutable state, backed by a mixed room/direct-branch workload regression.
- `[Recipes]` Added Markdown-authored recipe loading for `.md` files with frontmatter metadata and fenced executable recipe/template blocks, with same-id JSON shadowing Markdown in the same priority layer.
- `[Retirement]` Extended run summaries to discover nested child async-run state dirs, blocks opt-in retirement while nested children are still running, surfaces child/terminal child counts on candidates, and has the session watcher retire ready candidates with one graceful stop attempt plus owned cancellation fallback. Added an integration smoke where an idle supervisor stops after its nested child is terminal while a non-opt-in service remains running.
- `[Coordinator]` Consolidated direct branch inbox claim/finalize rewrites behind one locked mutation helper and moved room-swarm mode dispatch behind an explicit mode registry. Unknown coordinator modes now fail closed, and `pipeline-room-swarm` exposes the supported mode enum.
- `[Docs]` Documented the local Actor OS smoke matrix covered by `npm test`, spanning room coordination, direct branch delivery, inbox claim/handle transitions, inspector navigation, recipe context injection, persistence suggestions, and opt-in retirement smoke.
- `[Docs/Tests]` Documented native Windows support scope and added regression coverage for Windows endpoint metadata, mocked named-pipe sends, Windows process-control planning, unchanged Unix FIFO behavior, locker control metadata, branch inbox compaction, mixed room/direct workloads, Markdown recipe loading/discovery/validation, nested child-run retirement gating, and packaged recipe trust diagnostics.

## 0.20.2: Installed Extension Entrypoint Hotfix

- `[Packaging]` Added a JavaScript extension entrypoint wrapper and changed package metadata to load `./index.js`, so npm-installed packages import compiled `dist/index.js` instead of asking Node to strip `index.ts` under `node_modules`. Source checkouts still fall back to `index.ts` before a local build exists.
- `[Build]` Extended the compiled runtime build to emit `dist/index.js` alongside `dist/lib/*.js`, keeping extension entrypoint imports and script runtime imports on the same installed-package path model.
- `[Rooms]` Fixed immediate room append results to report the true persisted room message count after long timelines instead of the default 40-message preview length; `appendRoomMessage`, existing-member room joins, and `getRoomStatus()` now share the same line-count helper.
- `[Tests]` Added installed-package coverage that imports the extension entrypoint from package metadata without TypeScript stripping, plus room-count regression coverage beyond the default preview limit.

## 0.20.1: Installed Packaged Recipe Root Hotfix

- `[Recipe Imports]` Fixed installed compiled runtime path resolution so bare user recipe imports can fall back to the packaged standard-library `recipes/` directory instead of looking for a non-existent `dist/recipes` directory.
- `[Tests]` Added installed-package validation coverage for a user recipe that imports a packaged recipe by bare name, preserving the documented priority order for user, adjacent, and packaged recipes.

## 0.20.0: Compiled Runtime Entrypoints

- `[Packaging]` Added a build step that emits compiled `dist/lib/*.js` and declaration files from the TypeScript runtime modules, with relative `.ts` imports rewritten to `.js` for installed package execution.
- `[Async Runs]` Replaced the emergency installed-package copy workaround in `scripts/async-runner.mjs` with dist-first imports. Installed npm packages now execute the async runner against compiled JS without relying on Node native type stripping for `.ts` files under `node_modules`; source checkouts still fall back to TypeScript imports for local development.
- `[Scripts]` Updated `scripts/validate-recipe.mjs` to use the same dist-first import path, so packaged recipe validation also runs from compiled JS when installed from npm.
- `[Tests]` Updated installed-package smoke coverage to simulate `node_modules/@llblab/pi-actors` with `dist`, execute scripts without `--experimental-strip-types`, and assert the old `.type-strip-lib` workaround is not used.
- `[Package]` Changed the package description to `Local Actor Kernel for Pi`, added `tsconfig.build.json`, and included `dist` in the published package.

## 0.19.11: Installed Async Runner Hotfix

- `[Async Runs]` Fixed installed npm package async recipe launches on Node 22 by avoiding direct runtime imports of raw `.ts` files from under `node_modules` in `scripts/async-runner.mjs`. Installed runners now copy the package `lib` sources into the run state before importing them, keeping Node native type stripping outside the blocked `node_modules` path.
- `[Scripts]` Applied the same installed-package import guard to `scripts/validate-recipe.mjs`, so the packaged recipe validator works when invoked from an installed `@llblab/pi-actors` package.
- `[Tests]` Added installed-package script smoke coverage that copies `lib`/`scripts` under a temporary `node_modules/@llblab/pi-actors` path and verifies both async runner execution and recipe validation avoid `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

## 0.19.10: Legacy Branch Message Claim IDs

- `[Branch Messages]` Coordinator claim handling now assigns IDs to older/manual queued branch inbox entries that lack `id`, so injected direct messages can still transition to `handled` or `failed` and do not repeat forever.
- `[Tests]` Extended direct branch inbox coordinator coverage to include a legacy no-ID message and assert both claimed/handled timestamps are recorded.
- `[Docs/Context]` Updated actor-message docs and durable project context for legacy branch message claim IDs.

## 0.19.9: Locked Branch Inbox Mutations

- `[Branch Messages]` Added lock-guarded append and status rewrites for branch-local direct-message inbox files so concurrent direct delivery and coordinator claim/handle transitions do not overwrite each other.
- `[Coordinator]` Made room-swarm branch prompt execution atomically claim queued direct messages before injection, then mark claimed messages as `handled` or `failed` after the child prompt exits.
- `[Tests]` Added concurrent branch inbox append coverage and asserted coordinator direct-message handling records both `claimed_at` and `handled_at`.
- `[Docs/Context]` Updated actor-message docs, project context, and backlog safeguards for locked branch inbox mutations.

## 0.19.8: Efficient Room Status Reads

- `[Rooms]` Changed room status inspection to count JSONL entries and read only the last timeline record instead of parsing the full room timeline into actor-envelope objects.
- `[Inspector]` Preserved the existing `inspect room:<run> view=status` shape while reducing storage/read amplification for large room transcripts.
- `[Docs/Context]` Updated actor-message docs, backlog safeguards, and project context for efficient room status reads.
- `[Tests]` Added regression coverage that room status preserves message count and last-message metadata across longer timelines.

## 0.19.7: Burst-Safe Roster Writes

- `[Rooms]` Debounced room roster rewrites when a burst only changes a member's `last_seen`, while still writing semantic roster changes such as role, status, display, caps, claim, or parent immediately.
- `[Runtime IO]` Added `PI_ACTORS_ROOM_ROSTER_MIN_MS` as the roster-only debounce interval, mirroring the existing communication snapshot debounce approach without changing public `room:<run>` message or inspect semantics.
- `[Docs/Context]` Updated actor-message docs, project context, and the remaining rooms backlog scope to preserve the new burst-safe roster invariant during future storage/backend changes.
- `[Tests]` Added regression coverage for roster rewrite debounce and immediate semantic roster updates.

## 0.19.6: Conservative Retirement Candidates

- `[Observability]` Added per-run descendant `pi -p` worker counting and exposes `descendantSubagents` on run observations. Ambient run status still counts active descendant workers, but now retains the per-run attribution needed for supervisor lifecycle decisions.
- `[Retirement]` Tightened opt-in `retire_when: "children_terminal"` candidate detection so supervisors are not considered retirement-ready while command-template progress or descendant `pi -p` workers are still active.
- `[Docs/Context]` Updated async-run docs, project context, and the remaining retirement backlog scope to reflect the conservative candidate baseline and the remaining child async-run/output-flush work.
- `[Tests]` Added regression coverage that blocks retirement candidates with descendant subagents.

## 0.19.5: Branch Inbox Inspector Filters

- `[Actor Inspector]` Added branch-local inbox previews to the compact actor communication table, so queued direct `branch:<run>/<branch>` work is visible alongside room, run inbox, and outbox messages.
- `[Actor Inspector]` Added `/actors-inspector-filter unread`, `/actors-inspector-filter branch <name>`, and `/actors-inspector-filter current-branch <name>` to focus queued branch inbox work and one branch's room/direct/inbox traffic without exposing full payloads by default.
- `[Docs/Skills]` Updated README and the packaged actors skill with the new inspector filters and branch-inbox preview behavior.
- `[Backlog]` Closed the high-priority actor communication TUI preview item now that unread/current-branch navigation is implemented with branch read-state semantics.

## 0.19.4: User Recipe Collection Suggestions

- `[Observability]` Broadened recipe persistence suggestions from direct inline spawns to the normal user workflow: any successful actor run backed by a recipe outside `~/.pi/agent/recipes` now asks the launching agent to offer copying/registering it into the user recipe root when it fits this machine's recurring workflow.
- `[Runtime]` Preserved the ask-first boundary and suppression for recipes already in the user recipe root, so pi-actors grows operator muscle memory without silently writing user recipe files.
- `[Docs/Prompt]` Updated README, async-run docs, actors skill, onboarding prompt, and project context to frame `~/.pi/agent/recipes` as the everyday per-machine collection of reusable actor recipes/tools.
- `[Tests]` Added coverage for successful external recipe suggestions, while keeping user-owned recipe suppression covered.

## 0.19.3: Spawn Recipe Persistence Suggestions

- `[Observability]` Added semi-active recipe persistence suggestions for successful direct `spawn` runs. Inline/ad hoc spawned actors now record `launch_source: "spawn"`, and their successful terminal follow-up asks the agent to offer saving the reusable pattern as a durable recipe/tool under `~/.pi/agent/recipes` without auto-saving.
- `[Runtime]` Recorded `launch_source` metadata for actor starts so observability can distinguish direct spawns from registered recipe-tool runs and avoid prompting for actors already backed by user-owned recipes.
- `[Docs/Prompt]` Updated onboarding prompt guidance, README, async-run docs, and project context around ask-first recipe persistence after successful transient actors.
- `[Tests]` Added regression coverage for successful transient spawn suggestions and suppression when the run already came from a saved user recipe.

## 0.19.2: Actor Recipe Context Bundle

- `[Actor Context]` Added a recipe context bundle for file-backed async recipes. The runtime now collects the raw authored entry recipe and resolved imports into deterministic JSONL records with filename-derived `name`, import alias/path metadata, role/depth, and raw recipe JSON so spawned LLM actors can understand the workflow composition behind their prompt.
- `[Actor Context]` Annotated command-template leaves with actor recipe context and appends the JSONL bundle to child `pi -p` prompts. The recipe record that launched the current child receives `"you_are_here": true` plus path metadata, enabling actors to give advisory feedback on their own recipe/composition fit; recipes can opt out with `"actor_context": false` / `"off"` when a minimal prompt is required.
- `[Tests]` Added coverage for raw recipe context record generation, import identity, `you_are_here` JSONL marking, prompt injection for `pi -p`, execution-time context propagation, async-run persistence, and recipe opt-out behavior.

## 0.19.1: Actor Inspector Hotfix

- `[Actor Inspector]` Fixed the live communications roster and row numbering controls after real swarm usage. `/actors-inspector-toggle <rows>` now keeps the room preview cap aligned with the requested row count, current-run sequence numbers are assigned before row limiting so the visible tail keeps its full-log positions, and roster role labels use concise `name/role` text instead of slugifying full role descriptions.
- `[Coordinator]` Preserved explicit `--thinking off` forwarding in `scripts/coordinator.mjs` so packaged room-swarm launches keep caller-selected thinking policy instead of silently relying on CLI defaults.

## 0.19.0: Modular Coordination And Active Mailboxes

- `[Coordination]` Decoupled the overloaded `coordinator-locker.mjs` script into two completely independent, single-purpose components: a dedicated stateful `locker.mjs` (recipes `locker.json` and `coordinator-locker.json`) that manages resource locking, task queueing, and lease expirations; and a powerful, modular `coordinator.mjs` orchestrator. The coordinator manages execution lifecycles and process pools, supporting four distinct pluggable strategies via `--mode`: `consensus` (chat-swarm), `pipeline` (sequential), `fanout` (parallel review), and `pool` (worker pool pulling from locker).
- `[Actor Messages]` Implemented active direct actor inbox queue semantics. The modular coordinator now automatically inspects, claims (`claimed`), injects into prompt context, and finalizes (`handled` or `failed`) any queued direct branch messages (`branches/<branch>/inbox.jsonl`) during subagent executions, making direct messages active initiating work items. Backed by complete regression test coverage.

## 0.18.0: Actor Runtime Hardening And Recipe Guardrails

- `[Async Runs]` Made actor starts safer under concurrency and stale state. Duplicate active `run_id` / `state_dir` launches now fail before state is cleared, concurrent starts are serialized by a start lock, stale terminal run directories are cleaned automatically, and atomic JSON writes use collision-resistant temp names. Impact: restarts and concurrent launches no longer orphan active processes or overwrite logs, messages, progress, and control metadata.
- `[Command Templates]` Added a default parallel fanout cap of 64 branches, configurable with `PI_ACTORS_MAX_PARALLEL_BRANCHES`. Impact: accidental huge repeat/parallel expansions fail early instead of spawning unbounded child processes.
- `[Rooms & Messages]` Hardened room communication while preserving the single public actor-message model. Room timeline/roster/snapshot writes are serialized, branch direct messages are also persisted as queued per-branch inbox entries with IDs and internal claimed/handled/failed state transitions, bursty branch communication snapshot rewrites are debounced while root snapshots stay current, room reads use bounded tails, room timelines compact to a bounded retained tail, and `room:<run>` supports selected-recipient multicast via `metadata.recipients` while keeping one room-visible transcript entry. Impact: long-lived swarms can address subsets of same-run branches without subrooms, lost concurrent writes, unbounded room logs, repeated burst branch-snapshot rewrites, or expensive full-log reads.
- `[Actor Inspector]` Turned the inspector into a compact operator view for active actor coordination. It now has channel/mention filters, bounded body previews, default noisy-room row caps, an inline wrapping `role/name` roster summary with inactive departed participants muted, stable narrow-row rendering, plain name-driven actor identity, and bounded wide-character layout. Impact: operators can follow busy rooms, distinguish current and completed participants, and inspect selected messages without flooding the terminal, expanding roster dashboards, or adding extra preview-mode commands.
- `[Observability]` Reduced long-session overhead by pruning stale run observation state, caching active-subagent process scans, and expanding ambient run triangles with descendant `pi -p` workers launched by coordinators. Impact: terminal status remains useful during long actor sessions without retaining completed-run bookkeeping, repeatedly scanning `/proc` on every refresh, or showing one coordinator triangle when a visible worker tree is still running.
- `[Recipes]` Strengthened the recipe registry as a local capability surface. Recipe loading now rejects oversized files and excessive import depth, reports risky executable shapes and unsafe recipe-root permissions, exposes an integrity manifest, warns when the recipe-root watcher fails, derives recipe identity from filenames, resolves bare import names by recipe-root priority, and makes tool exposure location-derived: user recipe-root files are tools, packaged/ad hoc recipes are components. Impact: recipes are easier to audit, easier to compose from the standard library, harder to misuse accidentally, and no longer depend on redundant `name` / `tool` JSON fields for identity or exposure.
- `[Docs/Skills/Context]` Updated the README, actor-message/template-recipe/command-template docs, recipe-library/task-first docs, actors/swarm skills, onboarding prompt, and project context to reflect the hardened runtime, room/inspector controls, filename-derived recipes, location-derived tools, consensus-first build orchestration, shell-placeholder boundaries, and the rule that recurring multi-agent scenarios should grow packaged recipes/pipelines instead of task-local orchestration scripts. `BACKLOG.md` now stays focused on completable future work while durable operating principles live in project context.

## 0.17.1: Inspector Hotfix And Room Swarm Hardening

- `[TUI]` Fixed actor inspector line bounding to use `visibleWidth()` for direction/type/summary/body width math, replaced the verbose two-line preview with a hidden-by-default numbered table, made bare `/actors-inspector-toggle` open 12 rows from closed state, removed the verbosity toggle, made `/actors-inspector-toggle <rows>` update the live row count, upgraded `/actors-inspect <number>` to show a separated two-column header plus all preview-object properties as aligned two-space key/value columns, and added a styled wide-character regression. Impact: room previews with wide text no longer crash Pi, actor logs stay dense while preserving message type visibility, operators can tune visible row count without persistent inspector settings, and they can drill into one visible row then toggle back to the table.
- `[Recipe Library]` Added `pipeline-room-swarm` backed by `scripts/room-swarm.mjs`: repeated room-aware participants join `room:<run>`, coordinate over multiple room-visible rounds, leave cleanly, and synthesize the room transcript into a Markdown artifact. Roles can be supplied via `roles_path` to avoid raw JSON placeholders, default roles use plain actor names, room rosters preserve display metadata, and `locker=true` composes a local coordinator-locker cell for artifact locks and decision journaling with regression coverage. Direct branch delivery remains available for worker protocols that consume parent-run branch envelopes, but the packaged swarm no longer relies on it for peer coordination. Impact: the DeepSeek room-swarm experiment is now represented as a policy-light packaged scenario while concrete model choice remains caller/operator policy.
- `[Docs]` Reconciled `BACKLOG.md` back to future-only open work, removing completed hotfix implementation notes and version-scoped backlog language now captured in this changelog. Refreshed README and project context around the packaged room-swarm/coordinator-locker library surface and actor-inspector TUI ownership.

## 0.17.0: Actor Rooms And Inspector

- `[Actor Messages]` Added the 0.17 actor-room communication slice: `room:<run>` task rooms, append-only room timelines, room rosters, join/leave handling, same-run room/direct provenance checks, branch/run communication snapshots, `inspect room:<run> view=status|messages|previews|roster|contacts`, and `inspect run:<id> view=communication`. Impact: run actors and contacted branches can discover peers, post shared task messages, and inspect communication state through the same `spawn` / `message` / `inspect` actor model.
- `[TUI]` Added the hidden-by-default actor inspector widget with `/actors-inspector-toggle` and `/actors-inspector-verbosity-toggle`, compact and verbose layouts, current-run scoping, chronological sequence numbers, owner filtering, JSONL-tolerant preview reads, mobile-width and wide-character-aware truncation, and transparent/dark row striping. Impact: operators can see the current actor conversation at a glance without flooding the prompt or leaking unrelated session previews.
- `[Registry]` Added usage metadata and operator-gated cleanup recommendations to recipe registry summaries, removed stale public references to the old tool config filename, removed recipe content exposure markers from repository recipes/docs/fixtures, and fixed the 0.17 registry model around location-derived tool exposure: every recipe in `~/.pi/agent/recipes/*.json` is an agent tool, `register_tool` creates recipe files there under the hood, and packaged/ad hoc recipes outside that root are components. Impact: the sticky agent tool surface is explicit executable muscle memory, maintained like capability state rather than configured through per-recipe exposure flags.
- `[Docs]` Updated README, actor-message docs, async-run docs, recipe-library docs, actors skill, backlog, and project context around the room/roster protocol, inspector behavior, release-artifact hygiene, and the persistent-backlog-implementer protocol. The implementer workflow remains future recipe-composition work around reusable cells such as `coordinator-locker`, not bespoke release scripts.

## 0.16.4: Recipe Usage Fingerprints

- `[Recipe Usage]` Added content fingerprints to user recipe usage metadata. Impact: when a recipe file is edited and its authored meaning changes, the next launch resets `usage.calls`, records `usage.reset_at`, and starts counting usage for the current recipe content.
- `[Docs]` Documented fingerprint-backed usage reset semantics in the template recipe and tool registry docs.

## 0.16.3: Recipe Import Path Placeholders

- `[Template Recipes]` Added static `{repo}` and `{agent}` expansion for recipe paths, including `imports` and `from` bindings. Impact: recipes can import sibling packaged/user recipes without hard-coded absolute paths while keeping imports load-time deterministic.
- `[Docs]` Documented `{repo}` and `{agent}` import path placeholders in the template recipe standard.

## 0.16.2: Recipe Registry Diagnostics Hotfix

- `[Schema]` Derived recipe tool arguments without expanding runtime-dependent repeat nodes. Impact: valid recipes using repeat expressions such as `{lenses.length}` can be exposed as tools instead of being skipped during startup schema generation.
- `[Runtime]` Replaced the dense semicolon warning with grouped recipe registry diagnostics and explicit spacing. Impact: startup diagnostics are easier to scan and do not visually run into adjacent text.
- `[Recipes]` Added a packaged `lens-swarm` recipe that composes the review coordinator without concrete model-version defaults. Impact: the standard library includes the general multi-lens review launcher instead of relying only on operator-local copies.

## 0.16.1: Recipe Registry Hotfix

- `[Runtime]` Prevented invalid user recipe files from aborting extension startup when tool-schema generation fails, surfacing a warning and skipping the offending tool instead. Impact: one bad recipe in `~/.pi/agent/recipes` no longer takes down the pi-actors extension.
- `[Recipe Discovery]` Excluded the legacy migration report file from recipe discovery. Impact: legacy migration reports no longer appear as broken recipe/tool candidates after migration.

## 0.16.0: File-Discovered Recipe Registry Migration

- `[Version]` Began the `0.16.0` breaking-change cycle and captured the file-discovered recipe registry migration plan in `BACKLOG.md`. Impact: the next release target is now explicit: replace the legacy live registry with validated recipe files, filename identity, location-based exposure, override/disable semantics, migration reporting, registry inspection, and usage-informed cleanup.
- `[Recipe References]` Started filename-identity support for recipes by deriving the recipe id from the JSON filename when `name` is omitted, while preserving optional disabled and description metadata through recipe resolution. Impact: new recipe files can move toward filename-as-identity without losing human-readable descriptions.
- `[Recipe Discovery]` Added an initial file-discovered recipe registry domain with flat root scanning, filename ids, priority shadowing, invalid high-priority recipe blocking, disabled overrides, and exposure detection. Impact: the 0.16 registry migration now has a tested discovery core before wiring it into runtime loading.
- `[Recipe Migration]` Added a legacy registry migration domain that converts old registry entries into user recipe files, preserves descriptions/args/defaults/templates, refuses to overwrite existing recipe files, writes a migration report, and archives the source only when migration has no conflicts or invalid entries. Impact: the breaking registry transition now has a tested compatibility path from the old live registry.
- `[Recipe Discovery]` Captured the priority model that treats packaged pi-actors recipes as a standard library below ad hoc user-selected recipe files and below `~/.pi/agent/recipes/*.json`, with priority applying only to matching filename ids. Impact: override behavior now has a documented lens and a regression for standard-library versus user recipe precedence.
- `[Recipe Discovery]` Added source-level default tool exposure so the high-priority user recipe root can behave as the operator-managed tool set by default, while packaged/ad hoc recipes stay component-like. Impact: 0.16 keeps the discoverability advantage of the old tool-only registry without forcing a separate live tool config.
- `[Runtime]` Wired session-start tool loading to migrate the legacy registry, discover recipe-file tools from `~/.pi/agent/recipes` and packaged recipes, and register only active exposed recipes as runtime tools. Impact: the new recipe-discovered registry path is now active in runtime loading instead of only existing as standalone discovery/migration helpers.
- `[Registry]` Changed `register_tool` persistence to write/update/delete user recipe files under the recipe root instead of mutating the legacy JSON registry, while still activating the tool in the current session. Impact: newly registered tools now enter the 0.16 recipe-discovered registry directly.
- `[Docs]` Reworked tool-registry documentation, README examples, recipe docs, actor skill guidance, and prompt copy around recipe-file persistence, the user recipe directory as the default tool set, packaged recipes as standard-library components, and recipe files as the persistent tool surface. Impact: public guidance now matches the 0.16 runtime path instead of the old live JSON registry.
- `[Skill]` Added actors-skill guidance for same-name recipe priority, recipe-root-as-muscle-memory, usage counters, and an explicit cleanup rule for stale/default tools without automatic deletion or demotion. Impact: agents get the override model, sticky-tool tradeoff, and cleanup heuristic directly in the compact operational reference.
- `[Recipe Usage]` Added extension-maintained recipe launch metadata updates for user-owned runtime tools and direct async recipe starts, tracking `usage.calls` and `usage.last_called` without failure counters while leaving packaged standard-library recipes immutable, then documented the cleanup interpretation in recipe and tool-registry docs. Impact: the operator-managed recipe/tool set now accrues cleanup evidence for muscle-memory review from actual extension launches rather than manual agent bookkeeping.
- `[Runtime]` Added a best-effort user recipe-root watcher that debounces file changes and reloads recipe-backed tools during the active session, plus runtime-tool fingerprinting so repeated reloads do not re-register unchanged tools while changed definitions refresh, and stale recipe tools are removed from the active tool set on reload when their recipe disappears. Impact: newly created or edited valid recipe files can be connected without a full restart, without duplicate registration churn for unchanged recipes, while deleted recipe tools are deactivated even though host-level unregistration is still not available.
- `[Recipe Discovery]` Added a discovery summary helper and wired/documented `inspect target=recipes view=status|summary` to report active, shadowed, invalid, disabled, and diagnostic recipe entries. Impact: the registry inspection surface can explain why tools are present, hidden, broken, or disabled from the normal actor inspection tool.
- `[Backlog]` Reconciled 0.16 planning state after implementation of the core runtime path, usage counters, and reactive recipe reload behavior. Impact: remaining open work is now framed as hardening, inspection UX, and release validation instead of rediscovering already implemented pieces.
- `[Docs]` Normalized registry examples toward filename/tool ids that match the snake_case tool naming convention, avoiding mixed hyphen/underscore examples around `docs_review`, and aligned package image metadata with the local pi-actors banner. Impact: recipe identity, generated tool naming, and package presentation are less ambiguous in 0.16 guidance.
- `[Backlog]` Reconciled the recipe registry inspection surface after wiring the initial `inspect target=recipes` summary, then closed the active `0.16.0` release backlog by moving remaining non-blocking ideas to future curation, host-unregistration, discovery expansion, telemetry evolution, and opportunistic recipe-library sections. Impact: the backlog now distinguishes completed release scope from future follow-up work.

## 0.15.0: Packaged Actors Skill And Actor Vocabulary Cleanup

- `[Skill]` Reworked the packaged `actors` skill as a dense self-contained extension reference rather than a scenario catalog or changelog narrative, bundled the `swarm` methodology skill alongside it, synchronized packaged skill metadata versions with the package version, included `skills/` in the npm package contents, registered both skills in package metadata, and linked them from the README start points. Impact: fresh agents get compact practical coverage of pi-actors operation plus complementary multi-agent methodology without duplicating the two roles.
- `[Prompts]` Tightened the injected onboarding prompt into a shorter runtime bootstrap/reminder that avoids duplicating the skill and notes that README/docs are not automatically in context. Impact: session context stays compact while preserving operational lookup paths.
- `[Context]` Added a durable knowledge-surface separation convention for prompt, skill header/body, README, docs, and `AGENTS.md`. Impact: future edits have a clear role model for where each kind of pi-actors knowledge belongs and how it reaches the agent context.
- `[Backlog]` Reconciled task-first pipeline notes with the release-summary/review pipeline candidate in abstract terms. Impact: future pi-actors work can explore evidence preparation without tying the backlog to one completed release pass.
- `[Actor Tools]` Changed compact `inspect view=messages` and `message` tool output to use actor-message wording instead of public `event`/`delivery`/`outbox` labels. Impact: default tool output now reinforces the actor vocabulary while verbose JSON still exposes implementation details for diagnostics.
- `[Skill]` Reworded the packaged skill description to avoid extra frontmatter colons and replaced the compact two-branch Core Nouns sketch with an explicit two-path flow. Impact: skill metadata stays formatter-safe and the template→recipe→run versus template/recipe→tool relationship is easier to read.
- `[Recipe Library]` Added `utility-skill-summary` and routed `pipeline-release-readiness` through packaged skill evidence between package summary and validation. Impact: release readiness reports can verify skill metadata/package-version alignment, formatter-safe frontmatter, body size, and heading shape alongside changelog/package/validation evidence.
- `[Recipe Library]` Changed async-run operations recipes from public `message_file` inputs to `run_id` inputs, with the helper resolving implementation storage internally. Impact: packaged recipes no longer expose outbox paths as part of their public actor-operations surface.
- `[Recipe Library]` Added `coordinator-locker`, a long-lived actor recipe backed by `scripts/coordinator-locker.mjs` that manages a FIFO work queue, acquire/renew/release resource lease locks, a journal, and coordinator-directed actor messages, plus `utility-coordinator-lock-snapshot` for state inspection. Impact: future coordinated fanout recipes have a small local coordination cell instead of baking ad hoc queue/lock mechanics into each pipeline.
- `[Skill]` Clarified the actors skill's relationship to methodology skills and expanded it with a linked Recipe Navigator covering bundled coordination/service recipes, subagent atoms, pipelines, and utilities. Impact: the actors skill is now both the extension operation reference and the shortest agent-facing path to concrete packaged recipe files.
- `[Recipe Library]` Standardized all packaged async recipes to advertise `control.stop`, `control.cancel`, and `control.kill` in mailbox accepts. Impact: `inspect view=mailbox` now exposes the actor-native termination contract consistently across subagent atoms, coordinator cells, music, and pipelines.
- `[Recipe Library]` Removed concrete model-version defaults from packaged recipes, removed stale concrete model aliases from operator/docs examples, and added regressions that reject model-like defaults or provider/version aliases in recipe defaults and stale concrete model aliases in public guidance. Impact: reusable components stay policy-light and force the caller/agent to choose current model policy at launch instead of inheriting stale packaged aliases.
- `[Context]` Recompressed `BACKLOG.md` around current/future work only, added an 80/20 focus section for the remaining actor-vocabulary, recipe-policy, release-evidence pipeline, and utility-growth work, and promoted the backlog-is-planning rule into `AGENTS.md`. Impact: completed history stays in the changelog/docs while the backlog remains an actionable planning surface.
- `[Recipe Library]` Added `pipeline-release-summary`, an evidence-only release preparation pipeline that composes changelog, package, skill, and validation evidence into a release summary, risk checklist, and PR body draft artifact without commit, PR, merge, tag, publish, or other external release side effects. Impact: release-prep artifacts can be produced under pi-actors while gated release actions remain owned by release workflows.
- `[Docs]` Reworded remaining public README examples and the async-run operations pipeline prompt toward run-actor vocabulary instead of presenting async-run lifecycle wording as the primary operator concept. Impact: public guidance continues converging on `spawn`, `message`, `inspect`, and actor runs while low-level lifecycle language stays in implementation docs.
- `[Context]` Closed the active `0.15.0` backlog by moving completed actor-communication, component-policy, and utility-surface work out of open planning, leaving only future opportunistic work and the blocked branch-runner experiment. Impact: the release backlog now reflects no open release-blocking work.
- `[Skill]` Consolidated the bundled `swarm` methodology skill boundary by removing concrete pi-actors adapter examples and duplicate adapter/component docs from Swarm, keeping detailed MAWP mechanics in the dedicated reference instead of duplicating them in the general skill, and adding regressions that packaged Swarm markdown must not mention pi-actors runtime identifiers, package metadata must register every packaged skill, packaged skill markdown links must resolve, and the actors Recipe Navigator must link every bundled recipe file. Impact: Swarm can live inside this package while remaining portable methodology, and actors remains the shortest concrete path to packaged recipes.

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

## 0.12.1: Actor Tool Registry Name

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
