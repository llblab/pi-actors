# Template Recipe Standard

A Template Recipe is a file-backed, reusable command-template graph. It adds stable identity, typed inputs, composition, optional detached execution, artifacts, Control, and provenance around the portable [Command Template Standard](./command-templates.md).

## Mental Model

A Recipe has three layers:

1. **Recipe contract**: identity, description, arguments, defaults, imports, lifecycle, artifacts, and Control.
2. **Command-template graph**: the executable string, sequence, parallel fanout, conditions, retry, and output behavior stored in `template`.
3. **Run projection**: detached process state, Trace, Control delivery, artifacts, and inspection when `async: true`.

Use a Recipe when a command graph should be named, validated, reused, imported, registered as a tool, or launched as a Run. Use an inline command template when file identity and Recipe metadata add no value.

## File Formats

Recipes may be authored as JSON or Markdown. Both formats compile to the same Recipe contract.

### JSON

JSON is the most direct form for structured composition:

```json
{
  "description": "Create a repository health report",
  "args": ["repo:path", "artifact_path:path", "model:string"],
  "defaults": {
    "artifact_path": "{state_dir}/health.md"
  },
  "async": true,
  "artifacts": {
    "report": "{artifact_path}"
  },
  "template": {
    "template": "pi -p {repo} --model {model}"
  }
}
```

### Markdown

Markdown uses YAML frontmatter for the Recipe contract and one executable fence for `template`:

````markdown
---
description: Summarize one file
args:
  - file:path
---

Human-facing notes may explain intent and usage.

```template
summarize {file}
```
````

Executable fences may be marked `template`, `command-template`, `json`, or `recipe`. Narrative Markdown outside the executable fence is advisory and is not executed.

Choose JSON for dense machine-oriented graphs. Choose Markdown when a short executable definition benefits from nearby human guidance.

## Identity and Placement

Recipe identity comes from its location and filename, never from a top-level `name` field.

| Placement | Identity | Typical use |
| --- | --- | --- |
| Direct file under an active Skill's `recipes/` directory | `<skill>/<filename-stem>` | Maintained Skill capability |
| Explicit `.json` or `.md` path | Resolved file path with filename-stem evidence | Local or project-specific composition |
| File under `~/.pi/agent/recipes` | Registered user tool identity | User-maintained reusable tool |

A Skill Recipe is one direct file under `<skill>/recipes/`. Nested files are not Skill components. The Skill name comes from its active `SKILL.md`; the Recipe stem comes from the direct filename.

A Recipe file must not declare top-level `name`. Within a command-template graph, a node-level `name` has a different purpose: it invokes an alias declared in `imports`.

## Recipe Field Reference

The following fields belong to the file-level Recipe contract. Unless noted otherwise, each field is optional.

| Field | Type | Default | Contract |
| --- | --- | --- | --- |
| `description` | string | none | Human-facing purpose used by discovery and tool surfaces. Describe the outcome, not implementation history. |
| `disabled` | boolean | `false` | Prevents launch and import when `true`. Use it to make an authored Recipe intentionally unavailable without deleting the file. |
| `args` | string[] | inferred/untyped placeholders | Declares public inputs. Entries may be untyped (`input`), typed (`file:path`), enum-constrained (`mode:enum(check,fix)`), or include an inline default (`limit:int=10`). Names must be unique and agree with placeholder types. |
| `defaults` | object | `{}` | Supplies fallback values for declared inputs. A default may reference another placeholder and is resolved recursively with a depth bound. Every authored default must correspond to a declared argument. |
| `values` | object | `{}` | Binds composition values before executing the Recipe graph. Use for authored wiring between wrapper/import context and template nodes, not for caller-owned configuration. |
| `imports` | object | `{}` | Maps local aliases to other Recipes. Each value is a canonical Skill reference, explicit file path, or binding object with `from`, `defaults`, and/or `values`. Imports are resolved and validated before launch. |
| `template` | string, array, or command-template object | required | Defines the executable command-template graph. It may directly execute commands, compose nodes, invoke import aliases, or delegate to another Recipe. |
| `async` | boolean | `false` | Launches the Recipe as a detached Run when `true`. Detached execution owns durable state, Trace, terminal reconciliation, and optional Control/artifacts. |
| `singleton` | boolean | `false` | Gives one async Skill Recipe a stable `run:<skill>` service slot. Valid only with `async: true`; at most one singleton Recipe may belong to a Skill. |
| `artifacts` | object of string paths | `{}` | Declares named files produced by the Run. Paths support placeholders, resolve under containment policy, and appear in Run inspection. |
| `control` | string[] | `[]` | Declares actions consumed by an actual controlled service. Actions must be unique lowercase ASCII names, non-reserved, and at most 64 characters. |
| `retire_when` | `"children_terminal"` | none | Opts an async supervisor into retirement after all owned child Runs become terminal. Omit it for ordinary Run lifecycle. |
| `actor_context` | boolean or `"off"` | enabled | Controls injection of Recipe composition context into compatible child-agent prompts. Use `false` or `"off"` only when a deliberately minimal child prompt is required. |

