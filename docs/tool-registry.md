# Tool Registry

`pi-actors` persists trusted local capabilities as Recipe files under:

```text
~/.pi/agent/recipes/*.json
```

Each valid Recipe admitted against the current session context can become an agent-callable tool. `register_tool` creates, updates, promotes, or deletes these files through fenced mutation paths and reports the resulting activation state.

## Registration

Register a command template:

```text
register_tool name=repo_check template="make check" description="Run repository checks"
```

Specialize a maintained Recipe without copying its contract:

```text
register_tool name=music_player from=music-player/playback defaults={"source":"~/Music/1MIX"}
```

`from`, `template`, and `draft` are distinct source modes. `from` accepts exact `<skill>/<recipe>` identity or an explicit `.json` / `.md` path and inherits async behavior, args/types, source defaults, artifacts, Control, and runtime-owned origins. `defaults` may set only effective caller-owned args and must satisfy their types. `template` is only for trusted command definitions; public `values` authoring has been removed in favor of caller defaults or an authored Recipe file.

Promote an immutable captured draft only with its draft path and explicit target name. Name collisions require `update=true`. Invalid content fails before active mutation.

Registration resolves the effective delegated contract before persistence, then reports logical `source`, effective `required_args` / `optional_args`, and distinct `persisted`, `registry_active`, `host_registered`, `active_tool`, and `callable_now` states. A callable result points to the actual generated tool as the next action. An uncallable result names its `activation_boundary` and status/doctor action without suggesting spawn as a substitute. Diagnose one maintained source with `inspect target=recipes view=doctor identity=<skill>/<recipe>`; diagnose final activation, source, schema summary, and separate spawn/tool usage with `inspect target=tool:<name> view=status`. Treat the tool as callable in the current session only when `callable_now` is true; persistence alone is not activation proof. Registration results omit raw persisted paths and executable template/config payloads.

## Resolution

User Recipes are the only file-discovered tool source. Invalid or disabled user entries fail closed. Active Skill Recipes remain exact components outside tool discovery. Spawn, registration, registry admission, schema derivation, and live inspection resolve against one immutable session context containing the current working directory and active Skills. Runtime reload watches the user Recipe root using that current context and converges after atomic changes; stale watcher generations cannot replace current registration state.

Skill component inventory is diagnostic and fail-soft: valid components remain listed and exactly resolvable when an unrelated component is rejected. Recipe inspection reports rejected components and marks the catalog partial instead of treating one bad component as an empty catalog.

Inspect registry state with:

```text
inspect target=recipes view=status
inspect target=tool:<name> view=status
```

Recipe inspection reports generation, scan/watch state, active, shadowed, invalid, disabled, component rejection, diagnostic, risk, usage, and review evidence. Tool status reports current activation plus separate `tool_calls` and `spawn_calls`; tool schema reports the caller-owned capability contract. A registered tool is not a running actor.

`spawn recipe=<name>` executes a Recipe and reports `launch_kind: "spawn"`; it does not prove that a registered tool was exposed or invoked. Registered-tool execution reports `launch_kind: "tool"`.

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

## Specializing Existing Recipes

Use `register_tool from=<skill>/<recipe> defaults={...}` for one maintained capability under a persistent name or narrower defaults. Pi supplies one authoritative active-session Skill snapshot across global, project, package, settings, CLI, and extension-contributed locations. Registration resolves the source from that snapshot, stores only the logical direct-delegation reference plus caller specialization, and activates the tool from the already-resolved effective contract without ambient re-resolution. It does not copy async, args/types, Control, artifacts, helpers, or runtime-owned `{recipe_dir}`/`{skill_dir}`; symlinks and absolute helper paths are not substitutes. Named imports remain for multi-node Recipe composition, not one-source specialization. Skill Recipes remain components and are never exposed merely because their Skill is active. Install only specific capabilities; internal automatic-review Recipes must not become user-callable tools.

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
