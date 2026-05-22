# Project Backlog

## Open Work

No release-blocking work remains for `0.16.0`.

## Future Work

### Recipe Registry Curation UX

- Priority: Medium.
- Status: `inspect target=recipes view=status|summary` exposes active, shadowed, invalid, disabled, and diagnostic recipe state. User-owned recipes track extension-maintained `usage.calls` and `usage.last_called`.
- Goal: Help operators curate the sticky `~/.pi/agent/recipes` tool surface without automatic deletion or demotion.
- Direction:
  - Include usage fields in recipe registry summaries.
  - Add cleanup recommendations for stale, duplicate, low-use, too-specific, invalid, disabled, and shadowing recipes.
  - Recommend explicit actions only: keep as tool, set `tool: false`, merge, delete, or archive.
  - Keep cleanup operator-gated; never silently delete or demote during unrelated work.
- Exit:
  - Operators can ask why a recipe/tool exists and what cleanup action is reasonable without reading files manually.

### Host-Level Tool Unregistration

- Priority: Low.
- Status: Deleted recipe files are removed from the active tool set on reactive reload; host-level registered tool definitions cannot currently be unregistered by this extension.
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
