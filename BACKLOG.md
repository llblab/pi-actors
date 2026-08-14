# Project Backlog

## 0.47.0 — Agent-Native Actor UX

**Base:** successful `0.46.1 — Registration Truth`  
**Release type:** focused UX / agent-protocol release; breaking public `register_tool` simplification is allowed  
**Primary UX evidence:** `PI_ACTORS_RECIPE_UX_SESSION_REPORT.md` plus the repaired runtime contract from `0.46.1`  
**Release sentence:** pi-actors becomes self-explanatory to agents: the injected system prompt only routes to bundled Skills, `actors` becomes the canonical operating protocol for Recipe/tool/Run work, capability Skills teach their own agent-facing entry points, and persistent Skill capabilities can be specialized and made callable through one explicit `register_tool from=...` workflow.

## Mission

Finish all important known **agent UX** work now.

There is no planned `0.48.0` UX cleanup pass.

`0.47.0` must leave a fresh agent able to:

```text
discover the right pi-actors Skill
→ choose the right capability
→ decide spawn vs persistent tool
→ specialize a maintained Skill Recipe
→ register it without copying its contract
→ understand activation truth
→ invoke the actual tool
→ distinguish tool call from spawn
→ diagnose resolver/registry failure
→ stop instead of inventing shell/path fallbacks
```

without reading:

```text
README
human docs
installed extension source
internal TypeScript
helper scripts
```

during normal use.

Human documentation remains useful for humans and maintainers.  
Bundled Skills are **instructions for agents**.

---

# 1. Agent Knowledge Architecture

The final authority structure is:

```text
Injected pi-actors system prompt
    │
    │  meta-protocol only
    │
    └── tells the agent which bundled Skill to load
            ↓
        actors
        │   main pi-actors operating protocol
        │
        ├── owning capability Skill
        │     artifacts
        │     media
        │     project-work
        │     recipe-memory (internal/recovery-focused)
        │
        └── swarm
              additional protocol only for multi-actor work
```

Authority:

```text
system prompt
  = routing + invariants + stop rules

actors Skill
  = generic pi-actors operational semantics
    Recipe/tool/Run/Trace/Control
    persistent capability workflow
    diagnosis workflow

owning capability Skill
  = when and how to use that capability pack's Recipes

swarm Skill
  = decomposition, parallelism, reviewer lenses,
    quorum, integration, multi-actor methodology

source/docs
  = implementation/debugging evidence, not normal agent usage instructions
```

Do not create a separate `capability-authoring` Skill.

---

# 2. System Prompt Contract

The extension-injected system prompt must **not** be condensed product documentation and must not replace Skill descriptions or bodies.

It must not teach:

```text
command-template flag inventory
placeholder grammar
Recipe DSL field inventory
Trace storage limits
Control wire sizes
watcher mechanics
Run state file layout
review scheduler thresholds
release mechanics
full capability catalog
```

Those belong to Skills or implementation docs.

The injected prompt is a stable meta-protocol.

It should communicate only materially durable behavior:

1. pi-actors ships operational Skills; Skills are the agent authority.
2. For non-trivial pi-actors work, load/read `actors`.
3. For multi-actor decomposition/review/parallelism/integration, additionally load/read `swarm`.
4. When using a capability pack, use its owning Skill for capability-specific semantics.
5. Skill Recipe is not a registered tool.
6. `spawn` is not a tool invocation.
7. Persisted/registered is not equivalent to callable unless runtime activation says so.
8. Prefer logical Recipe reuse; never copy a maintained Recipe contract/helper path to bypass resolution.
9. If pi-actors surfaces disagree, stop and diagnose rather than introducing shell/path/background workarounds.
10. Human docs/source are fallback for implementation debugging, not normal use.

The exact copy should be compact and version-stable.

---

# 3. `actors` as the Root Agent Protocol

`skills/actors/SKILL.md` becomes the canonical first read for all non-trivial pi-actors usage.

It should answer in this order:

```text
What operation am I trying to perform?
Which pi-actors primitive owns that operation?
What exact tool/Skill should I use?
What evidence proves success?
When must I stop?
```

The first major section must be an operational router, not ontology prose.

Canonical decision skeleton:

