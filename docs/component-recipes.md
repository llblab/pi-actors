# Component Recipes

Component recipes are small saved recipe definitions that expose one coordination capability each. They are the construction kit for higher-level subagent coordinators: a coordinator composes components instead of embedding one large orchestration DSL.

## Boundary

This is a weak abstract contract, not a hard dependency model.

- `pi-auto-tools` may provide local component recipe examples and runtime bindings.
- Portable coordination skills should target capabilities, not this extension by name.
- Local adapters bind abstract components to concrete recipes, command templates, async runs, model aliases, files, and tool registries.
- A component should be replaceable by another implementation with the same capability contract.

## Component Contract

Every reusable component recipe should make the following clear:

- **Capability**: the one operation it performs.
- **Args**: caller-controlled prompts, scopes, paths, models, and policy knobs.
- **Output**: the expected shape of stdout or artifact paths.
- **Events**: optional outbox events for checkpoints, questions, progress, or findings.
- **Failure policy**: whether failures stop the root, only fail a branch, or are recoverable.
- **Non-goals**: coordination behavior the component intentionally does not own.

Keep components narrow. Higher-level recipes should own composition, not hidden behavior inside a leaf.

## Spectrum of Components

### Launchers

Start one subagent or branch with a caller-provided prompt and model. Launchers do not judge or merge output.

Example: `examples/recipes/subagent-prompt.json`.

### Reviewers

Inspect a scope through a declared lens and return evidence-grounded findings.

Seed example: `examples/recipes/subagent-review.json`.

### Critics

Attack assumptions, edge cases, and failure modes. Critics should not rewrite the plan unless asked.

### Verifiers

Check a claim, artifact, or proposed result against evidence. Verifiers should separate proven, disproven, and unknown.

Seed example: `examples/recipes/subagent-verify.json`.

### Mergers

Combine multiple branch outputs into a single synthesis. Mergers preserve minority findings and mark unsupported additions.

Seed example: `examples/recipes/subagent-merge.json`.

### Normalizers

Convert variable branch output into stable JSON, Markdown sections, file artifacts, or event records for downstream recipes.

Seed example: `examples/recipes/subagent-normalize.json`.

### Quorum Operators

Run the same task across several independent models or instances and preserve vote shape for a later merger.

Seed example: `examples/recipes/subagent-quorum.json`.

### Checkpoint Emitters

Emit bounded coordinator questions, partial state, or branch decisions to the run outbox. Checkpoint components should not pretend same-context resume exists unless the adapter can prove it.

Seed example: `examples/recipes/subagent-checkpoint.json`.

### Follow-up Continuations

Resume or continue a branch with a bounded reply. If same-context continuation is unavailable, the component must declare a degraded mode such as creating a new branch with the checkpoint artifact included.

Seed example: `examples/recipes/subagent-followup.json`.

### Judges

Evaluate report quality, evidence preservation, severity calibration, consensus purity, and internal consistency. Judges should not silently become another domain reviewer.

## Composition Shape

A coordinator recipe can stay small by composing components:

```text
launch/review fanout → verify claims → merge → judge → final synthesis
```

Seed example: `examples/recipes/subagent-review-coordinator.json` composes reviewer fanout, verification, merge, and normalization.

For high-risk work, split breadth and confidence:

```text
lens swarm → quorum per lens → merger → post-merge judge
```

For implementation work, combine coordination with local ownership policy:

```text
task cards → scoped branch agents → conflict reports → integrator merge → review
```

## Design Rules

- Prefer public args/defaults over baked-in local policy.
- Use `failure: "branch"` for independent fanout branches unless one failure invalidates the whole run.
- Keep model pools and provider aliases configurable.
- Use artifacts or outbox events for intermediate outputs that must survive compaction.
- Do not hide broad coordinator behavior inside a component named like a leaf.
- Do not introduce scheduler, goto, or workflow-only syntax; compose saved recipes and command templates.
