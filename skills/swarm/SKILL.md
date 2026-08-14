---
name: swarm
description: Use when work needs multiple actors or subagents for independent implementation, artifact generation, review, delegated audit, research, or coordinated decomposition and integration.
---

# Swarm

Use multi-actor execution only when at least two scopes or evidence lenses are meaningfully independent and parallelism, clean-context judgement, or quorum confidence is worth the coordination overhead. Do not swarm a task that one bounded agent can complete safely, a task whose architecture is still unsettled, or concurrent mutations of one shared contract.

Read `actors` first for generic Recipe, spawn, Run, Trace, Control, artifact, and lifecycle operation. This Skill owns only multi-actor methodology: decomposition, scope ownership, independence, synthesis, integration, and completion proof.

## Choose the shape

| Need | Shape | Primary Recipe |
| --- | --- | --- |
| Different risk lenses on one target | Lens swarm | `swarm/lens-review` |
| Independent judges for one exact claim | Quorum | `swarm/quorum-review` |
| Evidence map plus contradiction-preserving synthesis | Research swarm | `swarm/research-synthesis` |
| Competing architecture directions and one smallest next slice | Architecture swarm | `swarm/architect` |
| Bounded implementation assignment with scope critique | Development tasking | `swarm/development-tasking` |
| Multi-lens ship/readiness verdict | Readiness review | `swarm/review-readiness` |

Use different lenses for breadth and repeated independent judges for confidence. Combine both only for high-stakes work where the added cost is justified. `swarm/subagent-*` Recipes are maintained composition components; start from a primary Recipe unless building an intentional custom composition.

## Coordinator protocol

The coordinator owns the whole result even when participants choose local implementation details.

1. State the goal, non-goals, evidence standard, integration owner, and stop condition.
2. Partition work into disjoint read or write scopes. Give shared contracts one owner.
3. Give each participant a bounded task card with allowed scope, avoided scope, expected artifact, checks, and escalation rule.
4. Preflight required model/tool access before expensive fanout.
5. Launch independent work without cross-contaminating lenses. Do not let participants silently expand scope.
6. Preserve every terminal result, including failures, disagreements, and partial evidence.
7. Merge through one named synthesizer or integrator. Resolve conflicts from explicit intent and invariants, not textual convenience.
8. Run fresh integrated validation and, for consequential outputs, an independent post-merge review.
9. Report complete, degraded, or insufficient-data status honestly; name residual owners and next actions.

## Scope and coordination rules

- One writable scope has one owner. Parallel readers may share a stable target.
- Public contracts, schemas, central configuration, and integration surfaces require exclusive ownership.
- Participants record out-of-scope needs instead of opportunistically editing them.
- Coordinator checkpoints are bounded decision requests, not free-form actor chat.
- Locks support scope ownership but do not replace coordinator judgement. Every lock must be bounded and releasable.
- One integrator owns merge order, conflict resolution, and final validation.
- A zero-conflict merge is not proof of semantic compatibility.

## Evidence and quorum rules

- Every material finding traces to inspected evidence or explicit uncertainty.
- Preserve minority high-impact findings and contradictions; consensus does not erase them.
- Keep reviewer evidence separate from merger findings.
- If successful evidence is below the requested threshold, return degraded or insufficient data instead of inventing quorum.
- Use a clean-context merger for serious quorum work. Use a fresh post-merge reviewer when the result drives code, security, architecture, money, governance, migrations, or release decisions.

See [review swarms](./references/review-swarms.md) for lens, quorum, synthesis, and conflict-evidence detail. See [development swarms](./references/development-swarm.md) for task cards, write ownership, handoffs, conflict reports, and integration.

## Stop rules

Stop or replan when scopes overlap, a participant needs an undeclared shared contract, evidence cannot meet the threshold, provider/tool preflight fails, conflict changes the architecture, no integrator owns the result, or integrated validation is unavailable. Do not compensate with extra agents, repeated blind retries, shared mutable work, or coordinator-written consensus unsupported by participant evidence.