### Value Resolution

For a declared name, effective values resolve in this order:

```text
caller values
→ node/import/Recipe values
→ defaults
→ inline argument default
→ missing-value error
```

The selected value is then validated against its declared type or enum. Runtime-provided origin values such as `{recipe_dir}` and `{skill_dir}` are immutable and cannot be declared or overridden through `args`, `defaults`, or `values`.

## Command-Template Fields

A Recipe may place command-template execution fields beside `template`, and any object node inside the graph may use the same fields. Their execution semantics are defined by the [Command Template Standard](./command-templates.md).

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `label` | string | none | Human-readable node label for diagnostics and branch reports. |
| `parallel` | boolean | `false` | Runs an array node concurrently instead of sequentially. |
| `concurrency` | positive integer or placeholder | unlimited | Caps simultaneous children of a parallel node. |
| `min_successful` | non-negative integer or placeholder | none | Requires a minimum count of successful branches with non-empty stdout. |
| `when` | boolean or expression | `true` | Skips the node when its guard resolves false. |
| `timeout` | milliseconds or placeholder | `0` / unbounded | Terminates an execution attempt after a positive duration. |
| `delay` | milliseconds or placeholder | `0` | Waits before starting the node. |
| `retry` | positive integer or placeholder | `1` | Sets total attempts, including the first attempt. |
| `failure` | `continue`, `branch`, or `root` | `continue` | Selects how a node failure propagates through composition. |
| `recover` | command template | none | Runs cleanup between failed attempts; a recovery failure ends retry. |
| `repeat` | non-negative integer or expression | none | Repeats a node, exposing the current index to placeholders. |
| `accept_output` | supported semantic contract | none | Applies fail-closed semantic validation to otherwise successful stdout. |
| `output` | string selector | `stdout` | Selects the result channel returned by the graph. |

Keep Recipe metadata at the file level and execution behavior near the node it controls. For object form, place `template` last so readers encounter contract and execution flags before executable content.

## Imports and Composition

Imports are local aliases within one resolved execution graph:

```json
{
  "description": "Review and format one report",
  "args": ["input:string", "thinking:string=medium"],
  "imports": {
    "review": "swarm/quorum-review",
    "format": {
      "from": "../shared/report.md",
      "defaults": {
        "thinking": "{thinking}"
      }
    }
  },
  "template": [
    {
      "name": "review",
      "values": {
        "input": "{input}"
      }
    },
    {
      "name": "format",
      "values": {
        "input": "Use prior output"
      }
    }
  ]
}
```

### Accepted References

An import `from` value accepts exactly one of these forms:

| Form | Resolution |
| --- | --- |
| `<skill>/<recipe>` | One direct filename stem under the exact active Skill |
| `./file.json` or `../file.md` | Relative to the importing Recipe's directory |
| `/absolute/path/to/file.json` | Exact absolute file |

An entry Recipe path resolves from invocation `cwd`. A relative import resolves from the importing Recipe, not from invocation `cwd`. Bare ambient names and implicit fallback search are not part of the contract.

Duplicate active Skill names, duplicate JSON/Markdown stems, missing references, disabled targets, import cycles, and excessive import depth fail closed. A launched Run captures the resolved graph; later catalog changes affect future launches only.

### Import Bindings

A string import uses the target as authored:

```json
{ "review": "swarm/quorum-review" }
```

An object binding can supply alias-local defaults or values:

```json
{
  "review": {
    "from": "swarm/quorum-review",
    "defaults": { "thinking": "medium" },
    "values": { "mode": "strict" }
  }
}
```

Use `defaults` when callers may override the value. Use `values` for authored composition wiring subject to the normal resolution order.

### Direct Delegation

A Recipe may use another Recipe as its entire template. The delegated Recipe remains authoritative while the wrapper may narrow public arguments, defaults, or selected lifecycle metadata. Singleton Run and Recipe identities remain owned by the delegated singleton; wrappers cannot create alternate service identities.

## Async Runs and Singleton Services

`async: true` changes execution from an inline result to a detached Run. The Run receives durable state, stdout/stderr evidence, Trace, generation identity, and terminal reconciliation.

