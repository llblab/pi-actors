# Project Backlog

## 0.46.1 — Registration Truth

**Base:** `0.46.0` at `4abe9b26525a57883446b1d897e9e1ddf6cacde5`  
**Release type:** patch / contract repair  
**Primary evidence:** `tests/registration-truth.test.ts`, distilled from `PI_ACTORS_RECIPE_UX_SESSION_REPORT.md`  
**Release sentence:** every live pi-actors surface resolves user Recipes against the same session Skill context, registration validates the effective delegated contract before persistence, activation is truthfully observable, and unrelated invalid Skill components can no longer poison valid capability discovery.

## Mission

Repair the runtime seams exposed by the first real `0.46.0` Skill-Recipe authoring session before redesigning agent guidance.

The intended operation was:

```text
maintained Skill Recipe
    media/player
        ↓ specialize
persistent user tool
    music_player
        ↓ activate
call in the same session
```

The session instead observed:

```text
spawn resolves media/player
standalone QA resolves media/player
register_tool cannot resolve media/player
live registry rejects the wrapper
one unrelated invalid Skill Recipe empties the catalog
runtime-owned placeholders leak into the tool schema
registry persistence is reported as registration success
spawn is mistakenly used as proof of tool invocation
```

`0.46.1` owns the mechanical truth required for `0.47.0` agent-native UX.

Do **not** solve these failures with more prose, compatibility aliases, copied Recipe contracts, helper paths, shell wrappers, or new orchestration concepts.

The target transaction is:

```text
current session
    ↓
one RecipeResolutionContext
    ↓
resolve candidate
    ↓
derive effective Recipe/tool contract
    ↓
validate candidate
    ↓
persist
    ↓
registry admission
    ↓
host registration + active-tool reconciliation
    ↓
verify activation
    ↓
return truthful state
```

---

# 1. Retained Canon

The `0.46.0` capability model remains authoritative:

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

Public Run verbs remain:

```text
spawn
message
inspect
```

Persistent capability mutation remains:

```text
register_tool
```

Run views remain:

```text
recipe
trace
control
```

Recipe references remain exactly:

```text
<skill>/<recipe>
explicit/path.json
explicit/path.md
```

Skill Recipe identity remains:

```text
<active Skill identity>/<direct Recipe filename stem>
```

Retain:

- six bundled Skill-owned capability packs;
- flat Skill `recipes/` directories;
- no root packaged Recipe library;
- no `std:` or `skill:` prefixes;
- no top-level file-backed Recipe `name`;
- session-scoped active Skill identity;
- runtime-owned `{recipe_dir}` and `{skill_dir}`;
- bounded Trace and Control;
- owner/generation/process fencing;
- automatic review transactions;
- secure npm publication;
- project-local Domain DAG Skill outside CI/release.

---

# 2. Contract

## 2.1 One live resolution environment

Every operation that decides whether a Recipe can be used in the live session must consume the same immutable session resolution environment.

Conceptually:

```ts
interface RecipeResolutionContext {
  session_id: string;
  cwd: string;
  active_skills: ActiveSkillRecipeContext;
  generation: string;
}
```

The exact internal type may be smaller, but there must be one explicit owner and one semantic contract.

The following must not invent independent active-Skill contexts:

```text
spawn
register_tool candidate validation
user Recipe registry admission
user Recipe registry reload
tool schema derivation
inspect recipes
inspect tool
automatic review when resolving user wrappers
live Recipe validation used by registration
```

Standalone package QA may still construct an offline package context, but it must be labeled as offline/package QA and may not be represented as proof of live registry admission.

## 2.2 One user Recipe admission path

A user Recipe under:

```text
~/.pi/agent/recipes/<name>.json
```

is an active agent tool only if one authoritative admission function can:

1. parse the authored Recipe;
2. resolve its delegation/import graph with the live `RecipeResolutionContext`;
3. derive runtime-owned origins;
4. derive the effective argument/type/default contract;
5. classify async behavior;
6. validate Control/artifacts;
7. produce one `RegisteredTool` projection;
8. produce bounded diagnostics on failure.

`register_tool`, startup/reload discovery, and live revalidation must use this same admission contract.

Do not maintain one path that creates a `RegisteredTool` directly from `register_tool` input and another path that later interprets the persisted Recipe differently.

## 2.3 Registration is a state transition

A successful registration response must distinguish at least:

```text
resolved
validated
persisted
registry_active
host_registered
active_tool
callable_now
```

