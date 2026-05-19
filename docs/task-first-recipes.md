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
6. Keep policy knobs public: models, tools, paths, evidence/risk policy, output shape, event delivery, and validation gates.
7. Add only the next smallest recipe/helper slice that validates the design.

## High-Level Recipe Cells

### Release Readiness Cell

Purpose: decide whether a repo/package is ready for release.

Pipeline:

```text
scope snapshot → changelog/package check → release lens reviews → risk verifier → readiness report → release checklist artifact
```

Likely needed cells:

- package metadata reader
- changelog section extractor
- package contents summarizer
- validation command wrapper
- release-risk reviewer
- readiness merger/judge
- release checklist artifact writer

Existing seeds:

- `utility-changelog-section`
- `utility-package-summary`
- `utility-validation-wrapper`
- `pipeline-review-readiness`
- `subagent-judge`
- `subagent-artifact`

Implemented seed:

- `pipeline-release-readiness`: changelog section → validation wrapper → release review coordinator → artifact report.

### Repository Health Cell

Purpose: summarize repo state for the next coordinator turn or release prep.

Pipeline:

```text
git status/log → package/docs/backlog snapshot → validation summary → health report → next action recommendation
```

Likely needed cells:

- git status/log utility
- package version reader
- backlog open/blocked extractor
- docs index checker
- validation summary normalizer
- next-action recommender

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
run-state summary → event tail → stale/active classification → recommended action → optional stop/control message
```

Likely needed cells:

- run summary helper
- JSONL event tailer
- stale-run classifier
- control-message recommender
- run report artifact

Existing seeds:

- `utility-run-summary`
- `utility-jsonl-tail`
- `subagent-event`
- `pipeline-artifact-report`

Implemented seed:

- `pipeline-async-run-ops`: run summary → event tail → normalized operations report → artifact report.

### Research Brief Cell

Purpose: turn a question and source set into a bounded evidence-backed brief.

Pipeline:

```text
question framing → evidence map → contradiction map → claim verification → synthesis → evidence gaps → next evidence slice
```

Likely needed cells:

- question framer
- source inventory utility
- evidence mapper
- contradiction mapper
- verifier
- synthesis merger
- limitations normalizer

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

- mutation-zone planner
- task-card generator
- ownership/conflict checker
- validation-gate normalizer
- integrator handoff artifact

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

- markdown index utility
- link checker wrapper
- docs consistency reviewer
- docs update planner
- docs artifact writer

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
media scan → playlist build → playback start → event summary → controls
```

Likely needed cells:

- playlist builder
- music player
- run/event summary
- control recommender

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

1. Package/release metadata enrichment: use `utility-package-summary` with changelog and validation cells to make release-readiness reports more evidence-rich without adding publish automation.
2. Artifact packaging and manifesting: compose `pipeline-artifact-write`, `utility-artifact-manifest`, artifact reports, and validation summaries into a machine-readable handoff bundle when the caller explicitly requests filesystem writes.
3. Async run cleanup planning: extend async-run operations with stale-run classification and recommended `message`, `cancel`, or `kill` controls, keeping actual control execution operator-gated.

Each candidate should land with the minimum missing cells rather than a broad one-shot framework. Already implemented task-first seeds include `pipeline-release-readiness`, `pipeline-repo-health`, `pipeline-async-run-ops`, `pipeline-docs-maintenance`, and `pipeline-media-library`.
