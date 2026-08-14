---
name: registration-truth-delivery
description: Preserve one live Recipe resolution and admission contract across registration, registry, schema, activation, and Inspect surfaces.
title: Registration Truth Delivery
status: draft
fss: true
---

# Registration Truth Delivery

Canonical open work: ../../../BACKLOG.md

## Mission and Scope

Deliver the `0.46.1` registration-truth repair without copying delegated Recipe contracts or widening the public Run model. Support only the session resolution, user Recipe admission, registry reconciliation, schema ownership, Skill inventory, activation, launch-kind, and report-regression loop.

## Truth Owners

- `BACKLOG.md` owns remaining work, ordering, acceptance criteria, and negative scope.
- `AGENTS.md` owns durable Recipe, registry, safety, architecture, and release invariants.
- `lib/extension-runtime.ts`, `lib/recipes-references.ts`, `lib/recipes-discovery.ts`, `lib/runtime.ts`, and `lib/registry.ts` own runtime behavior.
- `tests/registration-truth.test.ts` owns the portable reported-journey regression.
- `docs/template-recipes.md` and `skills/actors/SKILL.md` own human and agent guidance when runtime truth changes.

## Operating Protocol

1. Honor the repository FSS opt-out before loading or changing this skill.
2. Select only eligible `RGT-*` work from `BACKLOG.md` and preserve its dependency order.
3. Keep one immutable session resolution context explicit at every live consumer before unifying admission or activation behavior.
4. Resolve and validate the effective delegated contract before persistence or host mutation.
5. Preserve exact resolution when Skill inventory is partial; diagnostics must not become resolver authority.
6. Prove each boundary with focused tests, then run the smallest shared registry/resolution validation.
7. Reconcile completed work out of `BACKLOG.md`; route release outcomes to `CHANGELOG.md` only when they become user-meaningful.

## Knowledge Routing

- Read `tests/registration-truth.test.ts` before changing the reported journey or registration semantics.
- Read `AGENTS.md` Control, Registry and Evolution, and Retained Safety Invariants before touching admission or mutation.
- Read `.agents/skills/domain-dag/SKILL.md` for architecture-affecting ownership changes.
- Read `docs/template-recipes.md` and `skills/actors/SKILL.md` only when maintained behavior or guidance changes.

## Evidence and Gates

- Focused evidence must distinguish exact Skill resolution, catalog inventory, user registry admission, public registration, host activation, schema projection, and tool versus spawn launch kind.
- Preserve path/CAS/symlink safety, immutable Run capture, session isolation, rollback, and source/installed parity.
- Same-session callability may be claimed only from real Pi host integration evidence.
- Stop at any approval, publication, concurrent-edit rollback, global mutable context, or copied-contract requirement named by `BACKLOG.md`.

## Evolution and Apoptosis

Refine this skill only when delivery exposes a recurring registration-truth route, gate, or failure distinction not already owned by the host. Set it stable after `0.46.1` leaves no delivery backlog and durable guidance has canonical owners. Apoptose only when host instructions, tests, and docs make representative registration work self-sufficient with no unique rule or route remaining.
