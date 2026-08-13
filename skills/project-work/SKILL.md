---
name: project-work
description: Repository inspection, documentation maintenance, release preparation, and project health workflows.
---

# Project Work

Own reusable workflows for inspecting and maintaining software projects.

## Scope

- Summarize Git, package, Skill, changelog, and documentation state.
- Compose repository health, documentation maintenance, and release-readiness evidence.
- Keep project-level orchestration separate from lower-level artifact and actor utilities.

This Skill does not own the Run kernel, publication authority, multi-agent methodology, or artifact-writing mechanics. Its Recipe identity is `project-work/<filename stem>`; Recipe files have no top-level `name`. It composes other capabilities only through exact `<skill>/<recipe>` references and keeps project-specific helper behavior under its own `scripts/` directory.
