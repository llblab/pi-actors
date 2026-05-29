---
name: swarm
description: Subagent orchestration with scoped locks and quorum consensus. Use for multi-model review, parallel scoped work, delegated audit, and coordinated subagent execution.
metadata:
  version: 0.30.1
---

# Swarm

Subagent orchestration: delegated review, quorum consensus, scoped locks, clean-context merge, and post-merge review.

## Purpose

Run subagents safely and predictably through reusable orchestration contracts.

Swarm is independent. It must not require concrete sibling skill names, private repositories, local model aliases, or a specific tool registry layout. Local agents may bind the contracts to their own tools, command templates, model names, and review protocols.

Maintain this skill as a living orchestration standard. When real swarm work exposes better decomposition shapes, lock etiquette, quorum rules, checkpoint semantics, failure modes, or trade-offs, fold those lessons back here as durable guidance instead of leaving them only in one-off transcripts or backlog notes.

## Core Concepts

- `Orchestrator`: Main agent. Coordinates subagents, owns safety, and writes final artifacts.
- `Subagent`: Bounded delegated model call for review, audit, merge, or scoped implementation.
- `Scope`: File, directory, module, or logical domain that a subagent operates on.
- `Lock`: Read or write ownership of a scope for bounded time.
- `Quorum`: Multiple independent subagents reviewing the same target.
- `Merger`: Clean-context fifth subagent that synthesizes raw quorum outputs.
- `Reviewer`: Post-merge reviewer that checks report quality, not the original domain by default.
- `Async Run Adapter`: Local async binding that starts, tracks, lists, tails, and cancels swarm runs through a generic lifecycle runtime.
- `Async Run`: A local lifecycle envelope around a command-template swarm composer or utility. It owns state, logs, status, cancellation, and observability, not swarm semantics.
- `Lens`: A deliberately narrow cognitive role assigned to one subagent, such as security, tests, architecture, economics, or operator UX.
- `Task Card`: A bounded implementation assignment with goal, allowed files, avoided files, expected output, and validation gates.
- `Component Capability`: An abstract adapter operation such as launcher, reviewer, verifier, merger, quorum, checkpoint, follow-up, judge, or normalizer. Swarm may target these capabilities, but local adapters bind them to concrete tools, recipes, candidate recipes, command templates, async runs, or services.
- `Candidate Recipe`: A reusable but non-registered recipe captured from a successful inline actor spawn. It can be replayed by explicit file path and later promoted into the active tool recipe root after enough dogfood.
- `Coordinator Checkpoint`: A deliberate subagent pause where the subagent preserves its working context, sends a bounded question or status to the orchestrator, receives a coordinator reply, and continues in the same subagent context.
- `Evidence Checkpoint`: A deliberate stop where a subagent records sources, assumptions, confidence, contradictions, or blocking evidence gaps before synthesis.
- `Integrator`: The human or agent that merges isolated branches/worktrees into the shared target and owns conflict resolution.

## Swarm Principle

One agent should hold one lens. Many independent lenses make the whole judgement stronger. Parallel lenses make the whole judgement faster.

Swarm is useful because focused subagents usually perform better than one overloaded model trying to reason about every concern at once. Each subagent receives the same target but a narrower mandate, reducing cognitive load and making misses less correlated. The merger then synthesizes the independent observations into one decision-grade artifact.

Use swarm when the work benefits from parallel cognitive lenses, not merely because more models are available. A good swarm decomposes the task into review surfaces that are independently meaningful, then preserves agreement, disagreement, and minority high-impact findings.

## Swarm Shapes

Distinguish breadth from confidence before launching subagents.

```text
Lens Swarm = different lenses on one object
Quorum     = one lens, multiple independent judges
```

`Lens Swarm` optimizes coverage. It asks which aspects matter and sends focused agents through different mandates: architecture, security, tests, UX, release, docs, economics, governance, or operations. Use it for brainstorming, product design, architecture exploration, development planning, and broad risk review.

`Quorum` optimizes confidence. It keeps the lens constant and varies models, seeds, prompts, or independent instances so several judges answer the same question. Use it mostly for verification: high-stakes review, security verdicts, ambiguous bug hypotheses, publish readiness, and final confidence checks.