```text
Need to run a maintained capability once?
→ spawn recipe=<skill>/<recipe>

Need a persistent agent-callable tool?
→ register_tool from=<skill>/<recipe>

Need the same capability with narrower defaults?
→ register_tool from=<skill>/<recipe> defaults={...}

Need a reusable multi-node execution graph?
→ author/compose a Recipe with imports

Need a long-lived controlled process?
→ spawn async Recipe, then message/inspect

Need several independent actors/subagents?
→ also read swarm

Need capability-specific semantics?
→ read the owning capability Skill

Need to diagnose resolution/activation?
→ use existing inspect doctor/status flows
```

Then the Skill teaches semantic invariants and stop rules.

---

# 4. Core Agent Invariants

The following must be explicit near the top of `actors`:

```text
Skill Recipe ≠ registered tool
spawn ≠ tool invocation
persisted ≠ callable
direct delegation ≠ named import composition
Run Control ≠ actor chat
```

Required stop rules:

```text
If spawn and registry resolve the same Recipe differently:
  stop and diagnose.

If registration persists but activation is false:
  do not call spawn and claim tool invocation.

If maintained Recipe delegation fails:
  do not copy args/defaults/Control/artifacts/helper command.

Do not hard-code {skill_dir} replacement paths.

Do not introduce bash -lc, eval, direct helper execution,
or shell backgrounding as recovery for pi-actors resolution failure.

If a requested operation cannot be proven through pi-actors surfaces:
  report the blocker and preserve the intended logical composition.
```

These are behavior constraints, not human cautionary notes.

---

# 5. Agent-Native Persistent Tool Authoring

## 5.1 Final `register_tool` modes

The public tool should make Recipe specialization explicit.

For Recipe-backed registration:

```text
register_tool
  name=music_player
  from=media/player
  defaults={"source":"~/Music/1MIX"}
```

For explicit file Recipe:

```text
register_tool
  name=local_review
  from=./review.json
```

For command-template registration:

```text
register_tool
  name=repo_check
  template="make check"
  description="Run repository checks"
```

`from` and `template` are different modes.

Do not make an agent infer that a string in `template` sometimes means command text and sometimes Recipe delegation.

## 5.2 `from` semantics

`from` accepts the canonical Recipe reference grammar:

```text
<skill>/<recipe>
explicit/path.json
explicit/path.md
```

`from` means:

> create a persistent user tool that logically delegates to this maintained Recipe.

It inherits:

```text
async
args
arg types
source defaults
artifacts
Control
runtime-owned origins
```

The registration may narrow caller defaults and description without copying inherited contract fields.

## 5.3 `defaults`

Add public:

```json
"defaults": {
  "source": "~/Music/1MIX"
}
```

For `from` mode:

- every key must be a caller-owned arg in the effective source contract;
- value must pass the source type/enum validator;
- runtime-owned values cannot be defaulted;
- defaults change required/optional status in generated tool schema.

For command-template mode:

- defaults apply to declared/inferred template args.

## 5.4 Simplify ambiguous inputs

Audit current public `register_tool` fields.

Preferred final surface:

```text
name
description
from
template
defaults
args
async
draft
update
```

`values` should be removed from the public authoring tool unless there is a demonstrated agent-facing use that cannot be expressed by `defaults` or a Recipe file.

Rules:

- new registration uses exactly one of `from`, `template`, or `draft`;
- `description` may inherit from source Recipe in `from` mode;
- `description` remains required for raw command-template mode unless an existing safe fallback is intentional;
- `async` is inherited in `from` mode and should not need repetition;
- `args` are inherited in `from` mode and should not need repetition;
- direct deletion behavior remains compact and explicit; avoid adding a separate delete tool.

Persisted `from` registration still writes canonical compact Recipe representation, e.g.:

```json
{
  "description": "Play local music.",
  "defaults": {
    "source": "~/Music/1MIX"
  },
  "template": "media/player"
}
```

`from` is agent-facing API clarity, not a new Recipe schema field.

---

# 6. Direct Delegation vs Imports

The `actors` Skill must teach this distinction operationally.

## Direct specialization/delegation

Use when the user tool is fundamentally the same capability with narrower defaults or user-facing naming:

```text
media/player
→ music_player with default source
```

Agent action:

```text
register_tool from=media/player ...
```

Result:

- root async contract inherited;
- root Control inherited;
- args/types inherited;
- artifacts inherited.

## Named import composition

Use only when building a Recipe execution graph containing reusable named nodes:

```json
{
  "imports": {
    "review": "swarm/quorum-review",
    "report": "artifacts/report"
  },
  "template": [{ "name": "review" }, { "name": "report" }]
}
```

