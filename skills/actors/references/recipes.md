# Recipes

A Recipe is a reusable executable definition. Address a maintained component as `<active-skill>/<direct-filename-stem>` or use an explicit `.json` / `.md` path. Recipe files do not declare their own top-level `name`.

## Direct delegation

Use direct delegation when the root remains fundamentally the same capability under a different persistent name, description, or caller default:

```text
media/player
→ music_player with a default source
```

For agent-facing persistent specialization, use:

```text
register_tool from=media/player defaults={"source":"~/Music/1MIX"}
```

The delegated root inherits async behavior, args and types, defaults, artifacts, Control, and runtime-owned origins. Do not copy those fields into the wrapper.

## Named import composition

Use imports when authoring a graph with reusable named nodes:

```json
{
  "imports": {
    "review": "swarm/quorum-review",
    "report": "artifacts/report"
  },
  "template": [
    { "name": "review" },
    { "name": "report" }
  ]
}
```

Imports are local definitions inside one execution graph. An imported child does not automatically make its Control contract the root Run's Control contract. Do not use imports merely to wrap one Recipe with defaults.

## Caller and runtime ownership

Callers provide only the effective public args. The runtime owns Recipe/Skill location, Run state, Trace, generation, owner/session, and related execution origins. Never declare, default, or override runtime-owned inputs.

Keep selected model, thinking, mission, concurrency, quorum, and timeout caller-owned unless the capability Skill documents stable policy.

## Resolution behavior

Exact resolution uses the current immutable session Skill context. An invalid unrelated component may make catalog inventory partial, but it must not block an unrelated exact valid identity. A disabled, missing, ambiguous, or changed target fails closed without ambient fallback.

If direct spawn and persistent admission disagree for the same identity, stop and diagnose. Do not switch to an absolute helper path, copy the source contract, or execute the helper directly.