`Lens Swarm of Quorums` optimizes both breadth and confidence. Each important lens gets its own mini-quorum, and a merger synthesizes across lenses while preserving vote counts and minority high-impact findings. This is expensive and should be reserved for high-stakes systems such as money movement, blockchain protocols, governance, security boundaries, migrations, or public releases.

Decision rule:

```text
Need breadth?     Use Lens Swarm.
Need confidence?  Use Quorum.
Need both?        Use Lens Swarm of Quorums.
```

## Work Modes

Swarm is not only for review. The same lens discipline supports ideation, research-style exploration, planning, implementation coordination, and verification.

### Brainstorm Swarm

Purpose: turn many possible futures into one recommended direction.

Typical lenses:

- Product/user value
- Operator UX
- Protocol or platform cleanliness
- Implementation pragmatism
- Adoption/growth
- Skeptic/failure modes
- Constraints and portability

Merger output:

- Recommended direction
- Alternatives considered and rejected
- Open questions
- First implementation slice
- Risks and validation gates

Brainstorm swarms should not vote mechanically. They should preserve creative tension and synthesize a direction that fits constraints.

### Research Swarm

Purpose: turn a broad question into evidence-backed synthesis without letting one agent's search path dominate the answer.

Typical lenses:

- Question/scope formulation
- Source discovery
- Source verification
- Synthesis and contradiction mapping
- Devil's advocate / counter-evidence
- Ethics, policy, or stakeholder impact when relevant

Research swarm rules:

1. Scope first: the coordinator defines the question, non-goals, source classes, and stop condition before launching evidence work.
2. Search and verification are separate lenses when stakes are high; the searcher finds candidates, the verifier checks quality and support.
3. Every material claim in synthesis must trace to a source note, inspected artifact, or explicit uncertainty statement.
4. Contradictory evidence is preserved as a first-class output, not hidden by consensus language.
5. Evidence checkpoints block synthesis when sources are insufficient, unverifiable, conflicted, or ethically unsafe to use.

Merger output:

- Bounded research question
- Evidence map with confidence and source quality
- Areas of convergence and contradiction
- Limitations and not-checkable claims
- Recommended decision or next evidence slice

Research swarms are for inquiry and synthesis, not automatic publication pipelines. Keep report formatting local to the caller's domain.

### Development Swarm

Purpose: turn one accepted direction into coordinated slices.

Recommended flow:

```text
Planner → Lens Swarm → Merger → Scoped Implementers → Integrator → Review Swarm
```

Use scoped write locks or a repository-local soft-lock manifest when multiple implementers may edit files. Keep implementation agents bounded by module, artifact, or responsibility: code, tests, docs, examples, migration, or release notes. Prefer one owner per writable scope and run verification with fresh reviewers after implementation.

### Consensus-First Build Swarm

Purpose: create one coherent artifact from several expert lenses without making every participant write the artifact.

Recommended flow:

```text
Lens proposers → shared room consensus → named implementer → QA reviewer → finalizer
```

Use this shape for creative/product artifacts, demos, single-file deliverables, docs, specs, prompts, and other work where parallel implementation would fragment the result. Lens proposers should post concrete constraints, proposals, and handoff notes to the shared room but should not mutate files. One named implementer inspects the room transcript and owns the first artifact write. A fresh QA reviewer inspects the artifact plus room evidence and reports issues back to the room. The implementer/finalizer then applies only the review-grounded fixes and emits the final artifact message.

Failure mode: if the runner only asks all lenses to chat and then writes a report, it can "succeed" without producing the requested artifact. Guard against this with explicit artifact assertions, role-specific write permissions, and a finalizer that checks artifact existence/size/content before `run.done`.

### Small-Team Development Swarm

For 2–4 implementation agents, prefer the dedicated MAWP reference instead of expanding the general Swarm skill. The portable idea is simple: isolate writable work surfaces, give each agent a bounded task card, preserve handoff evidence, and merge through one integrator.

Use [`references/development-swarm.md`](./references/development-swarm.md) for concrete worktree/branch flow, task-card templates, soft-lock manifests, conflict reports, coordinator checkpoints, and merge rules.

### Review Swarm

Purpose: turn one result into many risk lenses and a decision-grade verdict.

Use lens swarm for broad coverage, quorum for confidence on one critical judgement, or both for high-stakes releases. The final report should separate consensus findings, minority findings, merger findings, risks, and recommended next actions.