An imported child node does not automatically make its Control contract the root Run's Control contract.

The agent should not use imports merely to wrap one Recipe with defaults.

---

# 7. Agent-Facing Diagnostic UX

Keep existing public `inspect` target ontology.

Do not add:

```text
recipe:<identity>
inspect invoke
```

Extend existing Recipe inspection with optional identity filter:

```text
inspect target=recipes view=doctor identity=media/player
```

Focused result should answer:

```text
is the Skill active?
is the exact component resolvable?
is the catalog partial?
is this component rejected?
what logical identity owns it?
what portable location owns it?
what resolution generation is active?
what are the next safe actions?
```

For a user tool:

```text
inspect target=tool:music_player view=status
```

must answer:

```text
persisted?
registry active?
host registered?
active tool?
callable now?
source Recipe identity?
effective schema summary?
tool calls?
spawn calls?
last launch kind?
```

Do not require an agent to inspect raw registry JSON or source files.

Errors should include bounded `next_actions` using current public surfaces.

---

# 8. Skill Design Policy: Instructions for Agents

Every shipped `SKILL.md` is written for an agent.

Remove or relocate human-oriented material such as:

```text
installation instructions
developer build commands
release procedure
README/doc navigation for ordinary use
human UI walkthrough
marketing/product explanation
historical narrative not needed for decisions
```

Agent Skills should use imperative operational language:

```text
When ...
Use ...
Prefer ...
Inspect ...
Do not ...
Stop if ...
```

Examples are tool/Recipe actions an agent can actually perform.

Human documentation stays under:

```text
README.md
docs/
AGENTS.md where it is implementation protocol
```

Skill-local `references/` are also agent instructions, not copies of human docs.

---

# 9. Skill Routing Descriptions

Skill descriptions are routing metadata for agents and must say **when to use the Skill**, not summarize the product.

Target intent:

## `actors`

```text
Required operating protocol for non-trivial pi-actors work. Use for Recipes,
persistent tools, spawn/message/inspect, Runs, Trace, Control, capability
specialization, activation diagnosis, or changes to pi-actors mechanics.
```

## `swarm`

```text
Use after actors when work needs multiple actors/subagents, decomposition,
parallel scopes, reviewer lenses, quorum, merge/integration, or multi-agent
coordination.
```

## `media`

```text
Use for pi-actors media capabilities such as local playback, media-library
processing, and playlist workflows.
```

## `artifacts`

```text
Use when pi-actors work must create, write, summarize, manifest, or bundle
durable artifacts.
```

## `project-work`

```text
Use for repository/project capabilities such as repo health, documentation
maintenance, release readiness, Git/changelog evidence, and project summaries.
```

## `recipe-memory`

```text
Internal/recovery protocol for pi-actors automatic Recipe/tool memory review.
Use only when diagnosing or operating automatic capability-memory review.
```

Exact text may be improved, but routing boundaries must remain this clear.

---

# 10. Capability Skill Structure

Capability Skills should not duplicate generic pi-actors mechanics from `actors`.

Each should contain:

1. **Use when** — task triggers.
2. **Primary entry Recipes** — stable agent-facing entry points only.
3. **Selection rules** — which Recipe to choose.
4. **Capability-specific inputs/constraints** that materially affect choice.
5. **Persistent-tool note** — point back to `actors` workflow rather than re-teaching registration.
6. **Stop/failure rules** specific to the capability.
7. Optional `references/` for deeper agent-only material.

Do not list every internal component in the main Skill if it hurts routing.

Internal composed Recipes remain discoverable through `inspect recipes` and source metadata.

---

# 11. `actors` Skill Structure

Target shape:

```text
skills/actors/
├── SKILL.md
└── references/
    ├── recipes.md
    ├── persistent-tools.md
    ├── runs.md
    └── diagnostics.md
```

The exact split may be compressed, but `SKILL.md` should stay decision-first.

Required sections:

```text
# Actors

## Choose the operation
## Core distinctions
## Persistent capability workflow
## Run workflow
## Diagnosis and stop rules
## When to read another Skill
```

Detailed syntax moves to references.

The Skill should not link the agent out to human README/docs for normal execution.

---

# 12. `swarm` Skill Role

Keep `swarm` as the only major methodology branch from `actors`.

Audit/compress existing Skill so it does not re-teach generic Run/Recipe mechanics.

`swarm` owns:

