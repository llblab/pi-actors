---
name: artifacts
description: Deterministic artifact writing, reporting, manifests, and bundles for reusable actor workflows.
---

# Artifacts

Own reusable capabilities that turn bounded input or prior command output into declared files, reports, manifests, and artifact bundles.

## Scope

- Write or assemble caller-declared artifacts with explicit paths and overwrite policy.
- Produce bounded human-readable reports and machine-readable manifests.
- Compose validation evidence into artifact outputs without owning the validation policy.

This Skill does not own repository workflow, multi-agent review methodology, Run lifecycle, retention policy, or transport delivery. Its Recipe identity is `artifacts/<filename stem>`; Recipe files have no top-level `name`. Cross-capability composition uses exact `<skill>/<recipe>` references; helper-backed Recipes use only this Skill's `scripts/` through `{skill_dir}`.