A review swarm synthesis must not fabricate claims. Every final finding should trace to a reviewer note, checked artifact, command output, source, or explicit merger rationale. Devil's Advocate critical findings must be preserved or explicitly disproved with evidence.

## Lens Catalog

Choose lenses by risk. Do not run every lens by default; select the smallest set that covers the failure modes of the work.

### General Software Lenses

- `Architecture`: module boundaries, dependency direction, cohesion, coupling, extensibility, and long-term ownership.
- `Correctness`: functional behavior, edge cases, invariants, state transitions, and input/output contracts.
- `Bug Hunter`: likely defects, race conditions, null/empty cases, off-by-one errors, and broken assumptions.
- `Security`: injection, privilege boundaries, path handling, secrets, deserialization, unsafe shell/process use, and abuse cases.
- `Tests`: coverage quality, missing regressions, fixture realism, flaky risk, and validation gates.
- `Performance`: algorithmic cost, latency, memory, IO, batching, backpressure, and hot paths.
- `Concurrency`: locks, cancellation, timeouts, idempotency, retries, ordering, and stale state.
- `Data Integrity`: migrations, schema compatibility, durability, rollback, deduplication, and corruption risk.
- `API Compatibility`: public contract drift, backwards compatibility, versioning, deprecation, and client impact.
- `Operator UX`: observability, error messages, status, logs, recovery paths, safe defaults, and support burden.
- `Developer UX`: onboarding, local setup, naming, examples, docs, type ergonomics, and debugging clarity.
- `Product UX`: user journey, surprising behavior, accessibility, copy, affordances, and feedback loops.
- `Release`: changelog truth, version bump, package contents, CI gates, publish risk, and rollback readiness.
- `Documentation`: README accuracy, examples, conceptual consistency, and stale references.
- `Compliance/Policy`: licenses, privacy, retention, consent, audit trails, and organizational constraints.
- `Incident Response`: blast radius, detection, containment, rollback, forensics, and runbook quality.
- `SRE/Reliability`: availability, graceful degradation, monitoring, quotas, rate limits, and dependency failure.
- `Maintainability`: simplicity, naming, duplication, dead code, testability, and future change cost.
- `Spec Consistency`: whether code, docs, tests, prompts, and changelog describe the same behavior.

### Complex System / Blockchain Lenses

Use these for blockchain, distributed systems, financial protocols, governance, or adversarial environments.

- `Protocol Invariants`: conservation laws, supply rules, ledger consistency, finality assumptions, and impossible states.
- `Consensus Safety`: fork choice, quorum thresholds, validator behavior, equivocation, reorg handling, and liveness tradeoffs.
- `Economic Security`: incentives, MEV, griefing, sybil cost, fee dynamics, slashing, reward leakage, and manipulation paths.
- `Smart Contract Safety`: reentrancy, authorization, upgradeability, storage layout, oracle trust, token standards, and invariant tests.
- `Cryptography`: key management, signature/domain separation, nonce use, randomness, hash commitments, and proof assumptions.
- `Cross-Chain/Bridge`: message replay, finality mismatch, validator set drift, withdrawal delays, and custody assumptions.
- `Governance`: proposal lifecycle, quorum rules, timelocks, emergency powers, capture risk, and voter/operator UX.
- `Treasury/Accounting`: balance reconciliation, fee distribution, rounding, precision, reserves, and auditability.
- `Adversarial Simulation`: attacker goals, cheapest exploit path, denial-of-service vectors, sandwiching, and liquidation games.
- `Network/P2P`: peer discovery, gossip propagation, eclipse risk, bandwidth limits, spam resistance, and partition behavior.
- `Node Operations`: sync, snapshots, pruning, backups, observability, upgrades, config safety, and rollback.
- `Formal Methods`: invariant specification, model checking candidates, property tests, and proof gaps.
- `Regulatory Surface`: custody, KYC/AML implications, sanctions, securities risk, data retention, and jurisdictional assumptions.

## Tool Contracts

These are abstract tool contracts. Register them in whatever local tool layer exists. Concrete syntax is an adapter detail outside this skill.

