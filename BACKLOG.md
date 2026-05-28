# Project Backlog

## Implementation Boundary

Work only inside `pi-actors`: strengthen the current Pi extension and local actor kernel. Do not split work into an external transportable standard, do not design `mcp-actors`, and do not change public positioning.

Current carrying contour:

- `spawn`, `message`, and `inspect` stay the durable public verbs.
- Async run state stays file-backed and inspectable.
- Tool exposure stays recipe-based and location-derived from `~/.pi/agent/recipes`.
- Durable inbox and outbox files remain canonical intent and message state.
- Rooms, rosters, and branch inboxes remain local coordination memory.
- Wake notifications remain advisory acceleration, not the queue.
- Operator-facing observability stays explicit and bounded.

Core invariant:

```text
Recipe = portable executable capability.
Run = addressable lifecycle instance.
Message = typed semantic envelope.
Mailbox = durable intent queue.
Wake = advisory acceleration.
Room = shared local coordination memory.
Inspect = intentional observation.
Artifact = durable result.
```

Non-goals:

- Distributed workers.
- Generic scheduler DSL.
- Cloud sync.
- External transport standard.
- MCP implementation.
- Arbitrary subrooms.
- Heavy broker abstraction.

## Hotfix Backlog

No open hotfix items.

## Minor Backlog

The backlog is intentionally pruned to the 20% of work most likely to deliver 80% of value for `pi-actors` as a local actor kernel. Bias toward consolidation, smaller public surface area, and reliability over new feature breadth.

### M-01 State Corruption Recovery

- Priority: High.
- Status: Done.
- Goal: Keep `inspect` useful when file-backed run, room, branch, or recipe state is partially corrupted.
- Why now: The extension's core promise is local, inspectable, durable actor state. Corrupt JSON/JSONL should degrade visibility, not break the operator membrane.
- Direction:
  - Continue migrating repeated JSON/JSONL inspect paths to `lib/state-readers.ts`.
  - Preserve valid records and report corrupt paths/counts.
  - Do not silently rewrite canonical state without an explicit repair action.
- Acceptance:
  - Malformed JSONL lines do not kill inspect paths.
  - Corrupt JSON files surface diagnostics with paths.
  - Tests cover run, branch, room, and recipe-adjacent state where practical.

### M-02 Actor Loop Helper Minimal Core

- Priority: High.
- Status: Done.
- Goal: Provide one small reusable mailbox loop so recipe authors do not duplicate claim/handle/status logic.
- Why now: Long-lived actors and worker recipes are the natural center of `pi-actors`; a minimal helper consolidates behavior without adding a broker or scheduler DSL.
- Files:
  - `lib/mailbox-loop.ts`.
- Direction:
  - Support run inbox claiming, branch inbox claiming, handled/failed status transitions, bounded drains, duplicate-claim protection, and graceful stop-message detection.
  - Defer live wake subscription and polling wrappers until the canonical worker recipe needs them.
  - Keep policy out: no task selection, no model choice, no project prompts.
- Acceptance:
  - Helper supports run inbox and branch inbox.
  - Claim/handle/fail transitions are covered by tests.
  - Duplicate branch claims do not double-process one message.
  - Bounded drains stop on standard control messages.

### M-03 Canonical Worker Recipe Template

- Priority: High.
- Status: Done.
- Depends on: M-02.
- Goal: Add one canonical packaged worker recipe/template demonstrating the intended long-lived actor pattern.
- Why now: The extension should teach one excellent mailbox loop rather than accumulate scenario-specific scripts.
- Direction:
  - Worker joins the default room.
  - Worker declares typed mailbox accepts/emits.
  - Worker claims branch inbox work.
  - Worker posts `task.claim`, `task.result`, and `awaiting_assignment`.
  - Worker handles `control.stop`.
- Acceptance:
  - Demonstrates correct mailbox loop semantics.
  - Stays a recipe-authoring reference, not a product workflow catalog.
  - Actor skill links it as the canonical worker pattern.

### M-04 Protocol Contract Fixtures

