---
name: agent-native-ux-delivery
description: Preserve the 0.47.0 pi-actors agent routing, Skill protocols, persistent-tool authoring, and diagnostic UX contract.
title: Agent-Native Actor UX Delivery
status: stable
fss: true
---

# Agent-Native Actor UX Delivery

Canonical open work: ../../../BACKLOG.md

## Mission and Scope

Preserve the `0.47.0` agent-native boundary: a routing-first injected prompt, `actors` as the generic operating protocol, capability Skills as task owners, explicit `register_tool from/defaults`, focused Inspect diagnosis, and safe stop behavior. Do not widen the Run kernel or solve agent confusion with copied Recipes, shell recovery, another Skill layer, or human-doc dependencies.

## Truth Owners

- `BACKLOG.md` owns remaining `AUX-*` work, dependency order, acceptance journeys, and negative scope.
- `lib/prompts.ts` and prompt tests own injected routing semantics.
- `skills/actors/` owns generic agent operation; capability Skill directories own capability-specific choice; `skills/swarm/` owns multi-actor methodology.
- `lib/tools-register.ts`, `lib/registry.ts`, and `lib/tools-inspect.ts` own public authoring and diagnosis behavior.
- `tests/registration-truth.test.ts` and installed-package tests preserve the `0.46.1` mechanical floor.
- `tests/agent-journeys.test.ts` owns deterministic Journeys A-G; `.agents/evidence/agent-journey-b.md` owns reviewed fresh-agent release-candidate evidence.
- `README.md` and `docs/` remain human-facing; `AGENTS.md` remains implementation protocol.

## Operating Protocol

1. Honor the repository FSS opt-out before using or changing this skill.
2. Select only dependency-ready `AUX-*` work from `BACKLOG.md`.
3. Preserve the `0.46.1` resolution, admission, activation, rollback, and launch-kind truth; prose never compensates for runtime disagreement.
4. Keep one authority per concern: prompt routes, `actors` teaches mechanics, owning Skills teach capability choice, and `swarm` teaches methodology.
5. Make the common maintained-Recipe specialization path shorter without creating Recipe grammar aliases or copying inherited contracts.
6. Falsify each agent-facing contract with focused semantic tests, then prove source/installed parity at the backlog-prescribed boundary.
7. Reconcile completed items out of `BACKLOG.md`; keep implementation chronology out of shipped Skills and release narrative.

## Knowledge Routing

- Read `references/ux-debt-map.md` when selecting prompt, Skill, registration, Inspect, or error-UX work.
- Read `tests/registration-truth.test.ts` before changing persistent Recipe specialization or activation claims.
- Read `skills/actors/SKILL.md` plus the affected capability Skill before changing agent instructions.
- Read `.agents/skills/domain-dag/SKILL.md` when implementation ownership or dependency direction changes.
- Read human docs only when their independent human contract changes; never use them as the normal agent execution path.

## Evidence and Gates

- A Skill Recipe is never presented as a registered tool; spawn is never presented as tool invocation; persistence is never presented as callability.
- `register_tool from` must reuse authoritative effective admission and persist compact direct delegation.
- Focused diagnosis stays under existing `recipes` and `tool:<name>` targets.
- No bypass may introduce copied args/defaults/Control/artifacts, hard-coded `{skill_dir}`, direct bundled helpers, `bash -lc`, `eval`, or shell backgrounding.
- Fresh-agent and installed-package evidence must not rely on repository source, README, docs, or helper inspection.
- Stop at publication, credentials, external account changes, or any runtime contradiction named by `BACKLOG.md`.

## Evolution and Apoptosis

Refine this skill only for recurring authority, sequencing, evidence, or failure routes unique to agent-native UX delivery. Set it stable after `0.47.0` ships with no UX backlog and durable owners can support representative work directly. Apoptose only when no unique route or gate remains and discovery links can be removed atomically.