- `swarm_review`: single subagent review.
- `swarm_quorum`: multi-model independent review.
- `swarm_claim`: acquire a scoped read/write lock.
- `swarm_release`: release a scoped lock.
- `swarm_merge`: synthesize raw quorum outputs.
- `swarm_post_merge_review`: review the merged report quality.

## File Handoff

Prefer path handoff over attachment syntax. Put the target path directly in the subagent prompt:

```text
Review this local file: /path/to/file.md. First read it from disk.
```

Attachment syntax is optional local optimization, not a swarm contract. Path handoff keeps the skill portable across wrappers without attachment arguments.

## `swarm_review`

Single subagent review.

`Inputs`:

- `scope`: file path, directory, module, or logical domain.
- `model`: model identifier in the local environment.
- `prompt`: optional review lens or task-specific instructions.
- `thinking`: optional reasoning depth.
- `tools`: optional local tool allowlist.
- `timeout`: timeout in seconds.

`Behavior`:

1. Optionally claim a read lock for the scope.
2. Spawn one subagent with a prompt that includes the scope path.
3. Require the subagent to read the target from disk before judging it.
4. Return the subagent's raw output.
5. Release the lock if one was claimed.

`Reference prompt`:

```text
Review this local scope: <scope>.
First read it from disk.
Use the local review protocol if available.
Report white spots, contradictions, evidence, and risks.
```

## Async Run Adapter

Async run management is an adapter concern, not a portable Swarm script requirement. For non-trivial asynchronous agentic work, use an async-run flow when the local runtime supports it: command-template execution plus a thin detached lifecycle envelope.

- `start`: Launch a swarm run in the background and return run metadata.
- `status`: Report whether the run is running, done, degraded, or failed.
- `tail`: Show recent structured run events or raw logs.
- `list`: Show known runs.
- `cancel`: Stop an owned active run when the adapter can prove pid ownership.

`Purpose`: Keep the user interface responsive while reviewers, merger, and post-merge reviewer run. Generic run state belongs to a local async lifecycle runtime; swarm-specific execution stays in atomic utilities or command-template composition. The orchestrator should start the run, return metadata, then inspect status/tail after terminal events instead of blocking on sleeps or foreground waits.

`Resumable checkpoint goal`: Advanced adapters should strive to support a paused subagent that can ask the orchestrator for input and then resume in the same subagent context. The portable contract is a structured coordinator checkpoint plus a coordinator reply; the mechanism may be a TTY session, persistent model session, message queue, or runtime-specific resume token. If the runtime cannot preserve context, degrade to a handoff artifact and a new subagent, and mark the context loss explicitly.

`Progress contract`: async runs should expose structured state such as `progress.json`, `events.jsonl`, logs, and final result metadata. Local tools should read these files through async-run verbs instead of scraping process output.

`Minimum state`: an adapter should expose `run_id`, `status`, timestamps, state directory or output directory, recent events, stdout/stderr logs, and final result metadata.

`Terminal statuses`: `done`, `failed`, `timeout`, and `cancelled` are terminal. `running` and `degraded` are observable non-terminal states.

`Cancellation boundary`: cancel only an owned active run when pid ownership or runtime ownership can be verified. Stale pid reuse must fail closed.

`Reference binding`: Use a local generic async-run runtime or tool registry adapter. If the local runtime exposes a single action tool, bind these verbs as actions rather than adding more Swarm scripts. Swarm scripts themselves should stay atomic and narrowly specialized.

## Stable Multi-Agent Review Rules

- Prefer independent read-only reviewers for review swarms. Use shared room messages for coordination signals and observability, not for letting reviewers converge early, unless the task explicitly asks for collaborative discussion.
- Treat communication logs as recipe-quality evidence. Timelines show whether agents coordinate clearly, emit useful summaries, over-chat, miss handoffs, choose poor message types, or need better mailbox/artifact conventions.
- Smoke-test provider/model availability before launching expensive fanout, or choose a provider known to be configured in the environment. A failed provider fanout creates noisy run transitions without useful review signal.
- Keep methodology and runtime split: Swarm chooses decomposition, quorum, lenses, lock discipline, and merge shape; the local runtime supplies actors, messages, files, locks, artifacts, and cancellation.

## Persistent Implementer Pattern

Use this pattern only when the work benefits from long-lived workers rather than one-shot subagents. Keep task selection with the coordinator and use reusable adapter cells for queues, locks, messages, and mailbox loops.

