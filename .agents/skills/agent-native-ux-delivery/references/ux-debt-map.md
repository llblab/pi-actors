# 0.47.0 Agent UX Baseline

Use this map to prevent `0.47.0` guidance from compensating for already-repaired mechanics or losing an agent-facing owner.

## Mechanical floor frozen at 0.46.1

The published `v0.46.1` / npm `@llblab/pi-actors@0.46.1` contract already proves:

- one immutable live Recipe resolution context across spawn, registry admission/reload, registration, schema, and Inspect;
- effective direct-delegation admission before persistence, including inherited async, typed args/defaults, artifacts, Control, and runtime origins;
- runtime-owned inputs excluded from caller schemas;
- fail-soft Skill inventory independent from exact resolution;
- separate persistence, registry, host, active-tool, and callability evidence with rollback on failed activation;
- explicit `launch_kind` and separate tool/spawn usage in source and packed-package journeys.

Preserve this floor through `tests/registration-truth.test.ts`, registry/runtime/Inspect tests, and installed-package dogfood. Do not assign any item above to prose.

## Current agent-surface inventory

| Surface | 0.46.1 state | 0.47.0 debt owner |
| --- | --- | --- |
| Injected prompt | Routing meta-protocol directs agents to `actors`, `swarm`, and owning capability Skills while preserving only boundary/no-bypass guardrails; source and packed tests reject DSL/storage duplication | AUX-15 release gate |
| `actors` description/body | Decision-first root protocol owns operation routing, core distinctions, persistent-tool and Run workflows, safe diagnosis, and four Skill-local references without human-doc fallback; packed references are verified | AUX-15 release gate |
| `artifacts` | Routes durable-output outcomes across bundle/report/write/manifest/file-write with truthful write boundaries, path policy, and stop rules; final description is packed | AUX-15 release gate |
| `media` | Routes player/library/playlist-build/playlist-scan, teaches controlled playback, persistence ownership, path bounds, and stop rules; packed first-session tool journey passes | AUX-15 release gate |
| `project-work` | Routes five primary workflows, demotes narrow helpers to supporting use, and states evidence-only mutation/publication boundaries; final description is packed | AUX-15 release gate |
| `recipe-memory` | Restricts operation to automatic review diagnosis/recovery through public Inspect and runtime Controls; internal reviewers remain non-user capabilities in the package | AUX-15 release gate |
| `swarm` | Composes around `actors` as methodology only; final body, descriptions, and deep references are packed | AUX-15 release gate |
| Skill references | Skill-local references own generic operation and deep swarm methodology; packed paths are verified and README/docs independently retain human guidance | AUX-15 release gate |
| `register_tool` schema/result | Packed first-session `from=media/player defaults=...` preserves compact persistence, effective schema, same-session activation, and action-shaped results | AUX-15 release gate |
| Recipe Inspect | Packed focused doctor proves exact valid identity under a partial catalog with portable source and generation evidence | AUX-15 release gate |
| Tool Inspect | Packed status reports activation, logical source, effective args, next action, and separate spawn/tool usage | AUX-15 release gate |
| Errors | Source and packed diagnostics state exact cause and safe public next action without bypass substitution | AUX-15 release gate |
| Agent journeys | Source Journeys A-G plus reviewed fresh-agent dogfood and deterministic packed first-session parity all pass | AUX-15 release gate |

## Report finding ownership

### Mechanically closed in 0.46.1

- spawn/register live-context disagreement;
- offline QA poisoning live registry expectations at the mechanical boundary;
- malformed delegated contract acceptance before mutation;
- unrelated invalid Skill emptying valid exact resolution;
- runtime-owned placeholder leakage and caller type degradation;
- persistence reported as host callability;
- failed activation/update rollback;
- absent launch-kind and activation observability.

### Agent UX owned by 0.47.0

- global prompt acting as a product manual instead of a Skill router;
- no decision-first root operating protocol;
- ambiguous Recipe specialization through `template` and `values` rather than `from/defaults`;
- persistence, spawn, and tool invocation distinctions not being taught as first-order decisions;
- direct delegation versus named import composition confusion;
- capability Skill descriptions/bodies that do not route agent intent;
- no focused Recipe identity doctor or self-verifying registration next action;
- normal-use dependence on README/docs/source/helper inspection;
- recovery pressure toward copied contracts, absolute helper paths, shell evaluation, or backgrounding.

### Intentionally not defects

- Skill Recipes are components rather than automatic tools;
- spawn creates a Run rather than invoking a registered tool;
- user persistence remains under `~/.pi/agent/recipes`;
- direct delegation is distinct from named import composition;
- Run views remain Recipe, Trace, and Control;
- `inspect` gains no invocation mode or `recipe:` target;
- capability-specific instructions remain in owning Skills; multi-actor methodology remains in `swarm`;
- source/docs remain maintainer and human evidence rather than normal agent operating instructions.

## Human-oriented Skill debt observed

- `actors` sends normal-use agents to `docs/recipe-library.md`, `docs/async-runs.md`, repository source, and tests; it includes storage filenames and numeric retention/wire limits before task routing.
- `swarm` includes maintenance instructions, host-validation prose, abstract adapter/tool registration detail, a broad domain lens encyclopedia, and concrete Git worktree shell commands that require ownership review.
- Capability Skills use product-ownership descriptions (`Own reusable...`) instead of imperative use conditions and concrete entry selection.
- `recipe-memory` reads as package architecture rather than a strict internal diagnosis/recovery protocol.

## Selection rule

Use the backlog dependency graph. If a proposed UX edit repairs a mechanical contradiction listed in the frozen floor, stop and fix the owning runtime/test instead. If an edit duplicates generic mechanics across prompt, `actors`, capability Skills, or `swarm`, keep only the canonical owner.
