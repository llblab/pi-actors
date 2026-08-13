# Actor Inspector

Open the live owner-filtered Run browser with:

```text
/actor-inspector
```

The Inspector follows the kernel directly. It shows Runs owned by the current Pi session and offers exactly three tabs.

## Recipe

Shows captured execution provenance:

- file-derived Recipe stem and logical reference;
- source kind (`user_registry_capability`, `active_skill_component`, or `explicit_file_recipe`) and Skill identity when owned;
- resolved template and values;
- root/import roles plus alias ancestry;
- declared artifacts and actor-local actions;
- model/thinking policy and launch source.

Captured Recipe evidence belongs to the Run generation and does not change when an active Recipe file later changes. Skill components display logical identities such as `artifacts/report`; private physical `source_file`, `skill_dir`, and `recipe_dir` stay out of Inspector and model-facing views. Non-empty object values render as indented brace-delimited property lists rather than flattened inline strings.

## Trace

Shows the unified bounded Trace projection. Sources include lifecycle/runtime observations, Controls, owned Pi turns, command-log tails, results, artifacts, and diagnostics. Filter by source and open a row for structured detail.

Trace ordering stays deterministic and newest-first: timestamp descending, same-source physical ordinal descending, fixed internal source rank, then stable id. Internal ordinals are never displayed or interpreted as cross-source causality. Row numbers still read chronologically from bottom to top: the oldest visible event is `#1` and the newest carries the highest number. The summary states whether retained history is complete; `runtime.trace_compacted` means older history was discarded and shows bounded cumulative drop evidence. Terminal/result/execution/artifact evidence keeps its own authority. The projection applies path containment and redaction before rendering.

## Control

Shows:

- Recipe-declared actor-local actions;
- runtime-owned lifecycle actions;
- generation-fenced endpoint readiness;
- pending capacity, saturation, journal bytes, stale count, and diagnostics;
- recent durable Control records and outcomes.

A service endpoint counts as ready only when `control-endpoint.json` matches the Run's immutable `run_instance_id`. Capacity reaches zero at 64 pending Controls; further requests are rejected before admission, while admitted nonterminal Controls never expire automatically. Runtime-owned kill remains available for a stuck saturated Run. Recent Control input and errors use the same bounded structured redaction as tool inspection. The durable `controls.jsonl` journal remains raw and local; rendering never mutates it or attaches an unredacted copy.

## Keys

The footer displays current bindings. Use tab navigation to switch Recipe/Trace/Control, movement keys to select rows, detail navigation to inspect evidence, refresh to reconcile disk state, and the documented kill key for lifecycle termination.

Run kill revalidates owner and generation through the canonical lifecycle path. After success, the Run status header is the sole confirmation; the content area does not duplicate it. The Inspector never edits state directly and never derives authority from displayed data.

## Scope

The Actor Inspector treats each Run as a concrete actor instance. It does not expose group conversations, peer addresses, routing, or communication topology. Use `inspect target=runtime view=status`, `inspect target=recipes view=status`, and `inspect target=tool:<name> view=status` for non-Run management targets.