1. Coordinator assigns a concrete task with `task.assign` or an adapter-equivalent envelope.
2. Actor claims before editing or mutating shared state.
3. Actor executes and validates the slice.
4. Actor posts a result plus an explicit availability/blocked status.
5. Actor stays alive until another assignment or an explicit runtime/domain stop.

Use opposite-end or lens-specific implementers only to reduce overlap, not as a default. If a host adapter cannot express this scenario from reusable cells, add missing generic cells before packaging a broad workflow.

## `swarm_quorum`

Multi-model review by independent subagents.

`Inputs`:

- `scope`: target path or domain.
- `models`: 2-6 model identifiers.
- `prompt`: shared review lens.
- `thinking`: per-model or shared reasoning depth.
- `timeout`: per-subagent or whole-quorum timeout.
- `merge_mode`: merge behavior, default `consensus-first`.
- `merger_model`: explicit model for the clean merger.

`Behavior`:

1. Claim a shared read lock when the target is local and stable.
2. Spawn one subagent per model concurrently unless a local rate limit requires throttling.
3. Give every subagent the same target path and review lens.
4. Preserve every raw output.
5. Release the lock.
6. Run a clean-context merger subagent.
7. Store or return the merged report.
8. Optionally run post-merge review.

`Reference binding`: Implement this contract through a local adapter such as a command-template composer, registered tool, or async run. The portable Swarm skill intentionally does not ship a runtime-specific quorum runner.

`Serious quorum rule`: For high-stakes review, the merger is not the current orchestrator. The merger is a fifth clean-context subagent.

## Lock Protocol

Locks prevent subagents from interfering with shared scopes. Locks are optional for read-only review, but required for concurrent mutation.

### Lock Fields

- `scope`: Scope identifier, usually a path or domain label.
- `owner`: Subagent or quorum run that owns the lock.
- `type`: `read` or `write`.
- `acquired`: Acquisition time.
- `ttl`: Time-to-live in seconds.
- `expires`: Expiry time derived from acquisition plus TTL.

### Conflict Rules

- `read` request with no lock: allow.
- `read` request with existing `read`: allow.
- `read` request with existing `write`: conflict unless stale.
- `write` request with no lock: allow.
- `write` request with existing `read` or `write`: conflict unless stale.

### Lifecycle

1. `acquire`: prune stale locks, then check conflicts.
2. `hold`: run the bounded subagent task.
3. `release`: remove the entry.
4. `expire`: any later lock operation may prune stale entries.

`TTL rule`: Every lock must have a TTL. A lock without expiry is invalid.

`Adapter implementation`: Use a local actor/runtime adapter when automation, TTL enforcement, or machine-readable lock state is needed. The portable Swarm skill defines lock semantics but does not ship a lock runtime.

## Validation

After changing Swarm adapter contracts or packaged documentation, validate the local distribution with whatever checks the host project provides. At minimum, review the text for boundary drift:

- no dependency on a specific extension, actor runtime, registry, recipe store, or CLI runner;
- no bundled broad coordinator or lock runtime as portable Swarm core;
- no hard-coded model names, private paths, or transport-specific message syntax in the methodology contract;
- adapter examples remain examples, not requirements.

If a host package ships a Swarm self-test, treat it as a local packaging gate rather than part of the portable methodology.

## Merge Protocol

The merger is not a passive formatter. The merger is the final synthesis agent and can materially affect the output by choosing labels, grouping findings, deciding severity, preserving minority signals, and adding grounded judgement.

`Merger influence`: High.

`Merger role`: Read all raw outputs, deduplicate, rank, preserve dissent, and produce one decision-grade artifact. The merger may add its own finding only as `merger finding` and only when grounded in evidence.

`Merger isolation`: For serious quorum work, the merger should be a dedicated clean-context subagent with explicit model, thinking level, and minimal access. The orchestrator provides the input bundle and writes the final artifact after the merger returns.

`Orchestrator merge exception`: The orchestrator may merge quick, low-stakes, or exploratory quorum runs. The report must say the merge was not isolated.

### Merge Parameters

