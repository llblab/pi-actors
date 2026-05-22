# Task-First Recipe Design

Task-first recipe design starts from a high-level operator or coordinator task, then derives the component cells, utility recipes, helper scripts, and runtime semantics needed to make that task reusable.

This complements atom-first growth. Atom-first asks: "What small capability can we expose?" Task-first asks: "What complete work pattern should an agent/operator be able to invoke, and which atoms must exist to support it?"

## Method

For each high-level recipe candidate:

1. Name the task in operator language.
2. Define the trigger and expected output artifact.
3. Sketch the recipe pipeline at the highest useful abstraction.
4. Identify missing component cells.
5. Decide which cells are subagent components, local utilities, or helper-backed transforms.
6. Keep domain policy knobs public: models, tools, paths, evidence/risk policy, output shape, mailbox contract, and validation gates.
7. Add only the next smallest recipe/helper slice that validates the design.

## High-Level Recipe Cells

### Release Readiness Cell

Purpose: decide whether a repo/package is ready for release.

Pipeline:

```text
scope snapshot → changelog/package check → release lens reviews → risk verifier → readiness report → release checklist artifact
```

Likely needed cells:

- Package metadata reader
- Changelog section extractor
- Package contents summarizer
- Validation command wrapper
- Release-risk reviewer
- Readiness merger/judge
- Release checklist artifact writer

Existing seeds:

- `utility-changelog-section`
- `utility-package-summary`
- `utility-validation-wrapper`
- `pipeline-review-readiness`
- `subagent-judge`
- `subagent-artifact`

Implemented seed:

- `pipeline-release-readiness`: changelog section → package summary → packaged skill summary → validation wrapper → release review coordinator → artifact report.

### Repository Health Cell

Purpose: summarize repo state for the next coordinator turn or release prep.

Pipeline:

```text
git status/log → package/docs/backlog snapshot → validation summary → health report → next action recommendation
```

Likely needed cells:

- Git status/log utility
- Package version reader
- Backlog open/blocked extractor
- Docs index checker
- Validation summary normalizer
- Next-action recommender

Existing seeds:

- `utility-markdown-index`
- `utility-validation-wrapper`
- `subagent-normalize`
- `subagent-plan`

Implemented seed:

- `pipeline-repo-health`: git status/log → docs index → validation wrapper → normalized artifact report.

### Async Run Operations Cell

Purpose: inspect, summarize, and decide actions for local async runs.

Pipeline:

```text
run-state summary → actor-message tail → stale/active classification → recommended action → optional stop/control message
```

Likely needed cells:

- Run summary helper
- JSONL actor-message tailer
- Stale-run classifier
- Control-message recommender
- Run report artifact

Existing seeds:

- `utility-run-summary`
- `utility-jsonl-tail`
- `subagent-message`
- `pipeline-artifact-report`

Implemented seed:

- `pipeline-async-run-ops`: structured run operations snapshot → normalized operations report → artifact report. The snapshot combines run summary, actor-message tail, and recommended inspect/control messages before the LLM normalization step.

### Research Brief Cell

Purpose: turn a question and source set into a bounded evidence-backed brief.

Pipeline:

```text
question framing → evidence map → contradiction map → claim verification → synthesis → evidence gaps → next evidence slice
```

Likely needed cells:

- Question framer
- Source inventory utility
- Evidence mapper
- Contradiction mapper
- Verifier
- Synthesis merger
- Limitations normalizer

Existing seeds:

- `pipeline-research-synthesis`
- `subagent-evidence-map`
- `subagent-contradiction-map`
- `subagent-verify`

### Implementation Tasking Cell

Purpose: prepare bounded work for one or more implementation agents.

Pipeline:

```text
goal → mutation zones → task cards → validation gates → conflict risks → integrator handoff
```

Likely needed cells:

- Mutation-zone planner
- Task-card generator
- Ownership/conflict checker
- Validation-gate normalizer
- Integrator handoff artifact

Existing seeds:

- `pipeline-development-tasking`
- `subagent-task-card`
- `subagent-conflict-report`

### Documentation Maintenance Cell

Purpose: keep docs/index/readme surfaces coherent after changes.

Pipeline:

```text
doc file inventory → index diff → stale link/routing review → rewrite suggestion → docs maintenance artifact
```

Likely needed cells:

- Markdown index utility
- Link checker wrapper
- Docs consistency reviewer
- Docs update planner
- Docs artifact writer

Existing seeds:

- `utility-markdown-index`
- `subagent-review`
- `subagent-plan`
- `subagent-artifact`

Implemented seed:

- `pipeline-docs-maintenance`: docs index → documentation review → maintenance plan → artifact report.

### Media/Playlist Operations Cell

Purpose: convert local media directories into controllable playback workflows.

Pipeline:

```text
media scan → playlist build → playback start → message summary → controls
```

Likely needed cells:

- Playlist builder
- Music player
- Run/message summary
- Control recommender

Existing seeds:

- `utility-playlist-build`
- `music-player`
- `utility-run-summary`
- `utility-jsonl-tail`

Implemented seed:

- `pipeline-media-library`: playlist build → media-library artifact report.

## Selection Rule

Prefer adding a high-level recipe when at least three cells already exist and the missing cells are small. Prefer adding an atom when multiple high-level recipes need the same missing cell.

## Near-Term Candidates

Good next candidates for the standard library after the first task-first wave:

1. Package/release metadata enrichment: implemented in `pipeline-release-readiness` by adding `utility-package-summary` and `utility-skill-summary` between changelog extraction and validation, making release-readiness reports more evidence-rich without adding publish automation.
2. Evidence-only release summary: implemented as `pipeline-release-summary`, which composes changelog/package/skill/validation evidence into a release summary, risk checklist, and PR body draft artifact while leaving commit, PR, merge, tag, and publish actions to explicit release gates.
3. Artifact packaging and manifesting: implemented as `pipeline-artifact-bundle`, which composes optional validation, `pipeline-artifact-write`, `utility-artifact-manifest`, deterministic manifest writing, and an actor-message handoff when the caller explicitly requests filesystem writes.
4. Async run cleanup planning: extend async-run operations with stale-run classification and recommended `message`, `cancel`, or `kill` controls, keeping actual control execution operator-gated.

Each candidate should land with the minimum missing cells rather than a broad one-shot framework. Already implemented task-first seeds include `pipeline-release-readiness`, `pipeline-release-summary`, `pipeline-repo-health`, `pipeline-async-run-ops`, `pipeline-docs-maintenance`, `pipeline-media-library`, and `pipeline-artifact-bundle`.
