# Management Inspection

The public `inspect` tool exposes four exact target families. Targets are management projections, not interchangeable aliases.

## Target and View Matrix

| Target | Views | Purpose |
| --- | --- | --- |
| `run:<id>` | `recipe`, `trace`, `control` | Inspect one accessible Run generation |
| `runtime` | `status`, `runs`, `triage` | Inspect package policy, owned Run inventory, or aggregate operational pressure |
| `recipes` | `status`, `summary`, `doctor`, `imports`, `reviews` | Inspect user Recipe discovery, active Skill components, exact resolution, imports, and automatic-review recovery |
| `tool:<name>` | `status`, `schema` | Inspect persistent-tool activation/usage or its current callable schema |

`verbose=false` normally returns compact text and `verbose=true` returns structured details. `tool:<name> view=schema` is always structured because its callable parameter schema has no useful compact equivalent.

## Run Targets

```text
inspect target=run:demo view=recipe
inspect target=run:demo view=trace source=lifecycle lines=40
inspect target=run:demo view=control lines=20
```

Run views require a current coordinator session and an exact, non-empty match between that session id and the Run's persisted owner. Possessing a `run:<id>` is not authorization. Missing coordinator identity, ownerless state, and cross-owner state fail closed.

- `recipe` returns captured generation-local Recipe, launch, policy, and artifact declarations.
- `trace` returns the bounded unified projection plus retained-history completeness. `source` accepts `all`, `lifecycle`, `control`, `process`, `agent`, `artifact`, or `runtime`; `lines` bounds returned rows.
- `control` returns endpoint readiness, declared and runtime-owned actions, pending capacity, saturation, stale work, diagnostics, and recent redacted records; `lines` bounds recent records.

Use the runtime inventory when a remembered Run id is inaccessible from the current session:

```text
inspect target=runtime view=runs
```

## Runtime Targets

```text
inspect target=runtime view=status
inspect target=runtime view=runs
inspect target=runtime view=runs status=failed
inspect target=runtime view=triage
```

- `status` reports immutable package/runtime identity, state schema, and current automatic-review policy.
- `runs` returns the complete inventory owned by the current coordinator session; it is not paginated or capped by `lines`. Optional `status` filters that exact-owner inventory.
- `triage` aggregates the same exact-owner inventory into failed Runs, pending/stale Controls, backpressure, incomplete Trace diagnostics, and retained attention evidence.

Runtime inventory never broadens authorization and never returns ownerless or foreign Run state.

## Recipe Targets

```text
inspect target=recipes view=status
inspect target=recipes view=summary
inspect target=recipes view=doctor identity=music-player/playback
inspect target=recipes view=imports verbose=true
inspect target=recipes view=reviews verbose=true
```

- `status` reports registry/watch state, active/shadowed/invalid/disabled user Recipes, active Skill components, drafts, usage, and diagnostics.
- `summary` returns the compact discovery-oriented projection of the same current context.
- `doctor` diagnoses one canonical `<skill>/<recipe>` identity when `identity` is provided; without an identity it reports registry remediation evidence.
- `imports` exposes active Skill namespaces and component import inventory for resolution diagnosis.
- `reviews` exposes bounded automatic draft/tool review state and recovery guidance.

`identity` is accepted only with `view=doctor`. Skill inventory is fail-soft diagnostic evidence; exact launch and registration still resolve against the immutable active-session context.

## Tool Targets

```text
inspect target=tool:music_player view=status
inspect target=tool:music_player view=schema
```

- `status` separates persistence, registry admission, host registration, `callable_now`, activation boundary, source identity, and `tool_calls` versus `spawn_calls`.
- `schema` returns the currently callable description, parameter schema, and prompt snippet. It fails clearly when a definition is persisted but its live callable schema is unavailable.

A registered tool is a capability definition, not a Run. Tool status cannot substitute for Run inspection, and Recipe spawning cannot prove registered-tool invocation.

## Boundaries

Inspection is read-only, owner-filtered where Run state is involved, and redacted. Evidence-heavy Run, review, diagnostic, and text projections apply their documented bounds; `runtime view=runs` deliberately returns the complete matching exact-owner inventory. Inspection does not mutate journals, infer authority from displayed data, expose private active-Skill installation paths, or turn retained Trace into an audit archive. Use `message` for admitted runtime or actor-local actions.