A singleton Recipe additionally follows these rules:

- it must be a direct Recipe owned by one active Skill;
- it must declare `async: true`;
- one Skill may declare at most one singleton Recipe;
- its logical address is `run:<skill>`;
- a compatible repeated launch reuses the healthy active generation;
- conflicting Recipe identity, owner, startup values, or Control contract fails closed;
- terminal generations are never reused;
- singleton identity alone does not restore workload state after restart.

Use singleton only for a genuine long-lived Skill service. Ordinary jobs should remain non-singleton Runs.

## Control

Declare Control only when the launched process consumes actor-local input:

```json
{
  "description": "Run a controllable service",
  "async": true,
  "control": ["pause", "resume", "stop"],
  "template": "{skill_dir}/scripts/service.mjs --state-dir {state_dir}"
}
```

Control action names are lowercase ASCII, unique, non-reserved, and at most 64 characters. Serialized Control input is limited to 380 bytes so admitted wire records remain within 512 bytes on FIFO and named pipe transports.

Do not use Control as a general data channel. Large inputs belong in declared files or artifacts; outputs belong in Trace, artifacts, execution evidence, or the command result.

## Artifacts

Declare deterministic outputs by stable name:

```json
{
  "artifacts": {
    "report": "{state_dir}/report.md",
    "manifest": "{state_dir}/manifest.json"
  },
  "template": "generate-report --output {state_dir}/report.md"
}
```

Artifact declarations do not create files. The Recipe must write them and fail when its write policy cannot be honored. Inspection reports declaration, availability, size, and digest evidence without treating undeclared arbitrary paths as public artifacts.

## Runtime Origins

Every file-backed Recipe receives immutable `{recipe_dir}`, the directory containing the Recipe file. A Recipe directly owned by an active Skill also receives `{skill_dir}`, the directory containing that Skill's `SKILL.md`.

| Placeholder | Availability | Meaning |
| --- | --- | --- |
| `{recipe_dir}` | every file-backed Recipe | Stable origin for Recipe-relative helpers and assets |
| `{skill_dir}` | active Skill-owned Recipe only | Stable origin for Skill-owned helpers and assets |
| `{state_dir}` | async Run context | Generation-local durable Run state directory |
| `{current_model}` | when current Pi policy is available | Current model inherited as an explicit resolved value |
| `{current_thinking}` | when current Pi policy is available | Current thinking policy inherited as an explicit resolved value |

Origin and policy placeholders expand through templates, recursive defaults/values, imports, and artifacts where applicable. Resolution fails before launch when a required runtime value is unavailable.

Example policy inheritance:

```json
{
  "args": ["model:string", "thinking:string"],
  "defaults": {
    "model": "{current_model}",
    "thinking": "{current_thinking}"
  },
  "template": "pi -p inspect --model {model} --thinking {thinking}"
}
```

## Context and Provenance

A file-backed launch captures generation-local records for the entry Recipe and every resolved import. Records include role, filename stem, logical reference, Skill identity when applicable, and import alias ancestry.

Logical identities are exposed to Inspector and child-agent context. Machine-local physical paths remain local execution provenance and are not promoted into model-facing launch values.

`actor_context` controls only compatible child-prompt injection:

```json
{
  "actor_context": false,
  "template": "pi -p minimal-task"
}
```

Disabling injected context does not remove Run provenance or change the authored task prompt.

## Authoring Checklist

1. Choose a direct Skill identity or explicit file location.
2. When useful, add one outcome-oriented `description`; descriptions are optional.
3. Declare every public input in `args`, including types where useful.
4. Put overridable fallback configuration in `defaults`.
5. Add imports only when composition earns a stable local alias.
6. Keep execution flags on the node they govern.
7. Use `async` only when detached lifecycle or durable evidence is required.
8. Declare `control` only for actions the process actually consumes.
9. Declare deterministic artifact paths before writing them.
10. Validate exact references, portable paths, and platform assumptions.

## Validation

Validate one Recipe:

```bash
node skills/actors/scripts/validate-recipe.mjs path/to/recipe.json --qa
```

Validate all maintained Skill Recipes:

```bash
node skills/actors/scripts/validate-recipe.mjs skills --skills --qa --summary
```

Validation checks file size, filename identity, JSON/Markdown compilation, argument contracts, imports, cycles and depth, runtime origins, Control, artifacts, portable paths, helper targets, and platform notes. Recipe files larger than 1 MiB and import graphs deeper than 32 levels fail closed.

## Related

- [Command templates](./command-templates.md)
- [Runs](./async-runs.md)
- [Recipe library](./recipe-library.md)
- [Tool registry](./tool-registry.md)
