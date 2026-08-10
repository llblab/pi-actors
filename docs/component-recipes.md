# Component Recipes

Component Recipes are weakly coupled command-template cells used inside higher-level Recipes. They do not create a social protocol or become independently addressable peers.

## Contract

A useful component has:

- explicit typed inputs and caller-owned policy knobs;
- one narrow responsibility;
- deterministic output shape or declared artifact;
- bounded failure behavior;
- no hidden model/provider assumption;
- no actor-local Control unless it owns a real service loop.

## Families

- normalization and prompt shaping;
- planning and task-card generation;
- evidence maps, contradiction maps, and criticism;
- review, verification, merge, judge, and quorum stages;
- artifact generation, manifesting, and deterministic writes;
- validation and package/skill summaries.

## Composition

Import components by alias and call named nodes in a template array/object. Parent command-template flags own sequence, parallelism, concurrency, retries, failure scope, recovery, repetition, and output acceptance.

Variable branch output should converge into stable JSON, Markdown, artifacts, or command results before downstream stages. Large evidence belongs in artifacts or complete captures; concise milestones belong in Trace.

## Boundaries

- Imports are definitions inside one Run.
- One-shot components omit Control.
- Components never infer caller identity or lifecycle authority.
- A parent may declare artifacts that imported cells write.
- A child failure follows explicit parent failure/recovery policy.

Use the packaged Recipe library before creating a new component. Add one only when at least two stable compositions need the same narrow behavior.

## Related

- [Recipe library](./recipe-library.md)
- [Template Recipes](./template-recipes.md)
- [Command templates](./command-templates.md)
