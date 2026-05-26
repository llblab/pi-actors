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

### M-01 Internal Protocol Contract Pack

- Priority: Medium.
- Goal: Add machine-readable internal schemas and fixtures for implementation, docs, tests, and inspector consistency.
- Files:
  - `schemas/actor-message.schema.json`.
  - `schemas/actor-address.schema.json`.
  - `schemas/run-state.schema.json`.
  - `schemas/run-inbox-message.schema.json`.
  - `schemas/run-outbox-event.schema.json`.
  - `schemas/room-message.schema.json`.
  - `schemas/room-roster.schema.json`.
  - `schemas/communication-snapshot.schema.json`.
  - `schemas/recipe.schema.json`.
  - `fixtures/protocol/run-minimal.json`.
  - `fixtures/protocol/message-branch.json`.
  - `fixtures/protocol/message-room-join.json`.
  - `fixtures/protocol/mailbox-contract.json`.
- Acceptance:
  - Normalization outputs validate.
  - Docs examples validate.
  - Fixtures are usable by tests.
  - Schemas are versioned with package version.

### M-02 Unified Actor Event Base

- Priority: Medium.
- Goal: Add a shared base envelope for actor event-like records without forcing one storage file.
- Target channels:
  - `events`.
  - `inbox`.
  - `outbox`.
  - `wake`.
  - `room`.
  - `branch`.
- Acceptance:
  - New append helpers generate ids consistently.
  - Existing files remain readable.
  - `inspect` can show id, correlation, and causation.
  - No migration is forced.

### M-03 Mailbox Contract v1

- Priority: Medium.
- Goal: Extend `mailbox.accepts` and `mailbox.emits` from string arrays to backward-compatible typed contracts.
- Direction:
  - Keep string declarations valid.
  - Normalize typed entries for inspection.
  - Support fields such as body schema, ack requirement, idempotency, response requirement, level, and summary.
- Acceptance:
  - String declarations still work.
  - `inspect view=mailbox` shows normalized contracts.
  - Messages outside accepts produce advisory warnings by default, not hard blocks.
  - Docs clarify advisory versus strict mode.

### M-04 Actor Loop Helper SDK

- Priority: Medium.
- Goal: Provide reusable helpers for mailbox-consuming actors so recipe authors do not rewrite loops.
- Files:
  - `lib/actor-loop.ts`.
  - `scripts/actor-loop.mjs`.
- Capabilities:
  - Initial reconciliation.
  - Wake subscription.
  - Polling fallback.
  - Run and branch inbox claiming.
  - Handled and failed status transitions.
  - Outbox emission.
  - Progress updates.
  - Graceful stop handling.
- Acceptance:
  - A packaged demo recipe uses a mailbox-only control endpoint.
  - Concurrent wake and poll paths do not double-process messages.
  - Helper supports run inbox and branch inbox.

### M-05 Branch Delivery Unification

- Priority: Medium.
- Goal: Route direct branch messages and room multicast branch copies through one internal helper.
- Target helper:
  - `routeBranchEnvelope(stateDir, runId, message, { source })`.
- Acceptance:
  - Direct branch messages and room multicast produce the same durable branch inbox shape.
  - Parent run dispatch envelope is consistent.
  - Tests cover both paths.

### M-06 Attention Semantics v1

- Priority: Medium.
- Goal: Formalize coordinator attention behavior through semantic metadata rather than transport knobs.
- Direction:
  - Support attention metadata such as `requires_response=true` and reason.
  - Map response-required messages to follow-up.
  - Keep progress/info messages inspectable or notify-only.
  - Preserve existing internal `delivery` behavior.
- Acceptance:
  - `requires_response=true` becomes coordinator follow-up.
  - Progress info stays log or notification.
  - Explicit stop and kill controls do not create duplicate terminal follow-up.

### M-07 Recipe Doctor

- Priority: Medium.
- Goal: Add intentional recipe health inspection.
- Surface:
  - `inspect target=recipes view=doctor`.
  - `inspect target=recipes view=doctor verbose=true`.
