# Review Swarms

Use this reference for independent review, delegated audit, research synthesis, quorum judgement, and post-merge review. Generic actor execution remains owned by `actors`.

## Select breadth or confidence

```text
Different lenses on one target → breadth → lens swarm
Same exact claim, independent judges → confidence → quorum
Important lenses each need repeated judges → breadth + confidence → lens swarms of quorums
```

Use the smallest shape that covers the decision risk. A lens swarm of quorums is reserved for high-impact security, financial, governance, migration, or release decisions.

Primary Recipes:

- `swarm/lens-review` for parallel risk lenses plus verification, merge, judge, and normalized result;
- `swarm/quorum-review` for one prompt judged independently by explicitly selected models;
- `swarm/research-synthesis` for plan, evidence map, contradictions, verification, and risk-first synthesis;
- `swarm/architect` for competing directions and one validated smallest next slice;
- `swarm/review-readiness` for a multi-lens ship/readiness verdict.

## Lens selection

Choose lenses from plausible failure modes, not from a fixed catalog. Common software lenses include correctness, architecture, security, tests, concurrency, data integrity, performance, operator UX, accessibility, maintainability, documentation, and release risk.

A good lens assignment states:

```markdown
Target:
Question or claim:
Lens:
Evidence required:
Out of scope:
Severity rule:
Output shape:
Stop condition:
```

Do not ask every reviewer to cover everything. Keep reviewers independent until synthesis so one early narrative does not contaminate all findings.

## Quorum design

A quorum keeps the target, claim, evidence standard, and output shape constant while varying independent judges. Before fanout:

1. define the exact decision claim;
2. define what counts as supporting and contradicting evidence;
3. select the minimum successful threshold;
4. choose concurrency and timeout bounds;
5. preflight model and tool availability;
6. define how partial results affect status.

Provider or model failure reduces available evidence; it is not a vote. When evidence falls below threshold, mark the result degraded or insufficient data.

## Research evidence

Research participants separate source discovery, verification, contradiction mapping, and synthesis when stakes justify it.

- Every material claim traces to a source note, inspected artifact, or explicit uncertainty.
- Source quality and confidence remain visible.
- Contradictory evidence is first-class output.
- Missing source classes block overconfident synthesis.
- Unsafe or unverifiable evidence is excluded with a reason.

Do not turn a research swarm into an automatic publication pipeline. Stop at the caller's evidence and decision boundary.

## Merge protocol

A merger is a synthesis participant, not a formatter. It may deduplicate, rank, connect evidence, and add a grounded `merger finding`, but it may not fabricate support.

For serious quorum work, use a clean-context merger. The merger receives all retained participant outputs and must produce:

- status: complete, degraded, or insufficient data;
- consensus findings and vote shape where applicable;
- minority high-impact findings;
- contradictions and unresolved evidence gaps;
- merger findings, clearly labeled;
- confidence and limitations;
- ordered next actions.

Keep raw participant outputs until the merged result is accepted. Preserve attribution for major findings. Never promote repeated low-value observations merely because they are numerous, and never discard a severe evidence-backed minority finding merely because it is unique.

## Conflict and disagreement

Disagreement can mean different assumptions, different evidence, ambiguous criteria, or real uncertainty. The merger records:

```markdown
Finding:
Supporting participants and evidence:
Contradicting participants and evidence:
Assumption difference:
Impact if minority view is correct:
Resolution status:
Next evidence needed:
```

Resolve only when evidence supports resolution. Otherwise preserve the disagreement and lower confidence.

## Post-merge review

Use a fresh reviewer when the merged result will drive consequential implementation or decisions. The post-merge reviewer checks the report, not the original target by default:

- evidence traceability;
- honest severity;
- correct quorum accounting;
- preserved minority findings;
- unsupported merger narrative;
- actionable next steps;
- retained uncertainty and contradictions.

Possible decisions are accept, accept with notes, revise merge, rerun bounded quorum, or escalate. Rerun only when the raw evidence or scope is genuinely insufficient, not because the verdict is inconvenient.

## Completion and stop rules

A review swarm is complete only when requested evidence is retained, threshold status is explicit, synthesis preserves dissent, and the coordinator can state the safe decision or next evidence slice. Stop when the claim is ambiguous, target changes during review, preflight fails, evidence is not inspectable, threshold cannot be met, or merger independence required by the stakes is unavailable.
