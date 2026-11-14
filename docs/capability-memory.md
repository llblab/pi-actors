# Capability Memory and Tool Exposure

## Status and Scope

Adopted design direction: preserve reusable capabilities separately from exposing named agent tools. Sync/async remains an execution contract, not a maturity score or registration rule. This document adopts the separation and its safety constraints, not a new storage format, Recipe field, public API, automatic-review action, or migration of existing Recipes.

Explicit create-only retention and read-only library inventory are implemented. Automatic retention/exposure, retained update/deletion and live portfolio migration remain unimplemented. Current tool-root discovery, automatic promote/discard decisions and ordinary tool activation behavior remain unchanged. [BACKLOG.md](../BACKLOG.md) owns remaining work; this document owns design truth, not another task list.

## Three Independent Questions

- **Execution:** Does an invocation await the result inline or return a detached Run launch receipt?
- **Maturity:** Is this an unreviewed capture or a retained capability with stated validation evidence? Retention does not certify successful work, safety in every context, or generality.
- **Exposure:** Should the agent be offered this capability as a named tool? A retained Recipe may remain usable without occupying the tool interface.

A Recipe defines reusable execution. A tool is an agent-facing entrypoint to a capability. A Run is one concrete execution. Saving a definition, exposing a tool, activating it in the current host, launching it, and accepting its result remain separate facts.

The product goal is useful procedural memory with a selective tool interface, not the largest possible collection of callable names. More captures, launches, promotions, or registrations alone do not establish improvement.

## Current Baseline and Its Limits

Current user-root discovery exposes valid enabled direct Recipes by location, while active Skill components already provide reusable capabilities without automatic tool exposure. Ordinary registration supports both execution modes, and public `actors_run_spawn` accepts ordinary non-singleton Recipes without `async: true`; the flag is not a foreground-only restriction. Inline-template `actors_run_spawn` capture produces async drafts rather than capturing maintained/file Recipe launches, so a sync-only promotion rule would exclude that capture stream.

Automatic review sees value-free shape, risk labels, launch counts and batch-local content-equality groups, not commands, descriptions, argument names/values, canonical names/paths or accepted outcomes. Its current promote/discard executor preserves captured executable content rather than generalizing a mission. Usage records launches and lineage, not successful task completion. These limits neither authorize bypassing confidentiality nor justify discarding a capability whose usefulness remains unknown.

## Read-Only Inventory Checkpoint

The retained library stays outside nonrecursive tool-root discovery, including on older hosts. Directory separation fails safely where an unknown Recipe opt-out field could be ignored. No new Recipe field or logical-reference namespace is introduced.