- Checks:
  - Import graph health.
  - Shadowing and blockers.
  - Invalid or disabled recipes.
  - Risky command templates.
  - Absolute path portability.
  - OS compatibility.
  - Root permissions.
  - Mailbox completeness.
  - Artifact placeholder resolution.
  - Stale or unused usage.
- Acceptance:
  - Compact output is grouped by severity.
  - Verbose output is structured.
  - No automatic cleanup happens.
  - Every diagnostic has reason and suggested actions.

### M-08 Artifact Manifest v1

- Priority: Medium.
- Goal: Extend recipe artifacts from string paths to backward-compatible artifact metadata.
- Direction:
  - Keep string artifact paths valid.
  - Add optional object fields such as path, kind, media type, and required.
  - Resolve manifests with existence, size, and optional hash.
- Acceptance:
  - String artifacts remain valid.
  - Runtime resolves manifest with `exists`, `size`, and optional `sha256`.
  - Terminal follow-ups group named artifacts.
  - Missing required artifacts are visible in result and inspect output.

### M-09 Lifecycle Retention Policy

- Priority: Medium.
- Goal: Add explicit archive and prune behavior for terminal run state.
- Messages:
  - `control.archive`.
  - `control.prune`.
- Direction:
  - Only terminal runs can be archived or pruned.
  - Active runs fail closed.
  - Archive moves or compresses state with a tombstone.
  - Prune deletes terminal state after ownership checks, optionally preserving artifacts.
- Acceptance:
  - Terminal cleanup candidates are inspectable.
  - Artifacts can be preserved.
  - Active run deletion is impossible.

### M-10 Inspector v2 For Unread Mentions And Needs Response

- Priority: Medium.
- Goal: Strengthen the TUI inspector as the operator membrane for multi-actor sessions.
- Direction:
  - Add stable event ids in previews.
  - Add unread cursor per session, run, and room.
  - Preserve mention filtering.
  - Add needs-response marker from attention semantics.
  - Distinguish room timeline rows from branch inbox rows.
- Acceptance:
  - `/actors-inspector-filter unread` works.
  - `/actors-inspector-filter mention <text>` works.
  - `/actors-inspect <number>` marks the item read for the current session.
  - Unread state stays UI/session metadata, not protocol truth.

### M-11 Run State Index

- Priority: Medium.
- Goal: Add a rebuildable run-state index to reduce recursive scans and improve observability performance.
- Target file:
  - `~/.pi/agent/tmp/pi-actors/runs/index.json`.
- Contents:
  - State dir.
  - Run id.
  - Owner id.
  - Status.
  - Updated time.
  - Recipe or tool.
- Acceptance:
  - Index accelerates list and summarize.
  - Corruption falls back to scan.
  - Rebuild helper exists.
  - Nested runs are represented without id collision.

### M-12 Internal Conformance Runner

- Priority: Medium.
- Goal: Add a CI-ready internal conformance runner for pi-actors protocol behavior.
- Script:
  - `npm run conformance`.
- Suites:
  - Recipe discovery.
  - Register, update, and delete.
  - Spawn lifecycle.
  - Message routing.
  - Room roster.
  - Branch inbox.
  - Ownership checks.
  - Artifacts.
  - Attention semantics.
- Acceptance:
  - Runs without Pi UI where possible.
  - Outputs compact report.
  - Fixtures live in the repository.
  - CI can run it.

### M-13 Packaged Actor Worker Recipe Template

- Priority: Medium.
- Goal: Add a canonical packaged recipe or template for a long-lived worker-backed branch actor.
- Direction:
  - Worker joins room.
  - Worker declares mailbox accepts and emits.
  - Worker claims branch inbox messages.
  - Worker posts `task.claim`, `task.result`, and `awaiting_assignment`.
  - Worker handles `control.stop`.
- Acceptance:
  - Recipe demonstrates correct mailbox loop semantics.
  - It is a recipe-authoring example, not a product feature.

### M-14 Recipe Usage Integrity Improvements

- Priority: Medium.
- Goal: Make recipe usage tracking more explainable.
- Direction:
  - Add fingerprint diff reason.
  - Add reset reason.
  - Consider optional last error.
  - Split launch counts by tool, spawn, and direct recipe.
