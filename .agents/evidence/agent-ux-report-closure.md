# 0.47.0 Agent UX Report Closure

This audit closes every material agent-UX finding carried from `PI_ACTORS_RECIPE_UX_SESSION_REPORT.md`. Evidence is retained in product code, packaged Skills, source/installed tests, and fresh-agent dogfood. No row is deferred to a hypothetical `0.48` cleanup release.

## Report failure matrix

| Report failure | Final owner | Retained evidence | Status |
| --- | --- | --- | --- |
| Registration success but not callable | Registry activation transaction and result UX | `lib/registry.ts`; `tests/registry.test.ts`; packed first-session test | Closed |
| Spawn/register resolution disagreement | Immutable live resolution context and authoritative admission | `lib/recipes-context.ts`; `lib/recipes-discovery.ts`; `tests/registration-truth.test.ts` | Closed |
| Malformed wrapper silently accepted | Effective delegated admission before mutation | `lib/recipes-references.ts`; `admitUserRecipe`; negative registration tests | Closed |
| Offline QA vs live registry disagreement | Exact live resolution independent from fail-soft catalog inventory | Recipe-reference/discovery tests; Journey C | Closed |
| One invalid Skill empties catalog | Partial inventory plus independent exact resolution | focused doctor tests; Journey C; packed partial-catalog test | Closed |
| Unclear registry recovery state | Distinct persistence/registry/host/active/callable evidence and rollback | registration details, tool status, activation-failure rollback tests | Closed |
| Runtime placeholders leak | Runtime-owned input filtering and inherited origins | registration-truth schema assertions; packed `music_player` schema | Closed |
| Types degrade | Inherited effective arg types/default validation | registry typed-default tests; runtime schema tests | Closed |
| Persisted vs callable ambiguity | Prompt/Actors invariant plus result/status activation boundary | `lib/prompts.ts`; `skills/actors/`; registry/Inspect tests | Closed |
| Spawn vs tool invocation confusion | Explicit `launch_kind`, separate counters, actual-tool journey | registration-truth, agent journeys, packed first session | Closed |
| Copied fallback Recipe/shell | Actors stop rules and action-shaped errors | Actors diagnostics; registry/error tests; fresh-agent evidence | Closed |
| Absolute-path workaround pressure | Canonical Skill identity, portable doctor source, no helper fallback | Recipe resolver/doctor tests; packaged Skills | Closed |
| Direct delegation vs imports confusion | Actors Recipe reference and direct `from` API | `skills/actors/references/recipes.md`; registry persistence tests | Closed |
| Source/docs spelunking for normal use | Skill-owned protocols and routing prompt | ownership tests; fresh-agent Journey B evidence | Closed |

## Acceptance criteria audit

### Knowledge architecture and precedence

- The injected prompt routes to active Skills and keeps only durable boundary/no-bypass invariants: `lib/prompts.ts`, `tests/prompts.test.ts`.
- `actors` owns generic mechanics, capability Skills own selection/constraints, and `swarm` owns multi-actor methodology: packaged Skill tests and exact description snapshots.
- Capability conflict resolution routes generic mechanics back to `actors`; implementation/debugging routes to `AGENTS.md`, source, and tests.
- No separate capability-authoring Skill or new kernel target exists.

### Actors operating protocol

- `skills/actors/SKILL.md` begins with operation selection and includes the required core distinctions, persistent `from` workflow, Run workflow, diagnosis, stop rules, and ownership routing.
- Skill-local references own Recipes, persistent tools, Runs, and diagnostics without README/docs fallback.
- Tests preserve direct delegation vs named imports, activation proof, actual tool invocation, and every no-bypass rule.

### Persistent tool authoring

- Public modes are exactly `from`, `template`, and `draft`; `defaults` is public and `values` is removed.
- `from` accepts canonical `<skill>/<recipe>` or explicit `.json`/`.md` references and persists compact direct delegation rather than copied effective contracts.
- Source description, async behavior, typed args/defaults, artifacts, Control, and runtime origins remain inherited.
- Caller defaults are source-owned and type checked; runtime-owned defaults fail before mutation.
- Registration reports logical source, effective required/optional args, persistence, registry, host, active-tool, callability, activation boundary, and bounded next actions without raw config/template payloads.
- Failed activation rolls back prior bytes/state and explicitly rejects spawn as invocation proof.

Evidence: `lib/tools-register.ts`, `lib/registry.ts`, `lib/recipes-references.ts`, registry/registration-truth tests, and the packed first-session journey.

### Diagnosis and recovery

- `inspect target=recipes view=doctor identity=<skill>/<recipe>` reports active ownership, resolvability, partial catalog, component status, portable source, resolution generation, rejection, and next actions.
- `inspect target=tool:<name> view=status` reports final activation/source/effective-arg/usage truth; schema remains the effective caller contract.
- Inactive owner, missing component, duplicate Skill, invalid default, registry rejection, partial catalog, malformed registration, removed prefixes/name, and inactive/uncallable tool errors all name exact cause and a bounded public next action.
- Duplicate/rejected diagnostics do not leak physical source paths.
- No Inspect invocation surface or `recipe:<identity>` target was added.

Evidence: `lib/tools-inspect.ts`, `lib/tools-response.ts`, resolver/runtime/registry diagnostics, and focused source/packed tests.

### Capability and swarm Skills

- Exact routing descriptions are tested for all six packaged Skills.
- Media selects player/library/playlist-build/playlist-scan and owns controlled-service/path/stop behavior.
- Artifacts selects bundle/report/write/manifest/file-write with truthful write boundaries.
- Project Work selects repo-health/docs-maintenance/release-readiness/release-summary/run-ops and keeps narrow helpers supporting.
- Recipe Memory permits only automatic review diagnosis/recovery through public Inspect/runtime Controls; internal reviewers are not normal capabilities.
- Capability Skills point recurring named-tool needs to `actors` rather than copying registration mechanics.
- Swarm admits overhead only for meaningful independent work and owns decomposition, disjoint scopes, lenses, quorum, conflict evidence, integration, coordinator responsibility, and completion/stop rules. Generic Run/Recipe mechanics remain in `actors`.

Evidence: packaged Skill bodies/references and `tests/skills.test.ts`.

### Human/agent content ownership

- `README.md` and `docs/` independently own human installation, product concepts, catalog, development, and release guidance.
- Skills and Skill-local references own agent operation.
- The system prompt routes; it does not enumerate DSL flags, placeholder grammar, numeric Trace/Control limits, Run files, scheduler details, or capability catalogs.
- `AGENTS.md`, source, and tests own implementation protocol/evidence.

Evidence: `AGENTS.md`, docs catalog, prompt/Skill ownership tests.

### Journey and installed parity

- Deterministic Journeys A-G cover one-off capability, persistence plus actual invocation, resolver degradation, inactive target, multi-actor review, project workflow, and artifact intent.
- Reviewed fresh-agent dogfood loaded the release-candidate packaged extension/Skills in an isolated empty environment and completed Journey B without human docs or implementation/helper source reads: `.agents/evidence/agent-journey-b.md`.
- Packed first-session tests verify all final descriptions, injected prompt, references, compact registration, source-equivalent schema, same-session activation, focused doctor, actual tool call, usage truth, no source-only runtime dependency, and no shipped `.agents/`.

## Residual assessment

No material finding from the report remains unowned or deferred. Remaining backlog work is release preparation and publication, not agent-UX cleanup. Any future work must be justified as a new capability or product direction rather than a continuation of these closed contradictions.