```text
decomposition
task/scoped delegation
parallelism
reviewer lenses
quorum
conflict handling
integration/merge
coordinator responsibilities
completion/stop rules for multi-agent work
```

`actors` owns:

```text
how to spawn/inspect/control Runs
how to make persistent tools
how Recipe resolution works
how activation is proven
```

Cross-reference semantically:

```text
actors → read swarm for multi-actor work
swarm  → assumes actors mechanics
```

Do not add swarm runtime concepts to kernel.

---

# 13. System Prompt / Skill Precedence

The meta-protocol must teach conflict resolution:

```text
Generic pi-actors mechanics
→ actors

Capability-specific semantics
→ owning capability Skill

Multi-actor methodology
→ swarm

Implementation/debugging of extension itself
→ project AGENTS/source/tests, after actors
```

If a capability Skill appears to contradict `actors` about spawn, registration, activation, Control, or Recipe identity, treat `actors` as generic mechanics authority and report stale capability Skill.

If `swarm` conflicts with `actors` on kernel mechanics, `actors` owns mechanics; `swarm` owns methodology.

---

# 14. Agent-Safe Recovery Protocol

The agent-facing knowledge layer must encode failure behavior learned from the report.

When a pi-actors operation fails:

```text
1. Keep the intended logical capability/reference.
2. Read/use actors diagnosis instructions.
3. Inspect existing pi-actors surfaces.
4. Report resolver/registry/activation truth.
5. Retry only after owning state is healthy.
```

Never recover by:

```text
copying maintained Recipe args/defaults/Control/artifacts
hard-coding extension installation paths
directly invoking bundled helper scripts
adding bash -lc
adding eval
backgrounding with shell
calling spawn and claiming a tool call
editing unrelated Skills unless user asked to repair them
```

This must appear in `actors`, not only human docs.

---

# 15. Work Items

## AUX-00 — Freeze `0.46.1` truth and map remaining UX debt

**Goal:** ensure `0.47.0` works on repaired mechanics, not around them.

**Work:**

- Verify `0.46.1` release identity/runtime acceptance.
- Re-run original media/player journey using low-level `0.46.1` interface.
- Map every report item to:
  - mechanically closed in `0.46.1`;
  - agent UX owned by `0.47.0`;
  - intentionally not a defect.
- Inventory:
  - injected system prompt;
  - six Skill descriptions;
  - all six `SKILL.md`;
  - Skill-local references;
  - `register_tool` public schema/copy;
  - relevant Inspect output/errors.
- Identify human-oriented text currently inside Skills.

**Closure:**

- No runtime bug is assigned to prose.
- Every remaining report-derived UX failure has an owner here.

**Dependencies:** released `0.46.1`.

---

## AUX-01 — Replace injected prompt with Skill-loading meta-protocol

**Goal:** stop using global context as condensed documentation.

**Work:**

Rewrite `ONBOARDING_SYSTEM_PROMPT` around section 2.

Must:

- route non-trivial pi-actors work to `actors`;
- route multi-actor work additionally to `swarm`;
- tell agents to use owning capability Skill;
- state Skill Recipe vs tool;
- state spawn vs tool invocation;
- state activation truth;
- state no-bypass stop rule;
- state source/human docs are not normal operational guidance.

Remove:

- detailed command-template flags;
- placeholder syntax;
- low-level file paths/state mechanics;
- watcher details;
- review thresholds;
- full Run mechanics;
- capability catalogs.

Add focused semantic tests, not style/length gates.

**Closure:**

- Fresh session receives routing/invariants, not manual.
- Future Recipe DSL additions do not require prompt edits unless semantic routing changes.

**Dependencies:** AUX-00.

---

## AUX-02 — Redesign `actors` as main agent operating protocol

**Goal:** make one Skill sufficient to choose and correctly execute generic pi-actors operations.

**Work:**

- Rewrite `skills/actors/SKILL.md` decision-first.
- Add canonical Choose-the-operation router.
- Add core distinctions and stop rules.
- Add one full persistent capability workflow.
- Add Run workflow:
  - spawn;
  - wait;
  - inspect when needed;
  - message for declared Control;
  - completion evidence.
- Teach direct delegation/specialization vs imports.
- Teach activation proof.
- Teach spawn vs tool-call evidence.
- Teach failure protocol.
- Remove human docs navigation from normal path.
- Move syntax-heavy details into Skill-local references.
- Preserve agent-useful kernel safety constraints.

Canonical scenario:

```text
Goal:
  make media/player persistent as music_player
  default source ~/Music/1MIX

Agent path:
  read actors
  read media if capability semantics needed
  register_tool from=media/player defaults=...
  require callable_now
  call actual music_player tool
  verify launch_kind=tool
```

**Closure:**

- Agent does not need README/source for scenario.
- `actors` remains single root Skill; no capability-authoring Skill.

**Dependencies:** AUX-01.

---

## AUX-03 — Add final agent-native `register_tool from=...` interface

**Goal:** make common Skill Recipe → persistent tool operation obvious.

**Work:**

Implement section 5.

Add:

```text
from
defaults
```

Rules:

- exactly one source mode: `from`, `template`, or `draft`;
- `from` uses canonical Recipe reference grammar;
- source description may be inherited;
- async/args/types/artifacts/Control inherited;
- wrapper defaults validated against source;
- persisted Recipe remains compact direct delegation;
- registration returns `0.46.1` truthful activation projection;
- generated schema is effective caller schema.

Audit/remove `values` from public `register_tool` if no indispensable agent-facing use remains.

Improve parameter descriptions for model selection.

Detect/reject old malformed nested Recipe-shaped object with guidance:

```text
To specialize an existing Recipe, use from=<skill>/<recipe> and defaults={...}.
```

**Closure:**

Intended task is expressible as:

```text
register_tool
  name=music_player
  from=media/player
  defaults={"source":"~/Music/1MIX"}
```

without repeating async/args/Control or using bundled implementation paths/shell.

**Dependencies:** AUX-02.

---

## AUX-04 — Make registration result self-verifying for agents

**Goal:** remove follow-up guesswork.

**Work:**

Compact `register_tool` result surfaces:

```text
tool
source
persisted
registry_active
callable_now
effective required args
effective optional args
activation boundary if not callable
next safe action
```

Do not dump full internal config.

When callable, agent can call actual tool next.

When not callable:

- state exact activation requirement;
- never suggest spawn as substitute for proving tool invocation.

For source/delegation errors:

- show logical source identity;
- show current active Skill availability;
- suggest focused Recipe doctor.

**Closure:**

- Agent determines success from registration result.
- "persisted therefore callable" inference is unnecessary.

**Dependencies:** AUX-03.

---

## AUX-05 — Add focused Recipe-resolution diagnosis to existing Inspect

**Goal:** make troubleshooting first-class without new target ontology.

**Work:**

Extend:

```text
inspect target=recipes view=doctor identity=media/player
```

Return bounded:

```text
identity
skill_active
resolvable
catalog_partial
component_status
portable source location
resolution_generation
rejected reason if applicable
next_actions
```

Enhance:

```text
inspect target=tool:music_player view=status
```

with final activation/source/usage fields from `0.46.1`.

Keep schema view as effective caller contract.

Do not add invocation to Inspect.

**Closure:**

- Exact questions from report are answerable through public Inspect.
- Agent does not need registry/source spelunking.

**Dependencies:** AUX-03.

---

## AUX-06 — Rewrite capability Skill descriptions as routing triggers

**Goal:** make Pi Skill metadata enough to choose owner.

**Work:**

Rewrite descriptions for:

```text
actors
swarm
artifacts
media
project-work
recipe-memory
```

Rules:

- description begins from use conditions;
- no marketing/history;
- no implementation detail;
- `recipe-memory` clearly internal/recovery-focused;
- capability descriptions do not duplicate `actors` mechanics.

Add focused tests/snapshots for six descriptions because they are agent-routing API.

**Closure:**

- Model seeing only active Skill metadata can distinguish owners.

**Dependencies:** AUX-01.

---

## AUX-07 — Rewrite capability Skills for agents

**Goal:** make owning Skills operational and compact.

**Work:**

### media

Teach selection among:

```text
media/player
media/library
media/playlist-build
media/playlist-scan
```

Include controlled-service nature, persistence pointer to actors, path expectations, stop rules.

### artifacts

Teach:

```text
artifacts/bundle
artifacts/report
artifacts/write
artifacts/manifest
artifacts/file-write
```

by desired durable-output outcome.

### project-work

Teach primary entries:

```text
project-work/repo-health
project-work/docs-maintenance
project-work/release-readiness
project-work/release-summary
project-work/run-ops
```

Treat git/changelog helpers as supporting/internal unless direct use is useful.

### recipe-memory

Teach only:

- automatic Recipe/tool review diagnosis/recovery;
- runtime Controls/Inspect surfaces;
- internal review Recipes are not ordinary user capabilities.

For every Skill:

- remove human install/development/release guidance;
- remove generic Recipe/Run mechanics owned by `actors`;
- point back to `actors` semantically, not human docs;
- move deep agent detail to Skill-local references if needed.

**Closure:**

- Capability Skills help choose/use capabilities without becoming generic manuals.

**Dependencies:** AUX-02, AUX-06.

---

## AUX-08 — Refactor `swarm` around `actors`

**Goal:** keep one clean methodology branch.

**Work:**

- Audit `swarm` for duplicated Run/Recipe mechanics.
- Assume `actors` for generic execution.
- Keep:
  - decomposition;
  - disjoint scopes;
  - parallelism;
  - reviewer lenses;
  - quorum;
  - conflict evidence;
  - merge/integration;
  - coordinator ownership;
  - completion/stop rules.
- Ensure examples use current Skill Recipe identities/public tools.
- Keep deep methodology in references.
- Remove human-facing explanation.
- First section answers when multi-actor execution is worth overhead.

**Closure:**

- `actors` + `swarm` compose without competing instructions.
- Swarm remains methodology outside kernel.

**Dependencies:** AUX-02, AUX-06.

---

## AUX-09 — Make errors teach the safe next action

**Goal:** align runtime diagnostics with agent protocol.

**Work:**

Audit high-frequency errors:

```text
inactive Skill
missing Skill Recipe
invalid wrapper default
duplicate Skill identity
catalog partial
user Recipe registry rejection
tool not active
tool not callable now
malformed register_tool mode
removed std:/skill:
removed Recipe.name
```

For each ensure:

- exact cause;
- logical identity;
- no false success;
- bounded next action through actors/Inspect/current tool;
- no suggestion to copy implementation or inspect raw source first.

Do not create generic error-policy framework; fix errors at owning domains.

**Closure:**

- Failure messages reinforce same behavior as `actors`.

**Dependencies:** AUX-03, AUX-05, AUX-07.

---

## AUX-10 — Separate agent Skills from human documentation

**Goal:** establish durable content ownership.

**Work:**

Audit all Skill files/references.

Move human-oriented content to:

```text
README.md
docs/
```

as appropriate.

Keep agent-operational content in Skills.

Update `AGENTS.md` ownership rule:

```text
README/docs = human-facing
Skills = agent-facing operating protocols
system prompt = Skill-routing meta-protocol
AGENTS/source/tests = implementation protocol/evidence
```

Do not make this a broad prose lint gate.

**Closure:**

- `actors` no longer sends normal-use agent to README/docs.
- System prompt no longer duplicates Skill description/body.
- Human docs remain complete independently.

**Dependencies:** AUX-07, AUX-08.

---

## AUX-11 — Agent journey acceptance suite

**Goal:** evaluate system the way an agent experiences it.

Create deterministic mechanical tests where possible and fresh-agent dogfood where model behavior is inherently involved.

### Journey A — One-off capability

Intent:

```text
play music from ~/Music/1MIX using maintained pi-actors capability
```

Expected:

```text
actors route
→ media capability
→ spawn media/player
```

No persistent tool unless requested.

### Journey B — Persistent capability

Intent:

```text
make media/player available as music_player with ~/Music/1MIX default, then use the new tool
```

Expected:

```text
actors
→ register_tool from=media/player defaults=...
→ callable_now=true
→ actual music_player tool call
→ launch_kind=tool
```

Forbidden:

```text
copied Recipe
bash -lc
helper path
spawn claimed as tool invocation
```

### Journey C — Resolver degradation

Inject unrelated invalid Skill Recipe.

Expected:

```text
media/player remains resolvable
catalog partial diagnostic
registration succeeds if source valid
agent does not edit unrelated Skill automatically
```

### Journey D — Target unavailable

Make `media` inactive.

Expected:

```text
focused diagnostic
agent stops/reports blocker
no shell/direct implementation fallback
```

### Journey E — Multi-actor review

Expected:

```text
actors root
→ swarm
→ current Run primitives
```

No room/chat/task-tree kernel invention.

### Journey F — Project workflow

Use `project-work/repo-health` or release readiness from owning Skill.

### Journey G — Artifact workflow

Use `artifacts` Skill based on durable-output intent.

### Fresh-agent dogfood

