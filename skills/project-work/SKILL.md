---
name: project-work
description: Use for repository health inspection, project summaries, documentation maintenance, release-readiness evidence, or bounded run-operation reports.
---

# Project Work

Use this Skill to produce bounded project evidence and plans. For generic Recipe execution, Run lifecycle, persistence, or multi-actor methodology, follow `actors` and, when applicable, `swarm`; this Skill only selects project workflows.

## Choose the primary workflow

| Intended result | Recipe | Boundary |
| --- | --- | --- |
| Repository status, recent history, docs surface, validation, and risks | `project-work/repo-health` | Runs the caller-supplied trusted validation command |
| Documentation consistency review and maintenance plan | `project-work/docs-maintenance` | Evidence and plan only; does not edit documentation |
| Multi-lens release verdict with blockers and degraded-confidence evidence | `project-work/release-readiness` | Readiness only; does not publish |
| Evidence-only release summary and PR-body draft | `project-work/release-summary` | No commit, PR, merge, tag, publish, or external release action |
| Bounded report over existing actor Run state | `project-work/run-ops` | Read-only report; does not send Control or mutate Runs |

Choose `release-readiness` when independent review and a release verdict are needed. Choose `release-summary` when the evidence is already sufficient and only a concise operator-gated summary is wanted. If one primary workflow should become a recurring named tool, use the persistent-capability workflow in `actors`; do not copy its composition.

## Inputs and evidence

- Scope every workflow to the caller-selected repository, docs directory, or Run state.
- Treat `validation_command` as trusted executable input. Do not invent or broaden it.
- Select current model policy explicitly for workflows that request a model; release-readiness reviewer roles inherit only the values supplied by the caller.
- Artifact paths identify intended report targets. Confirm actual declared artifact evidence before claiming a durable file.
- Preserve degraded or insufficient review status. Never turn partial reviewer output into consensus.
- Release outputs are evidence, not publication authority.

## Supporting Recipes

`git-status`, `git-log`, `changelog-head`, `changelog-section`, `markdown-index`, `package-summary`, and `skill-summary` support the primary workflows. Use one directly only when its narrow deterministic output is the requested result; otherwise start from a primary workflow and avoid rebuilding its composition manually.

## Stop rules

Stop when repository scope, version, validation command, model policy, or write target is ambiguous. Do not edit docs from a `docs-maintenance` plan, publish from release evidence, or send Run Controls from `run-ops`. Hand those operations to their owning protocol after explicit authorization.
