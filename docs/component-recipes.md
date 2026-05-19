# Component Recipes

Component recipes are small saved recipe definitions that expose one coordination capability each. They are the construction kit for higher-level subagent coordinators: a coordinator composes components instead of embedding one large orchestration DSL.

## Boundary

This is a weak abstract contract, not a hard dependency model.

- `pi-auto-tools` provides root `recipes/` component definitions and runtime bindings.
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

Reusable components should expose common policy knobs instead of baking in local choices: `model`, `thinking`, `tool_args`, `output_format`, `evidence_policy`, `risk_policy`, source policy, continuity/resume policy, handoff format, merge mode, model pools, and stage-specific models. Higher-level recipes may pass these knobs through so the same component can run as a safe no-tools reviewer, a file-reading reviewer, a release gate, a research synthesizer, a task-card author, or a high-thinking merger.

Keep components narrow. Higher-level recipes should own composition, not hidden behavior inside a leaf.

## Spectrum of Components

### Launchers

Start one subagent or branch with a caller-provided prompt and model. Launchers do not judge or merge output.

Example: `recipes/subagent-prompt.json`.

### Reviewers

Inspect a scope through a declared lens and return evidence-grounded findings.

Seed example: `recipes/subagent-review.json`.

### Critics

Attack assumptions, edge cases, and failure modes. Critics should not rewrite the plan unless asked.

Seed example: `recipes/subagent-critic.json`.

### Planners

Turn a goal into bounded slices, validation gates, risks, and stop conditions.

Seed example: `recipes/subagent-plan.json`.

### Verifiers

Check a claim, artifact, or proposed result against evidence. Verifiers should separate proven, disproven, and unknown.

Seed example: `recipes/subagent-verify.json`.

### Evidence and Contradiction Mappers

Map source support, weak evidence, contradictions, unresolved assumptions, and missing source classes before synthesis.

Seed examples: `recipes/subagent-evidence-map.json` and `recipes/subagent-contradiction-map.json`.

### Mergers

Combine multiple branch outputs into a single synthesis. Mergers preserve minority findings and mark unsupported additions.

Seed example: `recipes/subagent-merge.json`.

### Normalizers, Artifacts, and Events

Convert variable branch output into stable JSON, Markdown sections, file artifacts, or event records for downstream recipes.

Seed examples: `recipes/subagent-normalize.json`, `recipes/subagent-artifact.json`, and `recipes/subagent-event.json`.

### Quorum Operators

Run the same task across several independent models or instances and preserve vote shape for a later merger.

Seed example: `recipes/subagent-quorum.json`.

### Tasking and Conflict Handoffs

Produce bounded task cards or conflict reports for development swarms and integrator workflows.

Seed examples: `recipes/subagent-task-card.json` and `recipes/subagent-conflict-report.json`.

### Checkpoint Emitters

Emit bounded coordinator questions, partial state, or branch decisions to the run outbox. Checkpoint components should not pretend same-context resume exists unless the adapter can prove it.

Seed example: `recipes/subagent-checkpoint.json`.

### Follow-up Continuations

Resume or continue a branch with a bounded reply. If same-context continuation is unavailable, the component must declare a degraded mode such as creating a new branch with the checkpoint artifact included.

Seed example: `recipes/subagent-followup.json`.

### Judges

Evaluate report quality, evidence preservation, severity calibration, consensus purity, and internal consistency. Judges should not silently become another domain reviewer.

Seed example: `recipes/subagent-judge.json`.

## Composition Shape

A coordinator recipe can stay small by composing components:

```text
launch/review fanout → verify claims → merge → judge → final synthesis
```

Seed example: `recipes/subagent-review-coordinator.json` composes reviewer fanout, verification, merge, judge, and normalization.

Higher-level examples:

- `recipes/pipeline-review-readiness.json`: Release/readiness gate over selected lenses.
- `recipes/pipeline-quorum-review.json`: Same prompt across a model pool, then merge, judge, and normalize vote shape.
- `recipes/pipeline-architect-coordinator.json`: Architecture direction synthesis with lens fanout, critique, verification, merge, and next-slice output.
- `recipes/pipeline-research-synthesis.json`: Plan, evidence map, contradiction map, verification, merge, and normalized research synthesis.
- `recipes/pipeline-checkpoint-continuation.json`: Checkpoint artifact, follow-up continuation, and normalized handoff with explicit degraded-mode handling.
- `recipes/pipeline-development-tasking.json`: Plan, task card, critique, and normalized integrator handoff for bounded implementation work.
- `recipes/pipeline-artifact-report.json`: Normalized report → durable artifact-shaped output → outbox-event-shaped record.

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
