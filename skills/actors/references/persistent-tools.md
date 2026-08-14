# Persistent Tools

Use a persistent tool when the agent should call a trusted capability by name across turns or sessions. Use `spawn` instead for one-off Recipe execution.

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
  from=media/player
  defaults={"source":"~/Music/1MIX"}
```

`from` means logical direct delegation. The source remains authoritative for async behavior, caller args and types, source defaults, artifacts, Control, and runtime-owned origins. The persistent user Recipe stores only the compact specialization; do not copy inherited fields.

Use `description` to narrow agent-facing intent when useful. Every supplied default must name a caller-owned source arg and satisfy its type or enum. Never default runtime-owned origins.

## Prove registration

Read registration as a state transition, not one success word:

```text
resolved
→ validated
→ persisted
→ registry_active
→ host_registered
→ active_tool
→ callable_now
```

When `callable_now` is true, call the actual generated tool and verify `launch_kind: "tool"` when provenance matters. When false, stop at the reported activation boundary and use tool/Recipe diagnosis. A Recipe spawn is not an activation test or tool invocation substitute.

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
