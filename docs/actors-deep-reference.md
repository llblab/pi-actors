# Actors Deep Reference

## Kernel

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

- Recipe owns executable definition and declared actor-local actions.
- Run owns one generation of execution and evidence.
- Trace owns observations.
- Control owns actor-local inputs.

`register_tool` persists capabilities but does not participate in running Control.

## Choosing Execution

Use a foreground tool for short work with one natural response. Use a Run when execution may outlive the turn, needs later inspection or steering, produces artifacts, runs as a service, or coordinates repeated/parallel command-template cells.

Do not background shell processes outside the Run lifecycle.

## Recipe Resolution

Active user Recipes shadow packaged Recipes by name. Invalid active shadowing fails with both active and blocked fallback paths instead of silently executing another definition. Imports resolve under Recipe-root priority, enforce a 1 MiB file limit and depth limit 32, reject cycles, and act as local definitions inside one Run.

Current model/thinking placeholders resolve from Pi context before launch and persist provenance in `run.json`.

## Command Templates

String leaves execute without shell parsing. Arrays sequence commands. Objects add `parallel`, `concurrency`, `min_successful`, `when`, `timeout`, `delay`, `retry`, `failure`, `recover`, `repeat`, `accept_output`, and `output` behavior.

Placeholders support typed args, defaults, fallback, and conditional expansion. Prefer explicit scripts when shell semantics or a maintained service loop matters.

## Control Discipline

Public shape:

```json
{"target":"run:<id>","action":"action","input":{},"verbose":false}
```

Recipe actions use lowercase stable names. Do not declare runtime-reserved lifecycle actions. Inputs must remain bounded JSON. A controlled service publishes readiness only after its consumer can read the endpoint and includes its immutable generation id.

Controls persist before transport and keep durable outcome evidence. Never infer owner identity from caller-provided input.

## Trace Discipline

Trace events use stable `kind` names and concise summaries. Put structured bounded evidence in `data`; put large evidence in artifacts. Use attention sparingly:

- omitted/`log`: inspectable only;
- `notify`: visible status;
- `followup`: semantic coordinator follow-up.

Trace has no address or response semantics.

## Lifecycle Discipline

Retain these invariants:

- owner filtering;
- immutable generation fencing;
- process identity verification;
- canonical lifecycle locks;
- shutdown and parent-teardown kill;
- terminal notification reconciliation;
- bounded logs and complete captures;
- owned Pi session provenance;
- path containment and redaction;
- review retry/reset safety.

A lifecycle operation that cannot prove identity or ownership fails closed.

## Operating Patterns

### One-shot pipeline

Spawn the Recipe, wait for terminal follow-up when needed, inspect Trace/result/artifacts, and validate outputs. Do not send Controls the process does not implement.

### Controlled service

Spawn, inspect `view=control` for endpoint readiness, send only declared actions, inspect Trace for outcomes, then use the declared actor-local stop action or runtime lifecycle termination as appropriate.

### Parallel review

Use maintained review Recipes with explicit model/thinking and bounded concurrency. Preflight provider/model policy before fanout. Keep reviewer artifacts immutable and run merge/judge stages only after required evidence succeeds.

### Resource locking

Use `resource-locker` only when methodology needs lease-backed resource exclusion. Include owner/resource identity in Control input and treat lock Trace as coordination evidence, not kernel authority.

## Diagnostics

- `inspect target=runtime` for failed Runs, stale Controls, and attention Trace.
- `inspect target=recipes` for active/shadowed/invalid Recipe state.
- `inspect target=tool:<name>` for registered capability schema.
- `inspect target=run:<id> view=recipe|trace|control` for generation evidence.
- `/actor-inspector` for owner-filtered actor-instance navigation.

Avoid repeated polling. Deferred terminal results arrive as Pi follow-ups.

## Related

- [Runs](./async-runs.md)
- [Recipe library](./recipe-library.md)
- [Command templates](./command-templates.md)
- [Template Recipes](./template-recipes.md)
- [Actor Inspector](./actor-inspector.md)
