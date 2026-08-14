# Development Swarms

Use this reference when two or more implementation participants can own disjoint mutation zones and one integrator can reconcile them. Keep generic actor execution and lifecycle behavior in `actors`.

## Admission test

Use a development swarm only when all are true:

- the accepted direction is stable enough to partition;
- each participant can receive a meaningful bounded scope;
- shared contracts have one named owner;
- work can be isolated from the shared target while in progress;
- one integrator owns merge order and final validation.

Do not parallelize implementation when tasks need the same central files, semantic ordering dominates wall-clock time, or the likely conflicts would invalidate the decomposition. Use planning or review first.

## Decompose by ownership

Prefer mutation-zone ownership over broad feature labels.

```text
behavior owner  → production behavior in one domain
test owner      → regressions and fixtures for that domain
docs owner      → affected agent/user contract
integrator      → shared contracts, merge, final checks
```

A participant may own both behavior and its tests when separating them would force synchronized edits. What matters is one owner per writable surface and an explicit integration edge.

## Task card

Every participant receives one task card before mutation:

```markdown
# Task Card

Goal:
Non-goals:
Allowed files or logical scope:
Avoided files or shared contracts:
Expected artifact or patch:
Required evidence:
Checks:
Escalate when:
Handoff destination:
```

A useful task card names the smallest scope that can independently reach a validation boundary. It does not ask a participant to "help with" a broad project area. Participants must restate scope before editing and record discovered out-of-scope work rather than performing it.

`swarm/development-tasking` can generate and critique one card when the goal, allowed scope, avoided scope, checks, model, and tools are already known.

## Write ownership

- Give each writable file or logical contract one owner.
- Treat schemas, public APIs, central configuration, migrations, and specifications as exclusive even when textual merges look easy.
- Parallel readers may inspect a stable shared target.
- Isolate concurrent mutation through the repository's existing branch/workspace mechanism.
- Use bounded lock evidence when ownership is not otherwise obvious. A lock records intent; it does not authorize scope expansion.
- Release ownership at terminal handoff or explicitly transfer it through the integrator.

If a participant discovers that another scope must change, it emits a dependency or conflict report and stops that edge. The coordinator either transfers ownership, serializes the work, or replans.

## Coordinator checkpoints

A checkpoint preserves useful local context while requesting one decision:

```markdown
# Coordinator Checkpoint

Task:
Current scope:
Question:
Why a coordinator decision is required:
Options and evidence:
Recommended option:
Risk if guessed:
State that must be preserved:
```

Use checkpoints for scope changes, product choices, shared-contract decisions, permissions, or conflict policy. The coordinator answers only the bounded question. If the participant cannot resume with preserved context, retain the checkpoint as a handoff and start a clean replacement explicitly.

## Handoff

Every participant returns:

```markdown
# Handoff

Task:
Status: complete | degraded | blocked
Summary:
Touched scope:
Behavior or contract changes:
Checks and results:
Artifacts or patch identity:
Dependencies discovered:
Risks and unresolved questions:
Integrator invariants:
```

A successful process exit without the expected patch, artifact, or evidence is not a successful handoff. Preserve partial work as degraded evidence when it is useful and safe to integrate.

## Conflict evidence

Distinguish three conflict classes:

- **Textual conflict:** edits overlap mechanically.
- **Semantic conflict:** edits merge but depend on incompatible meanings.
- **Architecture conflict:** the decomposition or accepted direction is wrong.

Each affected owner reports:

```markdown
# Conflict Report

Task and owned scope:
Conflicting scope:
Intent:
Invariant that must survive:
Change made:
Evidence:
Safe-to-discard portion:
Proposed resolution:
```

The integrator resolves from both reports. Architecture conflicts stop affected work and return to planning. Do not let participants recursively negotiate until their independent intent is lost.

## Integration protocol

The named integrator:

1. reads task cards, handoffs, dependency edges, and conflict reports;
2. verifies each result stayed within scope;
3. integrates in dependency order, one ownership edge at a time;
4. resolves conflicts while preserving stated invariants;
5. runs checks after risky edges and the full agreed validation at the end;
6. obtains fresh review for conflict-resolved or shared-contract changes;
7. reports integrated tasks, rejected or deferred work, checks, and residual risks.

Do not treat a clean merge, participant-local tests, or a collection of terminal Runs as integrated completion. Completion requires retained shared state plus coordinator-owned validation evidence.

## Stop conditions

Stop and replan when ownership overlaps, an exclusive contract lacks one owner, task cards cannot be independently validated, an out-of-scope dependency is required, architecture conflict appears, or no integrator can validate the retained result. Prefer a smaller serial cohort over parallel diff chaos.
