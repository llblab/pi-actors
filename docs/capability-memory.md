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

- `lib/tools-local.ts` awaits synchronous Recipe execution, but an async tool calls `startRun` and returns launch metadata. The eventual Actor result is separate; tool registration does not itself launch an Actor.
- `lib/async-runs.ts` also permits ordinary non-singleton Recipes without `async: true` through the public `spawn` path. The flag does not divide all capabilities into foreground-only and background-only classes.
- `lib/tools-spawn.ts` captures inline-template launches as drafts with `async: true`. It does not capture maintained/file Recipe launches through that draft path. Filtering automatic tool promotion to sync alone would exclude this existing capture stream; ordinary foreground commands are not automatically captured by that mechanism.
- `lib/runtime.ts` discovers the user Recipe root with `defaultTool: true`; `lib/recipes-discovery.ts` exposes valid enabled entries by location, not by sync/async. Active Skill components already demonstrate reusable Recipes without automatic tool exposure.
- `lib/draft-review.ts` admits only promote/discard decisions. `lib/draft-sleep.ts` derives promotion from unchanged immutable captured Recipe content. Review does not generalize a hard-coded mission into a new parameterized capability.
- `lib/review-projection.ts` gives automatic reviewers value-free contract shape, risk labels, usage counts, and batch-local content-equality groups. It excludes commands, descriptions, argument names/values, canonical names, and paths. Those observations cannot by themselves establish a capability's purpose, a meaningful semantic name, or future task usefulness.
- `lib/recipes-usage.ts` records launches and lineage, not successful task completion or the coordinator's acceptance of a useful result. A launch count is not outcome evidence; a command exit code alone would not prove task success either.

These are limits on the conclusions the current mechanism supports, not permission to bypass its confidentiality projection or discard its transaction protections.

## Read-Only Inventory Checkpoint

Retained definitions belong under `~/.pi/agent/recipes/library`; the tool root remains its existing direct `.json`/`.md` files. This separation also fails safely on older hosts whose nonrecursive tool discovery ignores the library directory, unlike an unknown opt-out field that an older host could ignore. No new Recipe field or logical-reference namespace is introduced.

Use the same management surface:

```text
inspect target=recipes view=summary
inspect target=recipes view=summary verbose=true
```

Compact output adds `retained` separately from root `active` candidates and drafts. Verbose/details contains `retained` rows with exact file paths, execution mode when the definition resolves, invalid/disabled state and diagnostics, plus `retained_diagnostics`. Root and retained definitions resolve in the same active Skill context. This read does not create directories, mutate Recipes/usage, register tools, or launch Actors. A stored row is not evidence of review, a callable tool, or a running Actor. Empty/missing library is an empty inventory, not an instruction to initialize one.

A valid enabled row's exact file path can be reused through existing `spawn recipe=<path>` with its required caller values, or explicitly specialized through existing `register_tool from=<path>`. Invalid/disabled entries remain visible for diagnosis, not recommended for execution. Running instances remain under `inspect target=runtime view=runs` and `run:<id>`; tool activation/schema remains under `tool:<name>`. The inventory is not an alternate Run or activation registry.

Use the explicit retention operation below rather than hand-populating the live registry or moving existing tools. Source/packed acceptance is separate from reloading an already running host; a loaded older tool schema does not acquire the new input automatically.

## Explicit Persistence Contract

Status: Implemented for explicit create-only retention; automatic lifecycle remains separate.

The existing `register_tool` persistence owner accepts an optional Boolean **input** `expose`. This is not a Recipe field or a new tool/registry. `kind: retained_recipe` and `activation: not_requested` distinguish successful retention from failed tool activation.