These states may all become `true` in the healthy path, but they are not synonyms.

Never return text that implies current-session invocation if the system cannot prove it.

## 2.4 Effective contract before mutation

A Recipe-backed tool must be validated from the **resolved effective contract**, not the shallow wrapper shape.

For:

```json
{
  "description": "Play local music.",
  "defaults": {
    "source": "~/Music/1MIX"
  },
  "template": "media/player"
}
```

the effective tool contract inherits from `media/player`:

```text
async
args
arg types
defaults
artifacts
Control
runtime-owned origins
```

without copying those fields into the authored wrapper.

The tool schema must contain only caller-owned inputs.

## 2.5 Partial catalog, exact resolver

The active Skill component catalog is diagnostic/discovery state.

It must never be required for exact resolution of an unrelated valid component.

An invalid:

```text
some-skill/bad-recipe
```

must not make:

```text
media/player
```

unresolvable merely because a catalog listing failed.

---

# 3. Runtime-Owned Inputs

The following are runtime-owned and must never leak into caller-facing tool schemas merely because they occur in an effective Recipe template:

```text
recipe_dir
skill_dir
state_dir
trace_file
run_instance_id
owner/session identity
runtime state root
```

`run_id` remains an intentional caller-visible optional override for async tool invocation if the existing public contract retains it.

The executor must inventory every runtime-injected placeholder and centralize ownership rather than maintaining ad hoc exclusion lists in unrelated schema code.

Declared user args retain their actual types:

```text
string
path
bool
int
number
enum
array
```

A delegated Recipe may not degrade them all to strings.

---

# 4. Activation Truth

`pi-actors` must determine what the Pi host can actually guarantee after dynamic `registerTool`.

Preferred contract:

```text
register_tool returns callable_now=true
→ host definition exists
→ tool is in the current active tool set
→ the next model step in the same session can call it
```

If the Pi host cannot guarantee that:

```text
register_tool returns callable_now=false
activation=<exact boundary>
```

and all prompts/docs must say so.

Do not infer model visibility from persistence or an extension-local map.

The implementation must test the real Pi integration path, not only mocked registration callbacks.

---

# 5. Registration Atomicity

For a new registration:

```text
candidate
→ resolve/validate without mutation
→ durable write
→ authoritative registry admission
→ host registration/activation
→ verification
```

If failure occurs before persistence, no user Recipe file appears.

If persistence succeeds but authoritative admission fails unexpectedly:

- restore/delete the just-written candidate under the canonical mutation lock;
- restore prior in-memory registry state;
- report the exact failed phase;
- do not leave an invalid file while returning generic success.

For updates:

- preserve the prior file bytes until replacement is known valid;
- do not destroy a working tool because the replacement cannot resolve;
- retain existing CAS/path/symlink/mutation safety.

Host APIs that cannot unregister stale dynamic definitions must be explicitly accounted for. Validate as much as possible before host mutation.

---

# 6. Registry and Component Observability

Existing:

```text
inspect target=recipes view=status
inspect target=recipes view=summary
inspect target=recipes view=doctor
inspect target=tool:<name> view=status
inspect target=tool:<name> view=schema
```

remain the public surfaces.

Do not add a new `recipe:` target in this patch.

Recipe registry inspection must expose bounded current state such as:

```text
registry_generation
scanned_at
resolution_generation
watch_status
user_recipe_count
active_tool_count
skill_component_count
rejected_skill_component_count
catalog_partial
```

Rejected Skill components must be reported individually with:

```text
skill
stem if derivable
portable file location
reason
```

Use portable paths such as:

```text
~/.pi/agent/skills/...
<pi-actors>/skills/...
```

rather than raw home-directory leakage.

`inspect tool:<name> view=status` must expose activation state where it can be proven.

---

# 7. Fail-Soft Skill Component Discovery

Refactor active Skill component listing so it returns valid entries and failures together.

Conceptually:

```ts
interface SkillComponentInventory {
  components: ActiveSkillRecipeComponent[];
  rejected: SkillComponentDiagnostic[];
  partial: boolean;
}
```

Rules:

- invalid top-level `Recipe.name` rejects that component;
- nested Recipe files reject those files/that namespace as appropriate;
- JSON/Markdown same-stem collision rejects that stem;
- one duplicate active Skill identity may invalidate that Skill namespace;
- unrelated Skill namespaces continue;
- every rejection is bounded and diagnosable;
- exact resolver remains independent and may resolve a valid exact component while catalog inventory is partial.

