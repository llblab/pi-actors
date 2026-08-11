# Tool Registry

`pi-actors` persists trusted local capabilities as Recipe files under:

```text
~/.pi/agent/recipes/*.json
```

Each active valid Recipe becomes an agent-callable tool. `register_tool` creates, updates, promotes, or deletes these files through fenced mutation paths.

## Registration

Register a command template:

```text
register_tool name=repo_check template="make check" description="Run repository checks"
```

Register a typed/defaulted template or Recipe-backed definition when reuse justifies it. String templates execute directly without shell semantics; use arrays or an explicit trusted script for sequencing.

Promote an immutable captured draft only with its draft path and explicit target name. Name collisions require `update=true`. Invalid content fails before active mutation.

## Resolution

User Recipes take priority over packaged Recipes. Active invalid or disabled shadowing blocks fallback and reports both paths. Runtime reload watches the Recipe root and converges after atomic changes; stale watcher generations cannot replace current registration state.

Inspect registry state with:

```text
inspect target=recipes view=status
inspect target=tool:<name> view=status
```

Recipe inspection reports active, shadowed, invalid, disabled, diagnostic, risk, usage, and review evidence. Tool inspection reports the current capability definition/schema; a registered tool is not a running actor.

## Automatic Review

Automatic draft/tool review remains silent and mechanically fenced:

- reviewers receive value-free structural projections rather than executable content, authored prose, paths, canonical names, or secrets;
- immutable batches and source hashes bind decisions;
- deterministic executors derive unchanged Recipe bytes from trusted captures;
- canonical locks, compare-and-swap checks, quarantine, journals, and lineage permit crash recovery;
- sensitive Recipes remain outside model review;
- approval and live activation occur at separate safe boundaries.

Reserved recovery uses runtime Controls:

```text
message target=runtime action=review.retry input={"scope":"draft"}
message target=runtime action=review.reset input={"scope":"tool"}
```

Retry preserves authenticated transaction recovery. Reset rejects evidence that requires roll-forward.

Set `PI_ACTORS_AUTOMATIC_REVIEW=off` to disable scheduling and safe-boundary activation while keeping policy visible in runtime inspection.

## Usage and Lineage

Usage and lineage live in locked metadata ledgers rather than authored Recipe files. Launch accounting briefly shares the portfolio transaction fence so quarantine cannot invalidate an already-authorized launch. Revision snapshots, rollback, demotion, rename, and identical-source deduplication retain CAS/hash evidence.

## Wrapping Existing Recipes

Prefer a small user-root wrapper that imports a maintained packaged or skill-owned Recipe by path and delegates by alias. Do not duplicate its executable template, defaults, Control declaration, or artifacts. Install only specific capabilities; internal automatic-review Recipes must not become user-callable tools.

## Safety

- Built-in/core names cannot be shadowed.
- Extension-authored mutation uses canonical per-path locks and atomic writes.
- Symlink substitution and paths outside trusted roots fail closed.
- Registry output stays bounded and redacted.
- Host registrations may remain visible because Pi cannot unregister dynamic definitions, but extension-local lookup consults the current active registry before execution.

## Related

- [Template Recipes](./template-recipes.md)
- [Recipe library](./recipe-library.md)
- [Runs](./async-runs.md)