- Acceptance:
  - `inspect recipes view=summary verbose=true` shows whether usage refers to current recipe content.
  - Doctor can flag unused current meaning instead of stale old recipe history.

### M-15 Safer Command Warning Policy

- Priority: Medium.
- Goal: Unify command-template diagnostics by severity and make warnings actionable without startup spam.
- Severity:
  - `info`: portability.
  - `warning`: broad mutation, shell, or eval.
  - `error`: impossible, invalid, or unsafe repeat.
- Direction:
  - Treat legitimate `bash` wrappers as expected trusted boundaries when already packaged or explicitly registered.
  - Keep routine shell wrapper notes out of startup warning blocks.
  - Surface shell/eval/destructive diagnostics through register-time warnings, doctor, and verbose recipe inspection.
- Acceptance:
  - Command-template warnings include command label, reason, and suggested mitigation.
  - `register_tool` shows relevant warnings.
  - Recipe doctor aggregates warning policy.
  - Startup no longer emits large warning blocks only because recipes wrap `bash`.

### M-16 Output And Log Size Governance

- Priority: Medium.
- Goal: Keep stdout, stderr, result, outbox, and actor-message previews bounded in agent context.
- Direction:
  - Centralize constants for body preview, outbox preview, inspector preview, and tail lines.
  - Keep verbose output opt-in.
  - Prefer files or artifacts for large bodies.
- Acceptance:
  - Actor messages and previews share consistent caps.
  - Verbose mode is explicit.
  - Large bodies do not flood normal tool output.

### M-17 Windows And Nix Portability Pass

- Priority: Medium.
- Goal: Strengthen current portability around FIFO, named-pipe, and mailbox-only paths without adding a new backend.
- Direction:
  - Doctor flags FIFO-only recipes on native Windows.
  - Keep mailbox-only demo cross-platform.
  - Document platform matrix.
  - Cover named-pipe adapter with injected sender where practical.
- Acceptance:
  - Native Windows limitations are visible before launch.
  - Mailbox-only recipe works cross-platform.
  - Docs and tests cover the adapter split.

### M-18 State Corruption Recovery

- Priority: Medium.
- Goal: Add resilient JSON and JSONL state readers.
- Direction:
  - Malformed JSONL lines should not kill entire inspect paths.
  - Corrupt JSON files should report diagnostics with paths.
  - Consider optional `.corrupt` quarantine helper.
- Acceptance:
  - Inspect remains useful when partial state survives.
  - Corrupt paths are reported clearly.
  - Canonical state is not silently rewritten without explicit action.

### M-19 Recipe Import Graph Inspector

- Priority: Medium.
- Goal: Add focused inspection for recipe import graphs.
- Surface:
  - `inspect target=recipes view=imports`.
  - `inspect target=recipes view=imports verbose=true`.
- Acceptance:
  - Shows import graph, aliases, resolved paths, and shadowed imports.
  - Shows cyclic and depth diagnostics.
  - Helps debug packaged and user recipe composition.

### M-20 Spawn Preflight Mode

- Priority: Medium.
- Goal: Add dry-run launch planning for `spawn` and async recipe tool invocation.
- Direction:
  - Resolve recipe, imports, args, artifacts, state dir, command graph, and mailbox metadata.
  - Do not start a process.
  - Return warnings and resolved launch plan.
- Acceptance:
  - `preflight=true` returns a resolved plan.
  - No process is spawned.
  - Missing args and risky commands are reported before launch.

### M-21 Run Restart And Reattach Policy

- Priority: Medium.
- Goal: Clarify and implement safe behavior for reused `run_id` and `state_dir`.
- Direction:
  - Active reuse fails closed.
  - Terminal restart with same id is allowed under explicit semantics.
  - Record generation or restarted time.
  - Preserve previous terminal-state policy.
- Acceptance:
  - Active reuse remains blocked.
  - Terminal restart records generation or `restartedAt`.
  - Inspect shows restart semantics.
  - Docs are updated.

