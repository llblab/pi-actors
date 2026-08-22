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

Captured Recipe evidence belongs to the Run generation and does not change when an active Recipe file later changes. Skill components display logical identities such as `artifacts/report`; private physical `source_file`, `skill_dir`, and `recipe_dir` stay out of Inspector and model-facing views. Non-empty objects render as indented brace-delimited property lists. Complex arrays use compact zero-based entries such as `#0: {` rather than Markdown list markers.

## Trace

Shows the unified bounded Trace projection. Sources include lifecycle/runtime observations, Controls, owned Pi turns, command-log tails, results, artifacts, and diagnostics. The source selector displays only `all` plus sources present in the current projection from `lifecycle`, `control`, `process`, `agent`, `artifact`, and `runtime`. Select a row to open structured detail.

Trace ordering stays deterministic and newest-first: timestamp descending, same-source physical ordinal descending, fixed internal source rank, then stable id. Internal ordinals are never displayed or interpreted as cross-source causality. Row numbers are zero-based chronological identities even though display is newest-first: the oldest visible event is `#0` and the newest carries the highest number. The summary states whether retained history is complete; `runtime.trace_compacted` means older history was discarded and shows bounded cumulative drop evidence. Terminal/result/execution/artifact evidence keeps its own authority. The projection applies path containment and redaction before rendering.

## Control

Shows:

- Recipe-declared actor-local actions;
- runtime-owned lifecycle actions;
- generation-fenced endpoint readiness;
- pending capacity, saturation, journal bytes, stale count, and diagnostics;
- recent durable Control records and outcomes.

A service endpoint counts as ready only when `control-endpoint.json` matches the Run's immutable `run_instance_id`. Capacity reaches zero at 64 pending Controls; further requests are rejected before admission, while admitted nonterminal Controls never expire automatically. Runtime-owned kill remains available for a stuck saturated Run. Recent Control input and errors use the same bounded structured redaction as tool inspection. The durable `controls.jsonl` journal remains raw and local; rendering never mutates it or attaches an unredacted copy.

## Focus and Selectors

`selectedBg` marks the current focus or selection; `customMessageBg` remains reserved for alternating content stripes. Opening the Run or Trace-source selector preserves `selectedBg` on its parent control, so focus reads as parent → child menu → selected option. Menus are composited over only their bounded rectangle; base content before, beside, and below that rectangle remains rendered.

The Run selector uses aligned zero-based sequence, Run name, and semantic status columns. The Trace selector uses `Trace: <source>`; when a non-`all` source is active, the tab projects the same colon grammar and value color.

## Keys

The footer is authoritative for the current focus. The stable navigation contract is:

| Focus | Keys |
| --- | --- |
| Run control | `←`/`→` change Run, `↓` enters tabs, `Enter` opens the Run selector, `k` requests kill when available |
| Tabs | `←`/`→` or `Tab` changes tab, `↑` returns to Run, `↓` enters content, `Enter` opens content or the Trace-source selector |
| Trace tab | `f` cycles present sources without opening the selector |
| List/document/detail | `↑`/`↓` and `PgUp`/`PgDn` navigate; `→`/`Enter` opens a Trace row; `←` or `Esc` moves back |
| Selector | `↑`/`↓` chooses, `Enter`/`→` applies, `←`/`Esc` cancels |
| Kill confirmation | `←`/`→` or `Tab` chooses, `Enter`/`y` confirms, `Esc`/`n` cancels |
| Overlay | `Esc` closes from the top level; `Ctrl-C` closes immediately |

Run kill revalidates owner and generation through the canonical lifecycle path. After success, the Run status header is the sole confirmation; the content area does not duplicate it. The Inspector never edits state directly and never derives authority from displayed data.

## Scope

The Actor Inspector treats each Run as a concrete actor instance. It does not expose group conversations, peer addresses, routing, or communication topology. Use `inspect target=runtime view=status|runs|triage`, `inspect target=recipes view=status|summary|doctor|imports|reviews`, and `inspect target=tool:<name> view=status|schema` for non-Run management targets. See [Management Inspection](./inspection.md) for exact applicability and authorization boundaries.
