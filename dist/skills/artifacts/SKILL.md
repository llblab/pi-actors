---
name: artifacts
description: Use when an actor workflow must write reusable files, reports, manifests, or bundles with deterministic paths and declared outputs.
---

# Artifacts

Use this Skill after the desired durable-output outcome is known. For generic Recipe execution, Runs, persistence, or diagnosis, follow `actors`; this Skill only selects artifact behavior.

## Choose the outcome

| Desired outcome | Recipe | Result |
| --- | --- | --- |
| Write one generated artifact and a machine-readable manifest, with optional validation first | `artifacts/bundle` | Primary artifact plus manifest |
| Generate bounded normalized report content without committing a filesystem write | `artifacts/report` | Report content for review or later composition |
| Generate and write one artifact | `artifacts/write` | Declared artifact path written with explicit mode |
| Describe one existing or intended artifact | `artifacts/manifest` | Manifest JSON on stdout; no write |
| Write prior pipeline output exactly | `artifacts/file-write` | Supporting stdin-to-file write; normally use inside composition |

Prefer `bundle` when both durable content and inventory evidence are required. Prefer `write` for one accepted file. Use `report` while content still needs review. Do not use `file-write` as a content generator. If one selected outcome should become a recurring named tool, use the persistent-capability workflow in `actors`; do not copy its graph.

## Inputs and boundaries

- Keep `input` bounded and evidence-based; choose the current model explicitly where the Recipe requires `model`.
- Supply caller-owned `artifact_path` and, for `bundle`, a distinct `manifest_path`.
- `write_mode=create` is the safe default and stops if the target exists. Use `overwrite` or `append` only when the requested mutation is explicit.
- Parent directories are created by the writer. `~` is resolved for artifact paths.
- `manifest` reports existence, size, and modification evidence; it does not validate artifact meaning.
- Validation in `bundle` runs only when `run_validation=true` and uses the caller-supplied trusted command and scope.

## Stop rules

Stop rather than guessing when the target path, overwrite policy, accepted content, model, or validation command is unclear. Do not claim a durable artifact from `report` or `manifest` alone. After a Run starts, use the `actors` evidence and lifecycle protocol; this Skill does not redefine it.