- **Omitted or true:** Preserve current tool-root persistence, source modes, update/delete behavior, activation and callability proof.
- **False:** Save a new named definition under `recipes/library/<name>.json` without requesting host registration, changing the active-tool set, or launching work. A name and exactly one `template` or `from` source are required. Apply existing name/reserved-name and effective typed-argument/default admission; sync/async is not a selection filter.
- **References, not relocation:** `from` persists the existing compact logical/file delegation, retaining the source's origins, imports, async, artifacts and Control. A retained wrapper is not a self-contained backup of its source. Reject direct references whose selected source is in managed disposable drafts rather than create an entry knowingly dependent on draft disposal. Apply the same owning resolver/lifetime check to Recipe-valued leaves in authored template graphs, not just the `from` spelling. This is not a transitive lifetime guarantee for arbitrary external files or their dependencies. `template` authors new content at its final library location. No existing Recipe is moved, rewritten or generalized.
- **Create-only first slice:** Retained `update=true`, null/empty-template deletion, and `draft` source mode fail before persistence. They need explicit source-preservation, CAS/recovery and dependency contracts before becoming supported; do not fall back to active-tool mutation. A duplicate retained stem in either JSON or Markdown is a conflict, not permission to shadow or overwrite it. A tool-root entry with the same stem remains a distinct entrypoint and is not modified.

