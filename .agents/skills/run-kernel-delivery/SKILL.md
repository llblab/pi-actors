---
name: run-kernel-delivery
description: Supports evidence-driven closure of the pi-actors Run kernel across source, installed package, Inspector, controlled services, validation, and distribution.
title: Run Kernel Delivery
status: draft
fss: true
---

# Run Kernel Delivery

Canonical open work: ../../../BACKLOG.md

## Mission and Scope

Advance the existing `Recipe --spawn--> Run` kernel without expanding its public nouns, views, tools, or orchestration surface. Preserve the retained lifecycle, ownership, generation, process-identity, evidence, redaction, containment, review, and shell-free execution boundaries while closing verified source, package, documentation, CI, and distribution gaps.

## Truth Owners

- `../../../BACKLOG.md` owns active and gated delivery work.
- `../../../AGENTS.md` owns durable architecture and safety constraints.
- `../../../lib`, `../../../scripts`, and `../../../index.ts` own runtime behavior.
- `../../../tests` and `../../../scripts/release-gates.mjs` own executable evidence.
- `../../../README.md`, `../../../docs`, and packaged skills own user and agent guidance.
- `../../../CHANGELOG.md` owns completed release outcomes.

## Operating Protocol

1. Honor repository FSS settings before using or changing this symbiont.
2. Verify each backlog observation against the current checkout and released baseline before editing.
3. Fix the narrowest owning boundary, add the smallest regression that would have caught the gap, and preserve exact public contracts.
4. Rebuild `dist` after Inspector or runtime changes because Pi loads `dist/pi-actors`.
5. Run focused falsification first, then the proportional shared validation gate.
6. Remove completed work from the backlog, route meaningful outcomes to the changelog, and keep durable rules in project context rather than this skill.

## Knowledge Routing

- For Run lifecycle, Control, Trace, or evidence semantics, start with the matching `lib/runs-*` owner and `AGENTS.md` invariant.
- For Trace writes, use only `lib/runs-trace.ts`; validation and size checks belong inside its token-owned cross-process lock, and scripts load that authority through their installed/source runtime-module loader rather than appending `trace.jsonl`.
- For runtime identity or triage, keep package/schema authority in `lib/runtime-identity.ts`, pending/stale policy in the pure `lib/runtime-triage.ts` classifier, and owner filtering plus bounded aggregation in `lib/tools-inspect.ts`.
- For any model/TUI Control exposure, route the raw durable record through `lib/control-projection.ts`; preserve raw `controls.jsonl` only for local execution and never duplicate it into tool details.
- For Control admission, keep the 64-character action, 380-byte serialized input, and 512-byte complete wire limits in `lib/limits.ts`; normalize through `lib/control.ts`, validate Recipe declarations through `lib/recipe-control.ts`, and assert the complete wire in `lib/runs-control-delivery.ts` before journaling or either transport.
- For Actor Inspector behavior, inspect `lib/inspector*.ts`, `lib/trace-projection.ts`, and `tests/inspector-overlay.test.ts` together; preserve compact rendering, keyboard focus, cached navigation, generation-fenced actions, newest-first Trace with bottom-up chronological numbering, structured non-empty objects, plain markers, and non-duplicated kill feedback.
- For controlled services, inspect the canonical Run domains before self-contained scripts, require installed-package coverage, and preserve packaged helper self-location plus explicit caller override.
- For Recipe QA, treat `description` as optional fallback copy, keep structural failures as diagnostics, and require zero release-blocking warnings with concrete file-level repair evidence.
- For dogfood, keep one-shot, owned agent evidence, controlled service, replacement generation, runtime triage, and actual tarball checks in normal validation; keep the packed-candidate `/actor-inspector` pass explicit when no live terminal can prove it.
- For release and npm behavior, inspect committed workflows, package metadata, release gates, the exact tag tree, and registry state before external action.

## Evidence and Gates

- Every retained behavior change needs focused project-native regression evidence.
- TypeScript, build, package checks, strict Domain DAG, ABCd context, and release gates climb proportionally to the changed boundary; shipped lines stay strictly below the documented 28,853-line released tree.
- Source and `dist` must agree for shipped runtime surfaces.
- External publication remains approval-gated and follows reusable validation, immutable tag, npm Trusted Publisher publication and exact verification, then GitHub Release convergence.
- No task may weaken removed-surface gates or reintroduce communication-plane concepts under new names.

## Evolution and Apoptosis

Keep this symbiont `draft` while the canonical backlog contains Run-kernel closure work. Stabilize it only after ordinary maintenance can proceed from host-owned code, tests, docs, and release rules without reconstructing unique guidance. Apoptose only when host surfaces absorb every unique route and gate, no open work remains, and removal plus discovery repair can happen atomically with confidence of at least 0.9.