- Priority: Medium.
- Status: Done.
- Goal: Freeze the current protocol behavior with compact internal fixtures before further surface growth.
- Why now: `spawn`, `message`, `inspect`, mailbox contracts, artifacts, rooms, and run indexes now have enough shape to merit regression fixtures; schemas should document reality, not invent a new standard.
- Direction:
  - Add fixtures for representative run state, actor message, run inbox/outbox, room message/roster, mailbox contract, artifact manifest, and recipe summary.
  - Add lightweight schema or shape validation only where it protects existing behavior.
- Acceptance:
  - Public examples and fixtures validate in tests.
  - No migration is forced.
  - No external transport/MCP standard is introduced.

### M-05 Follow-Up Deduplication Hardening

- Priority: Medium.
- Status: Done.
- Goal: Suppress duplicate terminal transitions and outbox follow-ups across watcher reloads, session restarts, or line-counter resets.
- Why now: Operator-facing observability should be calm and trustworthy as actor count grows.
- Direction:
  - Continue using event id and stateDir for deduplication where available.
  - Preserve terminal handled semantics.
  - Simulate watcher restart in tests.
- Acceptance:
  - Duplicate follow-up is suppressed after reasonable watcher reset.
  - Terminal handled state remains effective.
  - Tests cover restart and line-counter reset scenarios.

### M-06 Portability Reality Pass

- Priority: Medium.
- Status: Done.
- Goal: Make current Linux/macOS/WSL/native-Windows behavior explicit without adding a new backend.
- Why now: Mailbox-only paths and named-pipe support exist; operators need accurate diagnostics, not hidden platform assumptions.
- Direction:
  - Doctor flags FIFO-only recipes on native Windows.
  - Keep mailbox-only worker demo cross-platform.
  - Document a small platform matrix.
  - Cover named-pipe adapter with injected sender where practical.
- Acceptance:
  - Native Windows limitations are visible before launch.
  - Mailbox-only recipe works cross-platform.
  - Docs and tests cover the adapter split.

### M-07 Compiled Script Entrypoints

- Priority: Medium.
- Status: Done.
- Goal: Bring packaged script entrypoints under the build so installed npm recipes run against compiled runtime code.
- Why now: Recipes increasingly depend on helper scripts that import extension internals; compiling script logic closes the gap between source-tree development and installed package behavior.
- Direction:
  - Keep stable executable recipe paths through thin `scripts/*.mjs` shims.
  - Keep substantive reusable script logic in compiled `lib/*.ts` modules so scripts stay lightweight runners and `dist/lib` is the JS-only runtime surface; allow self-contained application scripts to remain standalone `.mjs` when no reuse is expected.
  - Keep `npm run build` checking packaged script entrypoint syntax while compiled module migration proceeds.
  - Make installed scripts prefer `dist` runtime modules and avoid importing `.ts` from `node_modules`.
  - Preserve source-tree developer ergonomics without requiring global install.
  - Expose compiled JS as the default Node-compatible extension entrypoint and source TS/skill paths as optional metadata for TypeScript-native runtimes.
  - Treat `dist/` as the JS-only distributive tree: mirror runtime assets (`scripts/`, `recipes/`, `fixtures/`, and `skills/`) there during build and point default package metadata at those dist assets.
  - Track each converted script with a compiled module existence regression so shim drift is caught before packaging.
- Acceptance:
  - `npm run build` covers packaged script logic, not only extension library code.
  - Installed-script tests prove packaged recipes do not import TypeScript from `node_modules`.
  - `npm run pack:dry` includes expected compiled/script files.
  - Recipe paths remain stable or migrations are explicitly documented.

### M-08 Recipe Doctor Remediation UX

- Priority: High.
- Status: Done.
- Goal: Turn recipe doctor output into an operator action surface, not just a diagnostic listing.
- Why now: Recipe registry warnings are intentionally actionable; the next value is helping operators decide whether to fix, disable, delete, or inspect a recipe without hiding the warning.
- Direction:
  - Summarize invalid, blocking, shadowed, disabled, and risky shell-boundary entries with compact recommended actions.
  - Keep remediation advisory by default; no automatic mutation of user recipes.
  - Preserve detailed diagnostics through verbose inspection.
