# Management Inspection

The public `inspect` tool exposes four exact target families. Targets are management projections, not interchangeable aliases.

The project-wide [Agent Experience (AX) standard](./agent-experience.md) governs the direction of readable inspection text and its relationship to Inspector/agent context. Adoption does not mean current formatters already conform: rollout belongs to BACKLOG. Keep the exact target/view matrix, authorization and structured/verbose machine payloads unchanged; a new list/key-value presentation does not add fields, bodies or permission.

The shared compact Run status/default view in [Run supervision](./run-supervision.md#compact-manual-inspect-api) remains planned. The existing explicit verbose runtime inventory now adds the narrow same-session file-navigation subset below, without new Run views or default routing.

## Target and View Matrix

| Target | Views | Purpose |
| --- | --- | --- |
| `run:<id>` | `recipe`, `trace`, `control` | Inspect one accessible Run generation |
| `runtime` | `status`, `runs`, `triage` | Inspect package policy, owned Run inventory, or aggregate operational pressure |
| `recipes` | `status`, `summary`, `doctor`, `imports`, `reviews` | Inspect user Recipe discovery, active Skill components, exact resolution, imports, and automatic-review recovery |
| `tool:<name>` | `status`, `schema` | Inspect persistent-tool activation/usage or its current callable schema |

`verbose=false` normally returns compact text and `verbose=true` returns structured details. `tool:<name> view=schema` is always structured because its callable parameter schema has no useful compact equivalent.

Fresh compact Run/tool/Recipe responses now use flat AX records. Run views retain only the existing run/view header, not a new default Run status or automatic evidence body. Tool status preserves activation/callability/source/usage facts and renders required/optional argument names as real sequences, including a single item; none and unknown remain distinct. Recipe registry retains its original count/current-policy/partial-catalog facts. Focused doctor adds no source exposure: the already-portable source_location is kept whole inside the existing literal renderer, with exact identity/resolution/rejection values and opaque multiline Markdown.

Compact text selects at most the first existing hint. Only exact recipes doctor, imports verbose=true or summary verbose=true inspect strings become a typed read-only next node; any other string, including call/spawn/register advice, stays an opaque instruction value without whitespace normalization or command parsing. No hint executes, repairs arguments or grants scope. Full next_actions and all machine fields remain unchanged in details/verbose JSON. No new global output cap, truncated reference, reader or source budget is added. Runtime compact rendering now likewise uses flat fields: status keeps version/schema/review policy, runs keeps the complete exact-owner inventory count, and triage keeps its existing failure/control/backpressure/Trace/attention counts. A240-row controlled owned inventory remains240even with lines=1; verbose navigation remains independent, while triage pending66does not shrink to its40detail rows. There is no new snapshot/default status, duration, source reader/cap or routine next action. The source/installed owners verify this subset, not actual loaded phone/terminal rendering.

## Locally authored request errors

The ten refusal sites owned by tools-inspect now use flat AX errors for unsupported target/view/Trace source, invalid tool target, misplaced Recipe identity, missing registered tool and unavailable callable schema. Supported target/view/source choices are real lists, including a one-item list where appropriate. target_kind is only the selector family, not proof of owner admission. Request strings and selected activation facts remain opaque values; authored next/tool lines gain no action authority. Missing-tool refusal retains the no-spawn-substitution safety note and its known Recipe doctor next; unavailable schema retains callability/activation defaults and its known tool-status next. Other guards add no routine hint. The compact success hint recognizer remains the same closed three Recipe literals, not a general command parser.

These new owned error texts share the existing16KiB model-text allowance, including the unchanged public adapter's single leading LF. Fixed compiler facts/lists and safety reserve space; each variable starts with the shorter complete value or omission row, so later admission cannot shrink the baseline and falsely justify an omission. Optional complete next is retained if it fits with that baseline, then whole variable fields are selected in source order. An unfit scalar has field-local state=omitted/reason=response_too_large/shown=0/omitted=1/total=1, never a shortened target or raw/private character count. An unfit action has next_action omission coverage rather than a fake next command. This is a new presentation bound for these local errors only, not an input/source/work quota, successful inspect cap or new machine schema. Direct Error.message stays unprefixed until the existing adapter applies spacing; malformed request strings are not repaired or assigned scalar-completeness proof.

Validation order, callbacks/getters/String observations, basic Error type/construction sites and successful details/verbose/schema outputs stay unchanged. No catch-all intercepts dependency/authorization/session exceptions, preserves a guessed source id, exposes private causes or changes old fail-soft catches. Those errors retain their owning behavior rather than being relabeled AX. Recipe discovery/status hooks may already have executed before a later local refusal; this does not certify no effects, handling failure or safe replay. Source/installed whole-owner properties cover all ten branches in both verbose modes, exact byte boundary plus public spacing, whole-value/action omission, original exceptions including primitive/undefined/hostile getters, session-fence precedence and unchanged journals.

## Run Targets

```text
inspect target=run:demo view=recipe
inspect target=run:demo view=trace source=lifecycle lines=40
inspect target=run:demo view=control lines=20
```

Run views require a current coordinator session and an exact, non-empty match between that session id and the Run's persisted owner. Possessing a `run:<id>` is not authorization. Missing coordinator identity, ownerless state, and cross-owner state fail closed.

- `recipe` returns captured generation-local Recipe, launch, policy, and artifact declarations.
- `trace` returns the bounded unified projection plus retained-history completeness. `source` accepts `all`, `lifecycle`, `control`, `process`, `agent`, `artifact`, or `runtime`; `lines` bounds returned rows. Agent ids are opaque recorded-entry references scoped to the current Run's command/file/session namespace, not traversal indices or chronological numbers. Native entry keys survive sibling growth/reordering; ambiguous/private/degraded metadata has bounded record/read-local fallback rather than a permanent identity guarantee. Keys authorize no source read, mutation, original privacy or live-epoch reconstruction.
- `control` returns endpoint readiness, declared and runtime-owned actions, pending capacity, saturation, stale work, diagnostics, and recent redacted records; `lines` bounds recent records.

Use the runtime inventory when a remembered Run id is inaccessible from the current session:

```text
inspect target=runtime view=runs
```

## Runtime Targets

```text
inspect target=runtime view=status
inspect target=runtime view=runs
inspect target=runtime view=runs status=failed
inspect target=runtime view=triage
```

- `status` reports immutable package/runtime identity, state schema, and current automatic-review policy.
- `runs` returns the inventory owned by the current coordinator session; it is not paginated or capped by `lines`. Optional `status` filters current observations from the existing Run status owner, not the catalog's registration-time status. Unreadable observations are omitted rather than replaced by a stale cached status; healthy rows remain available. These reads never refresh or reorder the catalog.
- `triage` aggregates the same exact-owner inventory into failed Runs, pending/stale Controls, backpressure, incomplete Trace diagnostics, and retained attention evidence.

Runtime inventory never broadens authorization and never returns ownerless or foreign Run state.

### Explicit File Navigation

Compact spawn/async-tool receipts include a selected-Run `file_navigation` row: the actual directory/generation and the same nine observed canonical starting slots, without reading a catalog or evidence bodies. Kernel checks current logical session and exact physical identity before projecting files and rechecks the recipient before return. Missing/foreign/changed scope yields bounded unavailability without failing an already committed launch; unavailable slots have no path. Complete rows fit inside the remaining shared 16-KiB compact-card budget or are explicitly omitted, never path-truncated; oversized optional launch fields are labeled omitted while bounded core facts/full expert details are preserved. These are mutable location hints, not a body/privacy/terminal certificate, full session tree or filesystem sandbox. Actual source/npm public launch fixtures check reference identity and visible compact/verbose transport. Two existing real-entrypoint research journeys per layout now ordinary-read metadata selected from actual saved public-spawn and uncataloged SDK async-tool receipts before requesting any fresh map, after the producer host/runners/workloads have exited and the same saved session reopens. Actual bounded read arguments and parsed JSON digests match independent parent metadata; this is ordinary raw-file research, not original publication/privacy certification. Four fork/clone histories retain the locations as data but get no fresh owned branch or metadata selection. The async launch uses the existing controlled Kernel composition, not a claim of root-entrypoint async launching. New terminal packets now freeze current-session exact-generation member location rows before journal admission; source/npm SDK now performs an explicitly requested actual result read selected from that terminal row, with independent generation/owner/parsed-JSON checks and unchanged frozen message across continuation.

Compact launch receipts use bare block-YAML fields and a nested `run_files` value for whole selected observed locations, not a fenced object-JSON dump. Machine details retain their original JSON-compatible values and full spawn-verbose is still JSON. A single leading response LF supplies invocation spacing. A full available row suppresses the redundant map request; otherwise one `next` names tool=inspect, target=runtime, view=runs and verbose=true, with optional current-session investigation intent. This request is neither polling nor a read capability. Older terminal packet versions retain `Files (optional; current session)` followed by `inspect target=runtime view=runs verbose=true`. Fresh AX completion captures use a typed next node without reinterpreting that older handoff grammar; saved versions keep their exact text. Separately, new terminal packets use navigation_handoff=captured_file_locations and freeze a bounded prefix of location observations for their captured completion members, ordered roots before descendants with observed failed child-subtrees first. This is not the complete session map. Whole outcome rows retain precedence in the shared16KiBmessage; references then fit whole or are counted omitted, including uncaptured suffixes. Schema decoding and rendering are source/clock/native-free, and never refresh historical availability. Invoking it admits the actual current logical session at that time. Older absent/current_session_request packet versions retain their exact pending/queued/presented text rather than acquiring references on reload. The new reference marker/data are admitted only for new packets after actual current logical-session checks, never by saved DTOs as authority. The single per-batch hint consumes the shared 16-KiB model budget, not a separate allowance.

`inspect target=runtime view=runs verbose=true` adds `navigation` alongside the existing `runs`. Kernel uses the actual current logical Pi session, rechecks it before return, and selects only already registered exact-generation directories. The map orders roots before their directly same-session-owned children; it does not follow a foreign-session parent or claim a complete descendant tree. Each row offers the canonical context index/result first, then selected metadata/execution/published-session-catalog/Trace/Control/stream locations with observed sizes and format_hint=json/jsonl/text. The file_inventory_scope=canonical_starting_locations label means these are starting points, not an exhaustive file list. Format hints describe expected layout, not validated syntax/UTF-8 or output completeness; even binary or malformed current bytes can retain a layout hint. Present files remain mutable; missing, nonregular or stale files have no usable location. Whole rows, not path strings, are omitted under the independent 16-KiB map bound, with shown/omitted/total Run-row counts, not file counts. The legacy inventory envelope keeps its existing bounds and behavior; `status` filters inventory, not the navigation branch.

Both priority orders use only failed rows already observed for that inspection and matching the independently admitted map's exact owner/run/generation/directory. Ordinary inspection preserves latest-registration-first independent roots, while failed subtrees precede healthy/unknown siblings within each root. For a failed investigation use `inspect target=runtime view=runs status=failed verbose=true`: known failed root-subtrees are also stable-partitioned first, preserving recency among peers and always ancestors before descendants. `navigation.priority` reports `root_order=latest_registration|failed_subtrees_first` and `basis=observed_failed_rows`. Missing, stale or unmatched observations remain unranked, not certified successful; no complete failure inventory, terminal/native authority or cross-file atomicity is claimed. Ranking performs no additional status/body/native reads, does not filter map rows, repair/reorder catalog bytes or activate compact/default/automatic maps.

The published_sessions location is the compiler-owned evidence/sessions.json file. Kernel stats its real evidence directory and regular leaf under the admitted Run root, retaining parent/leaf/owner fences; a symlink, nonregular or unrepresentable location has no usable path. This physical location needs no producer key or context-index.json: missing/corrupt/foreign-generation or pending/unavailable semantic-index claims do not gate ordinary research. A present location does not certify catalog schema, body generation, original privacy or historical publication. The map reads neither catalog bodies nor raw session directories.

Use ordinary tools selectively on these locations, including after resume of the same saved session in a new process; no retained original producer or manager is needed. Another/new/forked/cloned session does not inherit this map through copied history. The map itself reads bounded ownership/lineage metadata and file stats only: no evidence bodies, recursive discovery, native probes, repair/export, Control, work, timing or delivery ACK. Legacy inventory/status may still perform their separate discovery and status checks.

A missing/corrupt catalog returns `navigation.state=unavailable` with `catalog_unavailable`, preserving its bytes and independent inventory rather than marking Runs failed. Reads never populate/backfill the catalog; common launch/compatible attachment registers after lifecycle release, and a catalog warning does not fail/retry the workload.

Source/npm SDK acceptance covers actual public launches, holder/workload exit, fresh-process same-saved-session result/execution/capture research, single-failure/retry/sequence/parallel/degraded/all-unusable command-versus-root distinctions, both navigation orders, four real fork/clone copies per layout, and live A→B→A without stale-context resurrection. Actual tool read-start paths, loader/tool ownership/lifecycle, metadata/raw-close evidence and selected Run/catalog byte/absence snapshots are checked; fresh captured-PID ESRCH gates successful fixture cleanup. Failed-status inventory can contain only failed rows while navigation still counts the complete eligible owned branch and may omit a whole-row suffix under its separate byte budget. A separately isolated controlled child-tree journey now loads the actual source/npm entrypoint, exercises both root orders with failed-grandchild/healthy-sibling propagation, retains all five owned map rows beside failed-only inventory and ordinary-reads the explicitly selected result rather than assuming the first map root. Additional real-entrypoint controlled-session journeys verify both orders under the whole-row byte budget: exact shown prefixes/counts, complete locations, and an independently reconstructed first omitted row that cannot fit. Actual selected-result read events, lifecycle/header/raw-close and controlled file/absence snapshots are checked without Actor workloads; pid0/legacy files are not genuine Actor-child or native/terminal authority. See [the canonical research acceptance evidence](run-supervision.md#shared-run-directory-catalog) for counts and source-class boundaries instead of treating one historical fixture composition as current global coverage.

Controlled partial-preview/Unicode and genuine-private-writer-from-controlled-recorded-source preview journeys remain distinct from real launched workloads and genuine Actor conversation. Selected-preview loss yields a real ordinary read error with accepted history preserved; fixture-only hold/restore is journaled, not product repair. Exact producer-exit/same-session reading needs no original producer key; copied accepted maps/history remain data but grant no fresh map to a new/forked/cloned session. Ordinary result/capture reads are not complete primary publication, original curated privacy, historical issuer, monotonic-clock/native continuity, exhaustive closure, OS read denial or default/automatic handoff acceptance.

## Recipe Targets

```text
inspect target=recipes view=status
inspect target=recipes view=summary
inspect target=recipes view=doctor identity=music-player/playback
inspect target=recipes view=imports verbose=true
inspect target=recipes view=reviews verbose=true
```

- `status` reports registry/watch state, active/shadowed/invalid/disabled user Recipes, active Skill components, drafts, usage, and diagnostics.
- `summary` returns the compact discovery-oriented projection of the same current context.
- `doctor` diagnoses one canonical `<skill>/<recipe>` identity when `identity` is provided; without an identity it reports registry remediation evidence.
- `imports` exposes active Skill namespaces and component import inventory for resolution diagnosis.
- `reviews` exposes bounded automatic draft/tool review state and recovery guidance.

`identity` is accepted only with `view=doctor`. Skill inventory is fail-soft diagnostic evidence; exact launch and registration still resolve against the immutable active-session context.

## Tool Targets

```text
inspect target=tool:music_player view=status
inspect target=tool:music_player view=schema
```

- `status` separates persistence, registry admission, host registration, `callable_now`, activation boundary, source identity, and `tool_calls` versus `spawn_calls`.
- `schema` returns the currently callable description, parameter schema, and prompt snippet. It fails clearly when a definition is persisted but its live callable schema is unavailable.

A registered tool is a capability definition, not a Run. Tool status cannot substitute for Run inspection, and Recipe spawning cannot prove registered-tool invocation.

## Boundaries

Inspection is read-only, owner-filtered where Run state is involved, and redacted. Evidence-heavy Run, review, diagnostic, and text projections apply their documented bounds; `runtime view=runs` deliberately returns the complete matching exact-owner inventory. Inspection does not mutate journals, infer authority from displayed data, expose private active-Skill installation paths, or turn retained Trace into an audit archive. Use `message` for admitted runtime or actor-local actions.
