# Diagnostics

Preserve the intended logical identity and diagnose through public pi-actors surfaces. Do not inspect raw registry files or implementation source as the normal first response.

## Recipe resolution or catalog failure

```text
inspect target=recipes view=status
inspect target=recipes view=doctor identity=<skill>/<recipe>
```

Use the focused doctor form for one intended identity. It reports active-Skill ownership, exact resolvability, partial-catalog state, component status, portable source location, resolution generation, any rejection, and bounded next actions. Use the unfiltered doctor only for catalog-wide diagnosis. A partial catalog does not imply every exact component is unavailable. If the owning Skill is inactive, report that blocker rather than locating and running its helper manually.

## Persistent tool failure

```text
inspect target=tool:<name> view=status
inspect target=tool:<name> view=schema
```

Distinguish persistence, registry admission, host registration, active-tool membership, and `callable_now`. Confirm the source identity, effective caller schema, separate tool/spawn usage, and last launch kind when exposed.

If persistence succeeded but callability is false, do not use `spawn` and claim the tool worked. Follow the reported activation boundary or stop.

## Run failure

```text
inspect target=run:<id> view=recipe
inspect target=run:<id> view=trace
inspect target=run:<id> view=control
inspect target=runtime view=status
```

Use Recipe view for captured identity/launch evidence, Trace for bounded observations, Control for readiness/capacity/stale work, and runtime status for kernel-level health. Treat retained-history completeness honestly.

## Safe failure protocol

1. Keep the exact intended Recipe/tool/Run identity.
2. Identify the owning public surface.
3. Record exact resolver, registry, activation, or Run truth.
4. Apply only the bounded next action returned by that owner.
5. Retry only after the owning state is healthy.

Stop if evidence remains contradictory or the requested operation cannot be proven. Never recover by copying maintained contracts, hard-coding installation paths, directly executing bundled helpers, adding `bash -lc` or `eval`, shell-backgrounding work, editing unrelated Skills, or relabeling a Recipe spawn as a tool call.