- `merger_model`: Explicit synthesis model. Required for quorum reports.
- `merger_context`: Clean or inherited context. Default `clean` for serious quorum.
- `merger_tools`: Tool access granted to merger. Prefer none if raw text is embedded; otherwise read-only access to raw outputs.
- `merger_thinking`: Reasoning depth. Use `medium` normally, `high` for architecture, security, money, governance, migrations, or specs.
- `merge_mode`: Synthesis style. Default `consensus-first`.
- `consensus_threshold`: Votes needed to promote. Use `3/4` for critical promotion and `2/4` for major discussion by default.
- `minority_policy`: Treatment of unique findings. Preserve high-impact, evidence-backed minority findings.
- `attribution`: Which model found what. Required for quorum reports.
- `raw_retention`: Keep raw outputs until the final report is accepted.

### Merge Modes

- `faithful`: Minimal editing; preserves subagent wording and uncertainty.
- `consensus-first`: Groups by agreement and preserves dissent separately.
- `risk-first`: Promotes high-impact minority findings even without consensus.
- `design-synthesis`: Converts findings into decisions and repair order.

### Merge Guardrails

- Preserve raw outputs until the final report is accepted.
- Do not hide model disagreement.
- Do not drop high-impact minority findings only for lack of consensus.
- Do not over-promote repeated low-value nitpicks.
- Keep model attribution for every major finding.
- Keep merger identity explicit: model, context, thinking, and tools.
- Separate `consensus finding`, `minority finding`, and `merger finding`.
- Separate current-quorum votes from prior-run corroboration.

## Post-Merge Review

Run a reviewer on the merged report when the output will drive code, architecture, security, money, governance, migrations, or specifications.

`Purpose`: Review the review. The reviewer checks whether the merger preserved evidence, ranked severity honestly, avoided hallucinated synthesis, kept minority high-impact findings, and produced an actionable artifact.

`Reviewer input`:

- Target scope
- Raw subagent outputs
- Merged report
- Merge parameters
- Intended use of the report

`Reviewer output`: Meta-findings about report quality, not a second domain review unless explicitly requested.

### Post-Merge Review Lens

- `Evidence`: Does each major finding trace to raw outputs or clearly marked merger evidence?
- `Severity`: Are labels justified by failure impact?
- `Consensus`: Was agreement counted honestly?
- `Purity`: Is current quorum separate from prior context?
- `Minority`: Were unique high-impact findings preserved?
- `Bias`: Did the merger impose an unsupported narrative?
- `Actionability`: Are repair order, scope, and gates named?
- `Consistency`: Do maps, headers, and attribution agree?
- `Compression`: Were caveats or disagreements lost?

### Post-Merge Decisions

- `Accept`: Report is decision-grade.
- `Accept with notes`: Report is useful, with caveats.
- `Revise merge`: Rerun merger with adjusted parameters.
- `Rerun quorum`: Raw outputs are too weak, divergent, or under-scoped.
- `Escalate`: Run cross-merge with another clean merger.

## Error Handling

- `LOCK_CONFLICT`: Retry, back off, or choose another scope.
- `SUBAGENT_TIMEOUT`: Keep partial results and release locks by TTL.
- `COORDINATOR_INPUT_REQUIRED`: Pause only if the adapter can preserve subagent context; otherwise write a checkpoint artifact and stop degraded for coordinator replanning.
- `MODEL_FAILURE`: Continue with fewer votes and mark degraded quorum.
- `MERGE_FAILURE`: Return `INSUFFICIENT_DATA` or rerun merger.
- `REVIEW_FAILURE`: Keep merged report and mark post-review missing.

## Composition Contract

This skill composes with capabilities, not concrete sibling skills:

- Local tool registry for reusable command-template adapters
- Local review and implementation protocols
- Scoped lock standard with TTL
- Subagent runner with file-read access
- Artifact writer owned by the orchestrator

Do not make swarm depend on a specific sibling skill, repository, model alias, or tool registry. The orchestrator may tell subagents to use the local review protocol when one exists.

## Portability Lens

- `Lock protocol`: Mandatory kernel.
- `Quorum review`: Optional capability.
- `Clean merger`: Mandatory for serious quorum.
- `Post-merge review`: Required for high-stakes outputs.
- `Command templates`: Local adapter.
- `Test scripts`: Protocol validation aid.

Operational tools, recipes, transport bindings, and runtime-specific adapters belong to the host project documentation, not this methodology skill.
