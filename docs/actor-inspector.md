# Actor Inspector

Open the live owner-filtered Run browser with:

```text
/actor-inspector
```

The Inspector follows the kernel directly. It shows Runs owned by the current Pi session and offers exactly three tabs.

## Recipe

Shows captured execution provenance:

- Recipe name and source path;
- resolved template and values;
- imports/context records;
- declared artifacts and actor-local actions;
- model/thinking policy and launch source.

Captured Recipe evidence belongs to the Run generation and does not change when an active Recipe file later changes.

## Trace

Shows the unified bounded Trace projection. Sources include lifecycle/runtime observations, Controls, owned Pi turns, command-log tails, results, artifacts, and diagnostics. Filter by source and open a row for structured detail.

Trace ordering stays deterministic and newest-first. The projection applies path containment and redaction before rendering.

## Control

Shows:

- Recipe-declared actor-local actions;
- runtime-owned lifecycle actions;
- generation-fenced endpoint readiness;
- recent durable Control records and outcomes.

A service endpoint counts as ready only when `control-endpoint.json` matches the Run's immutable `run_instance_id`.

## Keys

The footer displays current bindings. Use tab navigation to switch Recipe/Trace/Control, movement keys to select rows, detail navigation to inspect evidence, refresh to reconcile disk state, and the documented kill key for lifecycle termination.

Run kill revalidates owner and generation through the canonical lifecycle path. The Inspector never edits state directly and never derives authority from displayed data.

## Scope

The Actor Inspector treats each Run as a concrete actor instance. It does not expose group conversations, peer addresses, routing, or communication topology. Use `inspect target=runtime`, `inspect target=recipes`, and `inspect target=tool:<name>` for non-Run management targets.