At least one release-candidate session starts from packaged extension with no repository source context and completes Journey B without reading:

```text
README
docs/
lib/
scripts/
installed helper source
```

Session evidence should show Skill-driven behavior.

Model nondeterminism may make this a reviewed dogfood artifact rather than strict CI gate, but release closure requires a successful fresh-agent run.

**Closure:**

- Original UX report scenario succeeds through intended path.
- No known report lesson is only documented for humans.

**Dependencies:** AUX-09, AUX-10.

---

## AUX-12 — Prompt/Skill conformance tests

**Goal:** keep new knowledge architecture from regressing.

### Injected system prompt

Assert it:

- routes to `actors`;
- routes multi-actor work to `swarm`;
- states Skill Recipe vs tool;
- states spawn vs tool invocation;
- states no-bypass stop rule.

Assert it does **not** enumerate:

- command-template flag inventory;
- placeholder grammar;
- Trace/Control numeric limits;
- Run-state file layout.

### `actors`

Assert it contains:

- choose-operation router;
- persistent tool workflow using `from`;
- delegation vs imports;
- activation proof;
- stop rules;
- owning Skill/swarm routing.

### Capability Skills

Assert descriptions match routing owners and normal-use bodies do not require human docs.

Do not introduce generic writing-style/length gates.

**Closure:**

- Semantic routing contract catches accidental re-expansion or lost critical rules.

**Dependencies:** AUX-01, AUX-02, AUX-07, AUX-08.

---

## AUX-13 — Installed-package parity and first-use truth

**Goal:** make npm installation behave exactly like repository dogfood.

**Work:**

From packed/installed package:

- six Skills discovered with final descriptions;
- system prompt meta-protocol injected;
- `actors` and capability references packaged;
- `register_tool from=media/player defaults=...` works;
- effective schema matches source;
- same-session activation matches `0.46.1`;
- focused Recipe doctor works;
- actual registered tool call recorded;
- no source-only paths required;
- `.agents/` remains unshipped.

Validate first session after installation, not only reload after prior cache.

**Closure:**

- Easiest path in source is also easiest path for real npm agent.

**Dependencies:** AUX-11, AUX-12.

---

## AUX-14 — Close all known agent UX debt from the report

**Goal:** explicitly prevent "we'll fix the rest in 0.48".

Map report findings:

| Report failure                           | Final owner                                    |
| ---------------------------------------- | ---------------------------------------------- |
| registration success but not callable    | `0.46.1` truth + `0.47` result UX              |
| spawn/register resolution disagreement   | `0.46.1`                                       |
| malformed wrapper silently accepted      | `0.46.1` validation + `0.47 from` API          |
| offline QA vs live registry disagreement | `0.46.1`                                       |
| one invalid Skill empties catalog        | `0.46.1`                                       |
| unclear registry recovery state          | `0.46.1` observability + `0.47` focused doctor |
| runtime placeholders leak                | `0.46.1`                                       |
| types degrade                            | `0.46.1`                                       |
| persisted vs callable ambiguity          | both                                           |
| spawn vs tool invocation confusion       | `0.46.1` evidence + `0.47 actors`              |
| copied fallback Recipe/shell             | `0.47 actors` stop rules                       |
| absolute-path workaround pressure        | `0.47` capability guidance/errors              |
| direct delegation vs imports confusion   | `0.47 actors`                                  |
| source/docs spelunking for normal use    | `0.47` knowledge architecture                  |

Review every report acceptance criterion and mark closed with code/test/Skill evidence.

Do not create `0.48` placeholder for any row above.

**Closure:**

- No material agent UX issue from report remains unowned.
- Remaining future work is new capability/product direction, not cleanup.

**Dependencies:** AUX-13.

---

## AUX-15 — Release `0.47.0`

**Goal:** ship completed agent-native knowledge and authoring interface.

**Work:**

- Update version/changelog after closure.
- Cover:
  - system prompt as Skill meta-protocol;
  - actors root protocol;
  - `register_tool from/defaults`;
  - capability Skill routing;
  - focused diagnosis;
  - safe recovery rules;
  - agent-journey dogfood.
- Reset backlog:

```text
# Project Backlog

No open items.
```

Run:

```bash
npm ci
npm run validate
npm run test:preservation
npm run audit:dependencies
```

Run Domain DAG if implementation ownership changed.

Run fresh-agent packaged Journey B and retain evidence.

Publish through secure npm/GitHub release flow.

**Release decision:**

