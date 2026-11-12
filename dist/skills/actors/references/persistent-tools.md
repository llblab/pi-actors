# Persistent Tools

Use a persistent tool when the agent should call a trusted capability by name across turns or sessions. Use `spawn` instead for one-off Recipe execution.

## Select the capability, not the execution mode

Both sync and async Recipes can be tools. Sync invocation awaits the result; async invocation returns a launch receipt and the eventual result arrives separately. Neither synchrony nor a model-backed implementation establishes usefulness. A subagent-backed tool launches a capability, not a saved live subagent. Synchronous tools execute inline; non-singleton async calls launch Run executions, while singleton attachment follows its existing compatibility contract.

Prefer a stable purpose/name, caller-owned parameterized inputs, a clear result/acceptance boundary, understood effects and failure/cancellation limits, and meaningful leverage over existing tools or one-off `spawn`. Do not register every transient mission or a generic arbitrary-prompt alias merely to add a name. A successful registration is not permission for new effects, and a launch receipt is not successful task completion.

Current user-root Recipes are tool candidates by location; Skill components do not become tools automatically. Explicit create-only retention is supported through `register_tool expose=false`; it is separate from tool exposure. Automatic retained lifecycle is not implemented. Read-only `inspect target=recipes view=summary` reports retained counts for `recipes/library`; use `verbose=true` for exact `retained` paths, resolved mode, invalid/disabled state and diagnostics. Reuse a valid enabled entry through `spawn recipe=<exact path>` with required caller values, or deliberately register it with `from=<exact path>`. A stored definition is not review, activation or Run evidence; use `tool:<name>` for activation and `runtime view=runs` for running instances. A `library/<stem>` usage-lineage label is private accounting identity, not a callable name or Skill Recipe reference; reuse the exact file path from inspection. Do not populate or migrate the live registry manually. `expose` is a registration input, not a Recipe field; do not invent review actions or bypass unsupported retained mutations. Existing explicit `register_tool` works for both modes; automatic review remains under its existing policy. Launch counts and value-free structural review alone do not establish semantic purpose, a good name, or accepted useful reuse.

## Choose one source mode

```text
Maintained or explicit-file Recipe
→ register_tool from=<skill>/<recipe|path.json|path.md>

Trusted command template
→ register_tool template="..."

Reviewed captured draft
→ register_tool draft=<draft-path>
```

Do not mix source modes.

## Specialize a maintained Recipe

```text
register_tool
  name=music_player
  from=music-player/playback
  defaults={"source":"~/Music/1MIX"}
```

`from` means logical direct delegation. The source remains authoritative for async behavior, caller args and types, source defaults, artifacts, Control, and runtime-owned origins. The persistent user Recipe stores only the compact specialization; do not copy inherited fields.

Resolution uses Pi's authoritative active-session Skill snapshot across every Skill location Pi admits. Registration resolves and validates the maintained source, persists only its logical `<skill>/<recipe>` reference plus caller specialization, and projects the already-resolved effective contract into the runtime tool. Never replace this composition with a copied Recipe, absolute helper path, symlink, or ambient runtime re-resolution.

Use `description` to narrow agent-facing intent when useful. Every supplied default must name a caller-owned source arg and satisfy its type or enum. Never default runtime-owned origins.

## Retain without exposing a tool

Use `register_tool name=<name> expose=false from=<skill>/<recipe>` or a trusted `template` source to create `recipes/library/<name>.json`. A description is still required for authored command templates; source defaults/args/origins still belong to the maintained Recipe. This is create-only: retained `update=true`, null/empty deletion, `draft` mode and direct Recipe dependencies on managed disposable drafts are rejected, including Recipe-valued template leaves. A duplicate retained JSON/Markdown stem is a conflict; no older file is overwritten.

The `kind: retained_recipe`, `activation: not_requested` receipt confirms persistence/admission, not host activation or review. It returns the exact Recipe path and required/optional argument names, without global callability flags or default values. A same-named tool is left untouched. Use the exact returned path with `spawn`; if compact output omits the whole path, follow its read-only verbose Recipe inspection hint rather than guessing it. Retention records no launch and makes no self-contained-backup promise for referenced sources.

To expose a retained capability deliberately, call ordinary `register_tool name=<tool> from=<exact retained path>`, prove activation below, then call the actual tool. Deleting that admitted wrapper through the ordinary deletion path leaves the retained source; it does not stop active Runs. This is not a migration or safe-retention rule for old standalone tools.

Publication uses a complete atomic no-overwrite file link; unsupported filesystems refuse without an overwrite fallback. A storage, admission or lock-release failure can follow committed bytes. Inspect the retained inventory and preserve the original cause; do not blindly repeat the request or delete an uncertain file.

## Prove registration

When tool exposure was requested, read registration as a state transition, not one success word:

```text
resolved
→ validated
→ persisted
→ registry_active
→ host_registered
→ active_tool
→ callable_now
```

For tool exposure, when `callable_now` is true, call the actual generated tool and verify `launch_kind: "tool"` when provenance matters. When false, stop at the reported activation boundary and use tool/Recipe diagnosis. A Recipe spawn is not an activation test or tool invocation substitute.

Use:

```text
inspect target=tool:<name> view=status
inspect target=tool:<name> view=schema
inspect target=recipes view=doctor
```

## Command templates

Use `template` only for a trusted command definition, not to make the agent guess whether a string is command text or Recipe delegation. Give raw command tools an agent-facing description and declare or infer only caller-owned args. Use a Recipe file when reusable composition or lifecycle policy is needed.

## Updates and deletion

Use `update=true` only for an intentional replacement. Preserve the existing capability when candidate resolution, validation, persistence, or activation fails. Use the compact deletion form documented by the live `register_tool` schema; do not create a second deletion mechanism.

## Stop rules

Stop rather than:

- copying source Recipe args, defaults, artifacts, Control, or helper command;
- invoking a Skill helper by installation path;
- using `spawn` and claiming the tool was called;
- treating persistence as callability;
- adding shell evaluation or backgrounding to bypass registration;
- editing an unrelated rejected Skill component unless that repair is explicitly requested.