- Acceptance:
  - `inspect target=recipes view=doctor` identifies the highest-priority actionable maintenance item.
  - Blocking invalid recipes include the blocked lower-priority candidate when available.
  - Tests cover at least invalid/blocking, disabled, shadowed, and risky shell diagnostics.

### M-09 Actor Worker v2

- Priority: High.
- Status: Done.
- Goal: Promote `actor-worker` from a minimal demo into the canonical standard-worker reference pattern.
- Why now: Mailbox-loop semantics are now stable enough to show artifact production, compact status, and stale-claim recovery without adding a scheduler or broker.
- Direction:
  - Add optional task result artifact writing.
  - Expose compact worker status for `inspect` and room events.
  - Add stale-claim recovery or timeout semantics where they fit the mailbox-loop helper.
  - Preserve policy-light behavior: no model choice, prompt design, or project task selection.
- Acceptance:
  - Worker can produce a durable artifact path for handled work.
  - Stale claimed work can be surfaced or recovered deterministically.
  - The actors skill documents the v2 worker pattern.

### M-10 Dist Package Contract Hardening

- Priority: Medium.
- Status: Done.
- Goal: Make the dist-first package contract difficult to regress after the 0.24 packaging shift.
- Why now: `dist/` is now the default JS-only runtime surface and carries mirrored scripts, recipes, fixtures, and skills.
- Direction:
  - Add package-layout checks for default metadata, source metadata, mirrored assets, and compiled script-domain modules.
  - Add negative checks for stale renamed dist files and source-only runtime imports from installed packages.
  - Keep source files packaged for TypeScript-native runtimes unless a future package-size decision changes that explicitly.
- Acceptance:
  - `npm run validate` fails if default Pi metadata points outside `dist` unexpectedly.
  - Installed-package tests cover every script shim that imports compiled domain logic.
  - Pack dry assertions cover `dist/scripts`, `dist/recipes`, `dist/fixtures`, and `dist/skills`.

### M-11 Actor Termination Semantics

- Priority: Medium.
- Status: Done.
- Goal: Make `control.kill` the canonical parent-to-actor termination action while keeping `control.stop` and `control.cancel` as actor-domain messages whose meaning depends on the actor protocol.
- Why now: Mailbox workers need a clearer lifecycle boundary before v2 patterns harden. Treating `stop`, `cancel`, and `kill` as equivalent stop messages blurs actor termination with domain-specific task or playback control.
- Remaining direction:
  - Audit packaged recipe `mailbox.accepts` declarations so `control.stop` and `control.cancel` appear only when actor-specific behavior is meaningful.
  - Preserve `control.kill` as the universal lifecycle action for a parent/supervisor terminating an actor or run.
  - Reframe any remaining docs that imply `control.stop` or `control.cancel` are generic runtime termination aliases.
  - Do not preserve compatibility shims for the old stop/cancel-as-termination behavior before the first 1.0 major release unless a concrete safety issue appears during implementation.
- Acceptance:
  - Docs and actors skill advertise `control.kill` as canonical parent-to-actor termination.
  - Mailbox-loop helpers/tests distinguish actor termination from actor-domain `stop`/`cancel` handling.
  - Packaged recipes declare `stop`/`cancel` only when the actor-specific behavior is meaningful.
  - Tests assert that generic mailbox-loop termination is not triggered by `control.stop` or `control.cancel`.

## Explicitly Deferred

These are valid ideas but not current focus. Reintroduce only with concrete evidence from real actor workflows.

- Spawn preflight mode: useful later, but lower value than resilient inspect and mailbox-loop consolidation.
- Run restart/reattach policy: risky for isolation; defer until corruption recovery and protocol fixtures are stronger.
- Actor address helper CLI: keep diagnostics improving opportunistically inside existing parser/tests.
- Documentation refactor: defer until the canonical mailbox loop and worker recipe exist; avoid rewriting docs twice.
- Host-level tool unregistration: blocked on host API support.
- Branch-local checkpoint semantics: wait for real collaborative branch-runner experiments.
- Actor recipe feedback loop: keep advisory and operator-gated after real runs produce evidence.

## Suggested Milestone Order

```text
Next milestone: choose from deferred items only after concrete actor workflow evidence appears.
```