Do not release unless a fresh agent can satisfy:

> I know that the pi-actors system prompt only routes me to operational Skills. For non-trivial pi-actors work I use `actors`; for multi-actor methodology I additionally use `swarm`; for capability-specific behavior I use the owning Skill. I can run a Skill Recipe with `spawn`, turn it into a persistent callable tool with `register_tool from=... defaults=...`, prove activation before claiming success, invoke the actual tool, and diagnose failure through pi-actors surfaces without copying maintained Recipes, reading implementation source, hard-coding helper paths, or substituting shell execution.

**Dependencies:** all previous AUX tasks.

---

# 16. Dependency Graph

```text
released 0.46.1
      ↓
    AUX-00
      ↓
    AUX-01
      ↓
    AUX-02
      ├── AUX-03
      │     ↓
      │   AUX-04
      │     ↓
      │   AUX-05
      │
      └── AUX-06
            ├── AUX-07
            └── AUX-08

AUX-03 + AUX-05 + AUX-07 + AUX-08
      ↓
    AUX-09
      ↓
    AUX-10
      ↓
    AUX-11

AUX-01 + AUX-02 + AUX-07 + AUX-08
      ↓
    AUX-12

AUX-11 + AUX-12
      ↓
    AUX-13
      ↓
    AUX-14
      ↓
    AUX-15
```

Integration hotspots:

```text
lib/prompts.ts
lib/tools-register.ts
lib/registry.ts
lib/tools-inspect.ts
lib/tools-local.ts
skills/actors/SKILL.md
skills/actors/references/*
skills/swarm/SKILL.md
skills/swarm/references/*
skills/artifacts/SKILL.md
skills/media/SKILL.md
skills/project-work/SKILL.md
skills/recipe-memory/SKILL.md
```

Use one owner for system-prompt + `actors` semantics so they do not duplicate or contradict.

---

# 17. Required UX Test Matrix

| Intent                         | Expected agent route                          |
| ------------------------------ | --------------------------------------------- |
| Understand pi-actors operation | load `actors`                                 |
| Run capability once            | `spawn recipe=<skill>/<recipe>`               |
| Persist capability             | `register_tool from=<skill>/<recipe>`         |
| Narrow defaults                | `defaults={...}`; no copied contract          |
| Compose graph                  | Recipe imports                                |
| Long-running service           | spawn + message/inspect                       |
| Multi-actor task               | actors + swarm                                |
| Capability-specific choice     | owning Skill                                  |
| Registry mismatch              | focused Inspect diagnosis; stop               |
| Tool not callable              | honor activation state; no spawn substitution |
| Delegation failure             | no helper/shell fallback                      |
| Actual tool invocation         | usage says `tool`                             |
| Spawn                          | usage says `spawn`                            |
| Broken unrelated Skill         | valid target still works, partial diagnostics |
| Installed package first use    | same route as source                          |

---

# 18. No Known UX Deferral to `0.48.0`

`0.48.0` has no assigned cleanup from this plan.

Potential future releases may explore genuinely new directions:

```text
Recipe fitness/outcome learning
remote/cross-machine execution
versioned capability dependencies
new capability packs
stronger automatic capability evolution
```

But these are **not** future work after `0.47.0`:

```text
basic Skill routing
Recipe-vs-tool understanding
spawn-vs-tool-call understanding
persistent wrapper creation
delegation-vs-import understanding
activation truth
focused resolution diagnosis
safe recovery behavior
human-doc vs agent-Skill ownership
```

---

# 19. Negative Scope

Do not add merely for UX:

```text
capability-authoring Skill
new Run noun
new Run view
new generic invoke tool
recipe:<identity> target
actor chat
task-tree kernel
model router
remote registry
compatibility std:/skill: layer
copied Recipe wrappers
shell recovery path
massive injected system prompt
human README duplicated into Skills
```

---

# 20. Stop Conditions

Stop and revise rather than adding more guidance if:

- `register_tool from` cannot use the effective-contract/admission path from `0.46.1`;
- system prompt must explain low-level DSL for agent to choose correct Skill;
- capability Skills require duplicating generic `actors` mechanics;
- fresh-agent Journey B still requires source/docs;
- agent receives `callable_now=true` but cannot actually call tool;
- error recovery still incentivizes copying maintained Recipe or shell;
- workflow only becomes understandable by adding another Skill between `actors` and capability Skills.

The product should become simpler at the agent boundary, not merely better documented.