### M-22 Actor Address Helper CLI And Tooling

- Priority: Medium.
- Goal: Improve address normalization and diagnostics for recipe authors and tests.
- Direction:
  - Add helper functions or inspect view for address validation.
  - Improve invalid-address diagnostics.
- Acceptance:
  - Diagnostics include expected forms.
  - Examples cover branch, room, run, session, and tool addresses.
  - No new public address kinds are added.

### M-23 Room Compaction Metadata Improvements

- Priority: Medium.
- Goal: Record richer room compaction metadata.
- Direction:
  - Track dropped count.
  - Track first and last kept timestamps.
  - Track configured max.
- Acceptance:
  - `inspect room:<run> view=status verbose=true` shows compaction info.
  - Compaction never corrupts JSONL.
  - Tests cover low `PI_ACTORS_ROOM_MAX_MESSAGES`.

### M-24 Coordinator Follow-Up Deduplication

- Priority: Medium.
- Goal: Suppress duplicate terminal transitions and outbox follow-ups across watcher reloads, session restarts, or line-counter resets.
- Direction:
  - Use event id and stateDir for deduplication where available.
  - Preserve terminal handled semantics.
  - Simulate watcher restart in tests.
- Acceptance:
  - Duplicate follow-up is suppressed after reasonable watcher reset.
  - Terminal handled state remains effective.
  - Tests cover restart and line-counter reset scenarios.

### M-25 Documentation Refactor Runtime Contracts First

- Priority: Medium.
- Goal: Reorganize docs so implementation agents find stable contracts before examples.
- Target order:
  - `docs/runtime-contracts.md`.
  - `docs/actor-messages.md`.
  - `docs/async-runs.md`.
  - `docs/tool-registry.md`.
  - `docs/template-recipes.md`.
  - `docs/command-templates.md`.
  - `docs/recipe-authoring.md`.
  - `docs/troubleshooting.md`.
- Acceptance:
  - No polling-first examples.
  - Every example matches fixtures.
  - Docs distinguish protocol semantics from Pi UI commands.
  - No external standard or MCP work is introduced.

## Suggested Milestone Order

```text
Patch release:
  H-01..H-12

Minor 0.23 — Contract consolidation:
  M-01, M-02, M-03, M-12, M-25

Minor 0.24 — Runtime/message reliability:
  M-04, M-05, M-06, M-13, M-24

Minor 0.25 — Operator hygiene:
  M-07, M-08, M-09, M-14, M-15, M-16

Minor 0.26 — Inspector and state scaling:
  M-10, M-11, M-18, M-19, M-23

Minor 0.27 — Portability and lifecycle polish:
  M-17, M-20, M-21, M-22
```

## Blocked Or Opportunistic Carry-Over

### Branch-Local Checkpoint Semantics

- Priority: Low.
- Blocked by: At least one real collaborative branch-runner async-run experiment.
- Goal: Validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are enough for branch-local validation and bounded reattempts.
- Exit:
  - Record one decision: sufficient, documentation-only refinement needed, or propose one minimal command-template extension with tests.

### Host-Level Tool Unregistration

- Priority: Low.
- Blocked by: Host API support for custom tool unregistration.
- Goal: Remove stale dynamically registered tool definitions completely when the host API supports it.
- Direction:
  - Track pi extension API support for custom tool unregistration.
  - Replace active-tool deactivation fallback with real unregister when available.
  - Preserve current safe behavior: deleted tools should not remain active after reload.
- Exit:
  - Deleting a recipe file removes the corresponding runtime tool definition and active-tool entry without session restart.

### Actor Recipe Feedback Loop

- Priority: Low.
- Goal: Turn actor recipe-context awareness into a practical improvement loop for packaged recipes and operator-owned recipe memory.
- Direction:
  - After real multi-agent runs, capture whether child actors report that recipe/import/mailbox/role boundaries fit the task.
  - Keep the loop advisory and operator-gated.
  - Prefer small recipe, README, and skill refinements over scenario catalogs.
- Exit:
  - At least one real run produces recipe-boundary feedback that is applied or explicitly rejected with rationale.