Do not silently omit bad components.

---

# 8. Launch-Kind Truth

Keep existing usage distinctions:

```text
tool
spawn
direct Recipe/foreground execution where applicable
```

At minimum:

- `spawn` result/details expose `launch_kind: "spawn"`;
- registered tool invocation evidence exposes `launch_kind: "tool"`;
- `inspect tool` usage summary distinguishes tool calls from Recipe spawn calls;
- no product copy describes `spawn recipe=<user-wrapper>` as invoking the registered tool.

Do not add a second generic invocation mechanism just for testing.

---

# 9. Work Items

## RGT-12 — Publish `0.46.1`

**Goal:** ship the prepared registration-truth release before agent UX redesign.

**State:** gated on explicit release intent and repository `ADMIN` authority.

**Remaining:**

- Run the existing guarded GitHub release flow for prepared version `0.46.1`.
- Verify npm package identity/provenance and GitHub Release convergence.
- After successful publication, reset this backlog to:

```text
# Project Backlog

No open items.
```

**Unblocker:** the operator explicitly authorizes the `0.46.1` release and confirms `ADMIN` permission for this repository.

**Dependencies:** none.

---

# 10. Dependency Graph

```text
RGT-12
```

Integration hotspots:

```text
lib/extension-runtime.ts
lib/recipes-references.ts
lib/recipes-discovery.ts
lib/runtime.ts
lib/registry.ts
lib/tools-register.ts
lib/tools-local.ts
lib/tools-inspect.ts
lib/schema.ts
lib/recipes-usage.ts
```

Use one integration owner for resolution/admission semantics.

---

# 11. Required Test Matrix

| Boundary               | Required evidence                                                 |
| ---------------------- | ----------------------------------------------------------------- |
| Live context           | spawn/register/registry/inspect share exact session Skill context |
| Session isolation      | no context bleed across sessions/replacements                     |
| Startup                | Skill-dependent user tools reconcile after active Skills known    |
| Watcher                | reload uses current context/generation, stale callback fenced     |
| Delegation             | compact wrapper inherits effective Recipe contract                |
| Invalid wrapper        | rejected before persistence with precise diagnostic               |
| Schema ownership       | runtime-owned values absent                                       |
| Schema types           | enum/bool/int/path/array retained                                 |
| Defaults               | wrapper overrides validated against effective types               |
| Catalog                | unrelated bad component yields partial inventory                  |
| Exact resolution       | valid component resolves despite unrelated rejection              |
| Registry observability | generation/time/watch/current counts available                    |
| Registration           | persisted/active/host/callable states separated                   |
| Rollback               | failed update preserves previous working tool                     |
| Pi host                | same-session injection proven or truthful limitation returned     |
| Launch kind            | tool vs spawn explicit in result/usage                            |
| Source/dist            | same behavior in repository and packed install                    |
| Security               | path/CAS/redaction/generation/review safety retained              |

---

# 12. Explicitly Deferred to `0.47.0`

Only the **agent interface/guidance layer** is deferred:

```text
register_tool from=<skill>/<recipe>
register_tool defaults={...}
system prompt redesign as Skill-loading meta-protocol
actors Skill redesign as root agent operating protocol
capability Skill description/entrypoint redesign
agent-facing delegation-vs-import decision guidance
focused resolution explanation UX
fresh-agent journey dogfood
human-doc vs agent-Skill separation cleanup
```

Do not defer any known runtime inconsistency from the report.

---

# 13. Negative Scope

Do not add:

```text
new Run nouns
new Run views
new generic invocation tool
new recipe target namespace
task graph runtime
actor chat
rooms/peers/mailboxes
remote Recipe registry
compatibility std:/skill: aliases
copied packaged Recipe wrappers
shell fallbacks
new capability-authoring Skill
large system-prompt rewrite
```

---

# 14. Stop Conditions

Stop and preserve evidence if:

- Pi cannot dynamically expose a newly registered tool in the same session and the product cannot observe the activation boundary;
- one authoritative user Recipe admission path cannot serve registry and `register_tool`;
- session-scoped Skill-dependent tools require global mutable state;
- rollback would overwrite concurrent user edits;
- schema ownership cannot distinguish runtime and caller values without changing Recipe semantics;
- fixing a failure appears to require copying a Skill Recipe contract into the user wrapper.

Resolve blockers at the owning boundary rather than hiding them with agent guidance.