Use `actors_inspect target=recipes view=summary` and `verbose=true` for retained paths and diagnostics. The [inspection contract](./inspection.md) owns views and coverage; the [tool registry](./tool-registry.md#retain-a-new-capability-without-tool-exposure) owns the current save/discover/reuse workflow. Inventory is storage evidence, not review, callability or a running Actor, and never initializes an absent library.

## Explicit Persistence Contract

The implemented create-only operation is `actors_tool_register expose=false` with a new name and one template/from source. Omitted/true keeps ordinary registration. The [tool registry](./tool-registry.md#retain-a-new-capability-without-tool-exposure) owns supported inputs, source preservation, conflicts, mutation fences and withdrawal limits; this design does not define a second persistence path.

The management path is **save deliberately → find through Recipe inspection → reuse the exact Recipe reference → expose explicitly when useful → withdraw only the wrapper when appropriate**. Moving executable sources, converting existing tools/drafts, retained updates/deletion and automatic transitions require separately admitted contracts. Source/package acceptance does not reload an older host or authorize live portfolio changes.

### Receipt and Failure Truth

Retention must be distinguishable from failed activation: `kind: retained_recipe`, `activation: not_requested`, and an exact reusable Recipe path, without global callability claims about a same-named tool. The [current receipt and storage contract](./tool-registry.md#retention-safety-and-accounting) owns fields, budgets, original causes and partial-effect handling. Unknown effects require inspection, not automatic retry or deletion.

### One Usage Owner, Distinct Entrypoints

Reuse the parent's existing usage owner rather than create a library ledger system. Retention, exposure and withdrawal must preserve distinct entrypoint history without inventing accepted outcomes; the [usage/lineage contract](./tool-registry.md#usage-and-lineage) owns the implemented namespace and move rules. Aggregate retention bounds, expiry/disposal and semantic evidence remain prerequisites for future automatic retention, not new tool-count quotas for the manual slice.

## Adopted Lifecycle Direction

The following is a conceptual lifecycle, not currently supported review syntax:

```text
Unreviewed capture
  ├─ Discard under an admitted retention policy
  ├─ Defer when evidence is insufficient
  └─ Retain as a reviewed Recipe with explicit evidence limits
       ├─ Reuse by the existing Recipe execution path
       └─ Deliberately expose as a named tool
            └─ Resolve → validate → persist → activate → prove callable_now
```

Sync and async Recipes can be retained or exposed. Do not leave a reviewed capability permanently classified as an unreviewed draft merely because it is async. Do not expose a synchronous one-off merely because it returns inline. Demotion of a useful tool should be able to withdraw exposure without erasing the retained capability or pretending it has never been reviewed.

Insufficient semantic evidence is **unknown**, not a low usefulness score or an instruction to delete. The future review contract must represent retain/defer separately from expose/discard and explain what evidence supports each decision. Deferral is not unlimited retention: the implementation contract must bound the retained portfolio and distinguish evidence deferral from deterministic safety rejection or explicitly admitted expiry/disposal. Missing usefulness evidence alone is not disposal authority; these limits do not weaken existing invalid/secret-touching rejection or grant new deletion permission. The exact persisted representation and review vocabulary require a concrete implementation contract; the diagram does not add action names to today's validators.

No automatic generalization or executable rewrite follows from review. Authoring a reusable capability from a one-off capture is a separate authorized change with explicit inputs, effects, and validation. Preserve the existing rule that an automatic executor derives unchanged executable content from its trusted capture.

## When a Tool Earns Its Name

Tool exposure is justified by a stable agent-facing contract, not workload duration or whether a model runs inside it:

- **Purpose:** A recognizable recurring outcome and a name/description supported by semantic evidence, rather than an opaque content-group identity or a guessed task label.
- **Inputs:** Caller-owned typed arguments and useful parameterization; no accidental commitment to a single captured prompt, temporary file, credential, installation path, or operator-specific mission.
- **Result:** A clear deliverable and acceptance boundary. For async tools, explicitly distinguish the launch receipt from terminal completion and the requested result.
- **Effects:** Understandable filesystem/network/service effects, authority requirements, and failure or cancellation limits. Registration does not grant new permissions; launch failure may leave effects, and a stop request is not proof of scope closure.
- **Leverage:** Meaningful reduction in repeated planning or orchestration compared with existing tools and ordinary Recipe spawning. A generic arbitrary-prompt launcher that merely aliases `actors_run_spawn` usually adds little.
- **Evidence:** Available validation, actual reuse, outcome acceptance, and uncertainty appropriate to the capability. Do not invent a universal call-count threshold or equate repeated launch attempts with successful reuse.

Examples are illustrative, not new registered tools:

- A parameterized async change-review capability can be a useful named tool: it launches a fresh reviewer Run and later returns the declared report.
- A one-off synchronous command with a fixed task path may be worth neither retaining nor exposing.
- A useful but infrequent pipeline may stay retained and be spawned intentionally without becoming a standing tool.
- A long-lived playback service may earn a launcher tool and declared Control without becoming a synchronous function.

A subagent-backed tool is a **capability launcher**, not a persisted live subagent or a handle to an old Run. Ordinary invocations create distinct executions; singleton compatibility and reuse remain owned by the existing Run contract. Registering every transient subagent, Run ID, or mission as a new tool defeats this distinction.

## Review Evidence and Confidentiality

Keep automatic review read-only and value-free. Structural evidence can support eligibility checks, contract-shape comparisons, and bounded prioritization; it is not a substitute for understanding the task. Content-equality groups prove only the equality represented by the capture, not semantic equivalence or interchangeability.

A future semantic evidence channel must have a separately reviewed provenance, privacy, size, and authority contract before use. Raw commands, prompts, descriptions, paths, outcomes, and purportedly sanitized summaries are not automatically safe reviewer inputs. An operator-reviewed capability description or accepted-outcome record is a possible design input, not an available trusted carrier today. Do not let actor-authored text become admission authority or let missing evidence force an irreversible discard.

Evaluate memory quality by useful accepted reuse and reduced reconstruction cost, balanced against tool-selection ambiguity, stale contracts, runtime/review cost, and accidental exposure. Those are evaluation goals, not currently collected metrics or a requirement to add telemetry. Validate the policy on bounded controlled fixtures before claiming better agent behavior.

## Ownership and Migration Constraints

Extend existing owners instead of creating a second execution kernel, tool registry, Recipe resolver, or parallel task list:

- **Recipe resolution/discovery:** Preserve exact Skill/file identity, imports, runtime-owned origins, validation, and the distinction between retained definitions and tool candidates. A non-tool library must remain reachable through an admitted existing Recipe execution path.
- **Registry/runtime:** Own explicit exposure, host activation, withdrawal limitations, and `callable_now` evidence. Existing explicit `actors_tool_register` intent remains valid for sync and async Recipes; the target policy does not silently prohibit either.
- **Draft/tool review and transactions:** Own evidence-limited recommendations, immutable captures, CAS, quarantine, journals, recovery, and admission of unchanged content. Retain/defer and withdrawal need explicit replay-safe transitions before changing automatic policy.
- **Usage/lineage:** Preserve revision and lifetime evidence across retention, exposure, withdrawal, and rollback without counting a migration as a launch or inventing successful outcomes.
- **Owning Skills:** Explain only implemented operations and approved selection guidance. Do not tell an agent to use a future library path, metadata flag, review action, or public command.

The retained directory, read-only discovery and initial create-only persistence/receipt contract are implemented. Retained updates/deletion, automatic transitions, aggregate retention bounds and the semantic evidence channel remain separate unresolved implementation choices. Prefer the smallest extension of current owners; do not add a new Recipe exposure field, database, service, or eager loading of every retained Recipe into the model context. Moving a Recipe can change relative imports and `{recipe_dir}` semantics: explicit retention needs an admitted source-preservation rule before any write, not a blind move from drafts or the tool root.

Existing user tools must not be silently demoted, deleted, renamed, generalized, or re-registered during adoption. Preserve executable bytes, delegated logical references, defaults, imports, Control, artifacts, runtime origins, usage, and recovery evidence. Prepare a read-only classification first; exact portfolio changes require an admitted migration contract and the authority applicable to that portfolio. Source tests or packaging do not authorize changes to the operator's live registry or reload the running host.

## Acceptance Properties

- **Orthogonality:** A useful async capability can be exposed; an unsuitable sync capture is not automatically exposed. Either mode can be retained without becoming a tool.
- **Evidence limits:** Structurally similar but semantically different Recipes cannot acquire an asserted purpose/usefulness solely from the same review shape. Unavailable semantic evidence stays explicit and can defer a decision without destructive loss.
- **Identity and replay:** Retain/expose/withdraw/recover preserve source and lineage, reject stale/conflicting plans, and do not create promotion/demotion churn or duplicate executable copies as new capabilities.
- **Invocation truth:** Explicit sync and async registration still works. Actual tool calls remain distinct from `actors_run_spawn`; launch, eventual result, singleton attachment, and current callability retain their original meanings.
- **Compatibility:** Source and packed-package journeys preserve existing safety and explicit-registration behavior before any automatic-policy migration. No test writes into the operator's registry.
- **Product evidence:** Controlled evaluation must distinguish accepted useful reuse and selection cost from mere growth in Recipe/tool counts. Until measured, improved "muscle memory" remains a design hypothesis, not a shipped performance claim.

## Related

- [Tool Registry](./tool-registry.md) — Current registration, discovery, activation, and automatic-review behavior.
- [Skill-Owned Recipe Components](./recipe-library.md) — Existing reusable components without automatic tool exposure.
- [Template Recipes](./template-recipes.md) — Recipe and execution contracts.
- [Project Backlog](../BACKLOG.md) — Canonical remaining implementation and acceptance work.