Explicit flow (supply the capability's required caller values):

```text
register_tool name=changes_review from=swarm/lens-review expose=false
inspect target=recipes view=summary verbose=true
spawn recipe=<exact retained path> values=<caller-owned inputs>
register_tool name=changes_review from=<exact retained path>
```

The last step deliberately creates a compact wrapper in the ordinary tool root. It does not copy the executable graph or move the retained definition. `callable_now` and actual tool invocation still need the existing proof. Removing an admitted exposed wrapper through the existing deletion path leaves the retained source intact; this does not turn deletion of an old standalone tool into safe retention. Active Runs retain their original execution contract and are not stopped by wrapper withdrawal.

### Receipt and Failure Truth

A successful retain receipt must distinguish **retention** from failed activation: `kind: retained_recipe`, `result: retained`, `persisted: true`, `resolved: true`, `validated: true`, and `activation: not_requested`, plus the exact retained Recipe path and effective required/optional argument names. It must not claim a global `callable_now: false` or `active_tool: false`: a separately exposed tool with the same name may already be callable. The retained branch never calls the host registration/activation ports, and the receipt's next action is read-only Recipe inspection rather than repair/reload advice. This is an extension of the receipt contract, not reconstruction of missing host state.

Exact paths and selected metadata must use the existing whole-value YAML/omission budget, with full structured details preserved. No executable body, secret-bearing defaults, source installation root or invented semantic assessment is added to the receipt. Storage/validation do not prove review or useful task completion.

Preflight validates mode/type/source/size and resolves the effective contract before creating library state. The serialized candidate obeys the existing 1 MiB per-Recipe bound even when admission uses an in-memory authored candidate. Operation selection preserves the existing name/source guard order and releases its tool-name reservation before retention locks are acquired. Persistence uses the existing canonical mutation-lock/atomic-write owner, with root → library → target ordering, regular non-symlink files, root identity/containment rechecks and JSON/Markdown conflict detection at the commit boundary. Exclusive publication links complete staged bytes without overwriting a competing creator; an unsupported filesystem refuses without a replacement fallback. Do not infer filesystem sandboxing or hostile-writer exclusion from cooperative locks.

The first slice has no prior retained bytes to overwrite. It must preserve any competing/pre-existing entry and re-admit its own exact persisted candidate before returning success. Rollback may remove only its own proven unchanged candidate under the original root/target fences; an uncertain replacement, release or notification failure preserves effect uncertainty and original causes rather than blindly deleting or replaying. The retained failure boundary encloses the whole root-lock operation, including post-publication release; exact original or aggregate rejections remain its private cause. Ordinary registration keeps its existing rollback and callback behavior; the retained branch is not a reason to restyle or reorder unrelated guards.

Retention itself records no launch, success, review or fabricated usage. There is no automatic expiry, background retention loop or live portfolio migration in this slice. Aggregate retention bounds and expiry/disposal remain required before future automatic retention, not a reason to impose an arbitrary new tool-count quota now.

### One Usage Owner, Distinct Entrypoints

Library launches use the existing `.usage` owner under the parent Recipe root, not a second ledger root inside `library`. Private ledger identity is `library/<stem>` for retained entries and the existing stem for tool-root entries; this is not a new Recipe name or public `<skill>/<recipe>` reference. A root wrapper and retained definition may share a filename without merging their launch counters or rewriting each other's revision history. JSON/Markdown representations follow the same rule. Neither creating a definition nor exposing its wrapper is a launch.

Automatic same-source rename inference stays within the retained namespace or within the existing root/draft namespace; disappearance plus matching content cannot silently transfer lineage across the new boundary. Any future deliberate transition must use the existing explicit lineage move/transaction owner. Do not migrate pre-existing nested/legacy ledgers by guessing their ownership or manufacture missing counts; preserve them for separately admitted diagnosis/migration.

The management result is one coherent path: **save deliberately → find through existing Recipe inspection → reuse the exact Recipe reference → expose explicitly when useful → withdraw only the wrapper when appropriate**. This first contract does not adopt automatic retention/exposure, semantic review, retained updates/deletion, or conversion of existing tools/drafts.

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
- **Leverage:** Meaningful reduction in repeated planning or orchestration compared with existing tools and ordinary Recipe spawning. A generic arbitrary-prompt launcher that merely aliases `spawn` usually adds little.
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
- **Registry/runtime:** Own explicit exposure, host activation, withdrawal limitations, and `callable_now` evidence. Existing explicit `register_tool` intent remains valid for sync and async Recipes; the target policy does not silently prohibit either.
- **Draft/tool review and transactions:** Own evidence-limited recommendations, immutable captures, CAS, quarantine, journals, recovery, and admission of unchanged content. Retain/defer and withdrawal need explicit replay-safe transitions before changing automatic policy.
- **Usage/lineage:** Preserve revision and lifetime evidence across retention, exposure, withdrawal, and rollback without counting a migration as a launch or inventing successful outcomes.
- **Owning Skills:** Explain only implemented operations and approved selection guidance. Do not tell an agent to use a future library path, metadata flag, review action, or public command.

The retained directory, read-only discovery and initial create-only persistence/receipt contract are implemented. Retained updates/deletion, automatic transitions, aggregate retention bounds and the semantic evidence channel remain separate unresolved implementation choices. Prefer the smallest extension of current owners; do not add a new Recipe exposure field, database, service, or eager loading of every retained Recipe into the model context. Moving a Recipe can change relative imports and `{recipe_dir}` semantics: explicit retention needs an admitted source-preservation rule before any write, not a blind move from drafts or the tool root.

Existing user tools must not be silently demoted, deleted, renamed, generalized, or re-registered during adoption. Preserve executable bytes, delegated logical references, defaults, imports, Control, artifacts, runtime origins, usage, and recovery evidence. Prepare a read-only classification first; exact portfolio changes require an admitted migration contract and the authority applicable to that portfolio. Source tests or packaging do not authorize changes to the operator's live registry or reload the running host.

## Acceptance Properties

- **Orthogonality:** A useful async capability can be exposed; an unsuitable sync capture is not automatically exposed. Either mode can be retained without becoming a tool.
- **Evidence limits:** Structurally similar but semantically different Recipes cannot acquire an asserted purpose/usefulness solely from the same review shape. Unavailable semantic evidence stays explicit and can defer a decision without destructive loss.
- **Identity and replay:** Retain/expose/withdraw/recover preserve source and lineage, reject stale/conflicting plans, and do not create promotion/demotion churn or duplicate executable copies as new capabilities.
- **Invocation truth:** Explicit sync and async registration still works. Actual tool calls remain distinct from `spawn`; launch, eventual result, singleton attachment, and current callability retain their original meanings.
- **Compatibility:** Source and packed-package journeys preserve existing safety and explicit-registration behavior before any automatic-policy migration. No test writes into the operator's registry.
- **Product evidence:** Controlled evaluation must distinguish accepted useful reuse and selection cost from mere growth in Recipe/tool counts. Until measured, improved "muscle memory" remains a design hypothesis, not a shipped performance claim.

## Related

- [Tool Registry](./tool-registry.md) — Current registration, discovery, activation, and automatic-review behavior.
- [Skill-Owned Recipe Components](./recipe-library.md) — Existing reusable components without automatic tool exposure.
- [Template Recipes](./template-recipes.md) — Recipe and execution contracts.
- [Project Backlog](../BACKLOG.md) — Canonical remaining implementation and acceptance work.
