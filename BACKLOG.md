# Project Backlog

## Open Work

### Actor Rooms, Roster, and Cross-Branch Messaging

- Priority: High.
- Goal: Continue evolving actor communication without adding a second public messaging model.
- Direction:
  - Evaluate whether room storage/routing should remain built into the tool adapter or move behind a dedicated non-LLM communication actor recipe/script, possibly singleton-scoped. Preserve the same public `room:<run>` address and envelope either way.
  - Consider reducing direct file-backed state where it improves coherence: model room/roster state as actor-owned data structures served by helper scripts/actors, with files retained only for durable snapshots, recovery, artifacts, or audit logs.
  - Add selected-recipient multicast for a subset of actors without creating subrooms.
- Exit:
  - Any backend/storage change preserves existing `spawn` / `message` / `inspect` semantics and room address compatibility.
  - Selected-recipient multicast remains route-based and does not introduce named subrooms.

### Actor Communication TUI Preview

- Priority: Medium.
- Goal: Make actor-to-actor communication more navigable in the terminal UI without exposing large payloads by default.
- Direction:
  - Add explicit filters for current branch, room, direct messages, unread messages, and mentions.
  - Add a roster panel for current run/room participants with address, role, caps, status, and last seen.
  - Collapse long bodies by default and respect sensitive/redacted metadata.
  - Rate-limit noisy rooms and keep full body inspection intentional.
- Exit:
  - Operators can answer “what are the actors saying?” from the TUI at a glance, then intentionally inspect full room or direct-message bodies when needed.

### Persistent Backlog Implementer Workflow

- Priority: Medium.
- Goal: Express persistent front/back backlog implementers as reusable extension-level recipe composition instead of bespoke workflow scripts.
- Direction:
  - Use existing coordination cells such as `coordinator-locker` for queue/assignment/locking semantics.
  - Compose existing subagent launcher recipes for execution slices rather than adding dedicated implementer scripts.
  - Add missing reusable component recipes only when an implementer scenario cannot be expressed with the existing library.
  - Update `skills/actors/SKILL.md` whenever a new implementer/coordinator recipe is added so agents know which scenario to launch and which packaged recipes to use.
  - Preserve the protocol insight: implementers report `task.result` / `awaiting_assignment`, stay alive between assignments, and stop only after coordinator-issued control.
- Exit:
  - A packaged workflow, if added, is described by recipes and existing helper cells; no one-off backlog-implementer scripts are required.
  - The actors skill documents the supported launch scenarios and the concrete packaged recipes for each.

### Recipe Schema Simplification

- Priority: Medium.
- Goal: Remove recipe metadata that duplicates storage context.
- Direction:
  - Remove `name` from the recipe standard. Recipe identity should come from the recipe filename/id rather than a redundant JSON property. Keep migration/backward compatibility explicit for existing packaged and user recipes.
  - Finish hardening validators/discovery against recipe-owned tool exposure: tool status should be determined by location under `~/.pi/agent/recipes/*.json`, while packaged/ad hoc/component recipes are not tools by default. Repository recipes and docs no longer author `tool`.
- Exit:
  - Docs, validators, packaged recipes, discovery, and migration behavior all agree on filename-derived identity and location-derived tool exposure.

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

### Recipe Discovery Expansion

- Priority: Low.
- Direction:
  - Add nested recipe directories only after flat `recipes/*.json` discovery semantics are stable.
  - Keep same-id priority and invalid-blocking behavior explicit if nested ids are introduced.

### Recipe Usage Telemetry Evolution

- Priority: Low.
- Direction:
  - Consider sidecar stats sync/backup policy after inline user-owned `usage.calls` / `usage.last_called` proves useful.
  - Do not add failure counters as primary usefulness evidence unless there is a strong operator-facing need.

### Opportunistic Recipe Library Growth

- Priority: Low.
- Direction:
  - Add new utilities or pipelines only when a concrete repeated task pattern justifies them.

## Blocked Work

### Branch-Local Checkpoint Semantics

- Priority: Low.
- Blocked by: At least one real collaborative branch-runner async-run experiment.
- Scope: Validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are enough for branch-local validation and bounded reattempts.
- Exit: Record one decision: sufficient, documentation-only refinement needed, or propose one minimal command-template extension with tests.
