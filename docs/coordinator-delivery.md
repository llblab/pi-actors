# Coordinator Delivery Scheduler

Status: Implemented coordinator-delivery contract. The adopted completion-stream extension below is under implementation and is not enabled. Invocation-local Windows identity sharing is locally implemented and independently code-reviewed; native acceptance remains pending.

Outcome/attention presentation also follows the adopted project-wide [Agent Experience (AX) standard](./agent-experience.md). The adopted target is block-YAML runtime metadata with unchanged authored text/Markdown, not list-key pseudo-objects or JSON-serialized header fields. That rollout is separate from this scheduler's implemented behavior: new presentation must preserve old saved packet text/codecs, exact source references, shared budgets, acceptance phases and recipient fences. Current frontmatter_v2 and compiler HTML framing remain implemented behavior until a separately reviewed fresh-capture/service-carrier change passes its equivalent replay and boundary gates. AX does not authorize a new scheduling policy, source refresh, body disclosure or automatic next-action execution.

Future extensions in [Run supervision and self-contained outcomes](./run-supervision.md), including periodic diagnostics and latest-only model projection, remain gated separately from the next selective AX/navigation/existing-runtime release. Its implemented [same-session research model](./run-supervision.md#same-session-file-investigation) supplies a Kernel-owned root-first file map for ordinary tools, including resume of the same saved logical session without original producer keys. It does not transfer the map to another session or change current completion/urgent-steer scheduling, curated excerpts, packet acceptance or live/native authority. Current completion headings remain packet-local; neither the selective release scope nor internal stream foundations enable public session streams.

## Goal

Separate durable Run completion truth from the scheduling of model turns:

```text
one Run generation -> one terminal record with inherited tree lineage
one ready completion forest per bounded epoch -> one root-coordinator model step
```

Ordinary terminals accumulate across nested actor sessions. Descendants wait for their complete containing top-level tree, then all ready trees and concurrently completed top-level Runs reach only the root coordinator in one bounded batch. During active work, a public `turn_end` overlay supplies fresh results to the next model request after the full tool batch, without waiting for idle or using native steering. Already-idle Pi retains debounced follow-up wakeups. Explicit actor-authored urgent semantic checkpoints remain a separate native-steer delivery class.

## Non-Goals

- Do not interrupt generation mid-token.
- Do not stream generic progress or Command lifecycle into model context.
- Do not infer urgency from exit codes, failure status, artifacts, branch position, or active subagent counts.
- Do not change Run, Recipe, Trace, Control, artifact, generation, ownership, or Inspect authority.
- Do not add transport-specific behavior or restore Recipe-level Command delivery grammar.

## Delivery Classes

- Generic Trace and runner-owned `command.done` remain Trace-only.
- `attention: "notify"` remains visible UI status without a model turn.
- `attention: "followup"` retains its existing explicit semantic follow-up behavior.
- New `attention: "steer"` requests urgent semantic delivery at Pi's next safe assistant/tool boundary.
- Terminal transitions inherit exact parent-generation and root-owner lineage; only the root session batches ready completion trees into a model-step overlay or an already-idle follow-up, never one turn per Run or descendant session.

`command.done` remains non-projectable even if malformed or legacy Trace attaches any attention value.

## Ownership

- Run terminal state remains completion truth; the absence of `terminal-handled.json` makes that generation eligible for projection.
- `runs-trace.ts` owns admission of the new `steer` attention value.
- `observability.ts` discovers terminal candidates and explicit semantic attention without deciding Pi delivery timing.
- A new `run-delivery.ts` domain owns the owner-scoped delivery journal, batch construction, bounds, phases, formatting, recovery, and acknowledgments.
- `run-ui-runtime.ts` owns active model-step boundaries, idle detection, debounce, reconciliation, flushing, and stale-context containment.
- `extension-runtime.ts` orders completion flushes before automatic Recipe review.
- `index.ts` remains a thin registration root and adds only the required Pi lifecycle adapter.
- `pi.ts` exposes narrow ports for batched follow-up and urgent steer delivery.

The local TypeScript dependency graph must remain acyclic. No public tool, target, view, Recipe field, or transport contract is added by default.

## Invocation-local Windows Identity Observation

Status: User-adopted contract, locally implemented and approved by two independent design lenses, source verification and two implementation reviews; native acceptance remains pending. This is a cost correction inside the existing readRunObservations inventory invocation, not a new public status API, persistent cache, backend, supervision capability or scheduling policy. The blocked Windows SDK case confirms workload gate expiry and dominant synchronous CIM cost; it does not prove this correction sufficient or attribute every call to one callback.

### Ownership and compatibility

- `observability.ts` keeps inventory discovery/order, observation shaping, owner filtering, summary and delivery eligibility. Replace only its default per-directory status acquisition with an internal inventory acquisition path; do not add another registry or share observations between separate inventory invocations.
- `async-runs.ts` remains the lifecycle facade and wires fixed kernel readers. `runs-status.ts` owns metadata-frame admission, status derivation and post-query/post-assembly revalidation. `runs-process.ts` owns bounded Windows CIM acquisition, decoding and the existing identity comparison/liveness semantics. Keep imports acyclic; do not move lifecycle, signal or publication policy into the process reader.
- Keep public getRunStatus arguments, returned fields, process_identity_status and scalar behavior unchanged. Its direct callers, native launch capture, exit observation, snapshot callback bracketing, publication, Control and teardown must never consume the inventory query frame. Reuse private status derivation rather than forking status policy or exposing an actor-supplied identity-result/reader port.
- Enable the fast path only for the default Windows inventory reader with admissible metadata. Non-Windows, custom/injected observers and unsupported legacy metadata keep the original scalar route. Do not silently skip a previously supported legacy Run merely because it cannot enter the new fast path.

### Admission, query and consumption

1. Discover the same directories in the same order as today. Admit each fast-path row from the actual bounded metadata read, not an index DTO, copied identity, actor value or later caller claim. Bind the physical canonical directory and metadata-file frame, complete source bytes or equally strong existing change evidence, exact run/owner/generation, state_dir, PID and complete expected native identity. Capture supporting ownership-marker evidence where the original frame contract requires it; inability to establish this new frame uses the scalar route, not fabricated empty inventory.
2. Query only unique positive safe-integer PIDs selected by those admitted rows. A fresh liveness gate may exclude ESRCH-observed PIDs from this optional acquisition only; unknown/EPERM remain eligible. Never use the gate as status or retained absence proof: assembly still invokes its independently fresh verifier, and an excluded PID that is live then uses the existing bounded scalar identity fallback against its original admitted frame. Keep every admitted row and all replacement fences; a successful shared map missing a PID keeps its existing unsupported-proof semantics, not a new retry. Use shell-free PowerShell invocation with the same CreationDate/ExecutablePath/CommandLine representation as the scalar reader and explicit ProcessId-to-row correspondence. The shared command requests only ProcessId,CreationDate,ExecutablePath,CommandLine through -Property; each scalar acquisition requests only its existing serialized CreationDate,ExecutablePath,CommandLine values. Filtering the scalar query by ProcessId does not require returning it. Both retain their respective Select-Object/JSON wire and decoder, with implicit CIM keys not exported; every scalar call remains independently fresh, including direct status, capture, publication and Control. Existing status/error semantics, optional normalization and callback fences remain unchanged. Narrower property retrieval does not establish exhaustive provider equivalence, provider-internal work reduction or deadline recovery; a supported-Windows difference affecting consumed values, status or authority falsifies acceptance rather than permitting weaker proof. The implementation admits at most64PIDs per synchronous query, guards its numeric-only ASCII command at4096characters and complete stdout at1MiB, and rejects incomplete/malformed output before consumption. These explicit argument/output/parser bounds are independent of model packet limits; native sufficiency and normal fast-path eligibility still require real Windows evidence. Larger inventories use bounded chunks, not truncation, widened process discovery or a background worker.
3. Treat malformed, duplicated, foreign or uncorrelated native rows as unusable. Missing/malformed/error is never native absence. Preserve the scalar verifier's distinctions: matching identity, mismatch, unsupported proof and dead_pid only from an independently qualifying fresh liveness observation. Preserve valid optional native-field semantics; do not tighten legacy identity parsing or normalize CreationDate/command bytes incidentally. Chunk failure or unsupported framing may fall back once to the existing fresh scalar acquisition for affected rows; never retry an unbounded batch or substitute a saved/native-old result.
4. Revalidate each exact metadata/ownership/physical frame after its query and after status assembly, including PID/expected identity and source-byte correspondence where stamps alone are insufficient. A changed original row is discarded for this invocation, not silently rebound to the replacement generation or repaired from live state. A later invocation may admit that replacement independently. Result/progress/natural-outcome reads retain their existing owners and do not become globally atomic merely because identity acquisition is shared.
5. Assemble statuses through the existing private derivation and unchanged verifier semantics, including an independent fresh liveness check where required. Native rows are consumed only inside the synchronous inventory acquisition before any consumer callback/effect. No module-global/ambient override, retained closure, serialized DTO, TTL cache or handle may carry the frame to another call. A nested/reentrant inventory invocation gets its own fresh query and cannot borrow or overwrite its caller's frame. On return or failure the query frame becomes unreachable; only ordinary bounded observation data is returned, never a native capability.
6. Keep independently fresh startup, watcher, reconciliation, attention, steer, boundary and idle observations. Existing same-pass UI/delivery sharing remains exactly that one inventory pass, not a reason to reuse the frame at later delivery, publication, Control or cleanup boundaries. Separate native observations bracketing snapshot callbacks remain scalar and fresh. Rendering and animation stay probe-free.

### Acceptance and rejection

- Property tests in the existing runs-process, runs-status and observability owners must cover scalar-equivalent valid/mismatched/unsupported/dead results, exact Windows command/date decoding, duplicates/foreign/malformed/missing rows, query failure and bounded chunk/fallback behavior without inferring absence.
- Test owner/generation/PID/expected-identity/source-byte/physical-frame changes during query and assembly, legacy/custom/non-Windows fallback, independent second and nested invocations, and inability of later callbacks, publication, Control, exit/teardown or snapshot hooks to reuse the frame. Assert actual native-query counts on the default inventory path, not merely a helper's Map lookups.
- Do not add workload skips, shrink the nine modes or87genuine planned Runs/layout, reduce either40-spawn cohort, move/reset/inflate SDK/workload/fixture deadlines, weaken source/privacy/generation/location/row-cap/overflow assertions, fabricate birth/close/absence, or signal a fixture to pass. Preserve fresh ESRCH before every deletion and retain uncertain roots.
- If the new query grammar needs timing instrumentation support, extend only the fixture observer's exact owned-query recognizer: call the original once, retain finite process-local evidence and exact errors, and issue no observer queries. After deterministic tests, types, build parity and Domain DAG validation, require the unchanged source-and-packed public SDK journey and fresh all-platform CI. Linux/mocked tests do not prove native Windows performance or closure. Keep temporary bounded timing evidence until native convergence, then validate the cleaned final candidate. Loaded-host acceptance stays separate.
- Reject or return to design if implementation needs cross-callback retention, changes public status semantics, bypasses original metadata/native fences, adds privilege/backend activation, or cannot keep query inputs/results bounded. No further implementation permission follows from a successful batch command alone.

## Durable Delivery State

Store one journal per exact coordinator owner under an internal path derived from a safe owner hash:

```text
<extension-temp>/delivery/<owner-hash>/projection.json
```

The journal records the exact internal owner and contains at most one active completion batch plus a bounded set of unpresented urgent steer envelopes.

Completion batch shape:

```json
{
  "batch_id": "uuid",
  "owner_id": "exact internal owner",
  "phase": "pending",
  "members": [
    {
      "run": "review-a",
      "run_instance_id": "generation-id",
      "status": "done",
      "state_dir": "internal path"
    }
  ],
  "created_at": "timestamp"
}
```

Phases are monotonic:

1. `pending`: The exact member snapshot is durable but Pi acceptance is unproven. Returning a boundary draft does not advance this phase.
2. `queued`: Pi accepted a custom message carrying the exact batch or steer ID.
3. `presented`: Exact completion acceptance is proven, or a Pi `context` event observed the urgent-steer ID in messages being supplied to an LLM call.

Every journal mutation uses the canonical token-owned lock, expected-phase fencing, owner and generation validation, and atomic replacement. Repeated transitions are idempotent. Corrupt, oversized, foreign-owner, or stale-generation state fails closed with bounded diagnostics.

Ordinary source completion admission has one fresh path: presentation_format=ax_records, private result_layout=completion_yaml_files_v2 and frozen text_budget, without excerpt_format or a public selector. The inactive numbered-stream kernel path keeps its separate frontmatter_v2 default. Bounded source/compiled and actual-default source/packed acceptance observes the normal index path and in-memory entry/context/provider/hint tuple. Unchanged storage/registered-renderer/accepted-history-reopen facts transfer only on the successful original-current-manager path; this is neither fresh default-disk observation nor global lifetime-policy, native-scope or loaded-host acceptance. Direct admission and ordinary run-ui-runtime use it after unchanged owner/location checks; an existing batch stays untouched. Each shown record begins YAML frontmatter with run, state, then kind:primary for admitted primary/final Actor response or kind:diagnostic for explicit error/failure excerpts. Untracked fallback has no kind and retains unknown completeness/privacy outside YAML. The closed header is followed by raw, unindented Markdown, with no #N heading, result:/preview: wrapper or compiler literal fence around the body. Known local loss is [N characters omitted] at the cut, not a YAML flag/count or extra ellipsis; N counts the admitted postprivacy source prefix loss, not private/native output. Unknown upstream loss remains separate. Original coverage remains structured member data; exact source/generation/location references remain whole typed nested YAML values. Routine summaries/windows/status copies/standing map instructions remain journal facts, not duplicated model content. Prepend a packet-local index only when two or more results are shown; exactly one shown result omits only that display field even if other results were omitted. Internal member_index, generation and correlation remain unchanged; the rooted_files_v2 discriminator gates this rule, not member count in an older snapshot or numbered-stream scope. Material omitted_results, non-done omitted_states and whole result_inventory recovery stay explicit. Each shown record has a whole run_files row or explicit omission, with unavailable reasons retained; omitted records do not leave orphan location rows. Outcomes precede lower-priority references under the total48KiB UTF-8/64candidate-row bound including framing. Prefix admission considers full-list and decimal-count discontinuities, freezes equal scalar/CRLF-safe shares without unused-share redistribution, and never clips references or rewrites a retained excerpt. Older captures retain their original16KiB/48KiB budgets.

Fresh ordinary source hints carry the core format and whole-content digest; the validated YAML core carries only packet identity and relative body/marker lengths, from which boundaries are derived. It adds no fresh HTML tail or duplicate coordinate table. These are consistency facts, not source or acceptance authority.

Only pi-actors-run-batch messages receive this completion renderer; customType, routing, timing and acceptance stay unchanged. For retained frontmatter layouts, the completion_frontmatter_v1 presentation schema keeps format, content_sha256, complete UTF-16 compact_ranges and header/body/marker/service block tuples into the exact saved content. The compiler frame binds those positions to the prefix SHA-256. Own-data validation checks dense ordered coverage, scalar/CRLF-safe endpoints, header/state/index shape and permitted marker/service framing. Invalid/missing hints reveal full original Text; expansion does too. Compact view uses literal Text for header/marker/service and a separate native Markdown component for each body, so an unfinished fence/list/quote cannot consume the cut marker or next record. Only whole validated compiler header references/run_files nodes and framing are hidden; authored body lookalikes never become hideable metadata/actions. Old saved formats retain their original renderer/hints. No source/native IO, refresh, global Markdown patch or new authority occurs; hashes/framing prove consistency, not authenticated issuer, source permission, native closure or acceptance.

Retained frontmatter_v1/v2 content ends with its original compiler-owned pi-actors:frontmatter JSON frame containing full block positions, prefix_sha256 and optional immutable numbering facts, followed by one closed pi-actors:completion marker with the original batch ID as a canonical escaped JSON string. Both sit after the framed source ranges and count toward48KiB; they do not duplicate coverage counters/secondary bodies or create visible captions. The Pi adapter uses the strict whole YAML core for fresh ordinary source records and validated closed terminal correlation for retained frontmatter when private details disappear; authored body Batch labels cannot override it. Recognizable malformed frontmatter prefixes—including CRLF/CR, truncated or reordered metadata—remain unknown rather than falling through to legacy body-label identity or absence/retry permission. Ordinary thematic-break prose keeps its legacy path; this is a conservative prefix recognizer, not exhaustive damaged-YAML parsing. Malformed/noncanonical/overlong IDs, trailing bytes and invalid frames cannot acknowledge an epoch. Detailed-envelope precedence stays unchanged. Correlation still requires exact owned journal/content, session and generation checks before acceptance; matching bodies alone do not identify an epoch or authorize resend. An exact committed entry can prove acceptance; unidentified/conflicting recovery evidence holds uncertainty.

### Fallback removal boundary

The visible legacy type label is removed only for new packets; the text fallback itself remains. In observability, legacy results lacking primary/diagnostic protocols may still supply a bounded stdout prefix (done) or result.error. Intermediate primary-aware results without a diagnostics protocol can fall back only for not_selected, selection_not_supported or primary_not_selected_for_failure, never for a missing/changed published source. The collector freezes at most4000UTF-16 units of that untracked body; its earlier8192-byte decode can already have lost Unicode/count/privacy information. Nonroutine summaries are another untracked input and remain visibly warned even if body fallback is later removed.

The current ordinary async runner publishes an explicit diagnostics binding on both success and failure, including null/unavailable bindings. That protocol suppresses raw-body fallback even when primary/diagnostic sources disappear or text selection is unsupported. Custom publishRunResult callers may omit the optional diagnostics publisher, so this is not universal removal proof. The source/packed public SDK profile checks that its modern packets do not fall back; it does not inventory operator history or certify every custom producer.

Removing fresh collection of untracked bodies would leave affected old/intermediate/custom producers with status, summary and recorded references but no former body preview. That is a compatibility/content decision, not a kind rename; it is not implemented here. Retained output decoding/rendering and older formatting codecs must remain until a separate history-lifetime decision permits their removal. Attention/steer bodies and legacy artifact declarations are distinct paths, not authorized deletion targets of this completion-label change.

### Retained capture compatibility

The numbered wire strings ax_records_v1/v2/v3, old indexed/single_result captures and result_layout records/run_headers/headings/headings_flat_omissions/headings_outcomes/headings_shared_results/headings_shared_kinds/frontmatter_v1/frontmatter_v2 are retained storage encodings, not public alternatives. Fresh ordinary source admission chooses own-data completion_yaml_files_v2 with canonical ax_records and text_budget (over the unchanged completion_yaml_core_v1 carrier); earlier completion_yaml_core_v1 and completion_yaml_files_v1 snapshots retain their old layout and singleton indices, never single_result. Absence preserves its original indexed/singleton codec; inherited aspects never restyle data and accessors are refused without invocation. Earlier record/header/count/kind grammar and each captured16KiB/48KiB share remain exact. The first frontmatter draft retains its original bytes and hints, including unquoted unknown index ?. Retained v2 fixed that one YAML case by writing index: "?"; numeric indices and other fields/body bytes are unchanged, and the presentation-hint schema remains completion_frontmatter_v1 because its block structure is unchanged. Preserve the frozen v1 unknown-content fingerprint90e29fb36087e2620fe0cf150b4238bce8a6d1dcc68ee922a1cf71ee8604610e and prior shared-result fingerprint4428de318b8ebaa029d3588ab7e8e705b9a80fa5cf08b6a2cc7151916207e266. Journals store snapshots rather than complete text: neither an unreleased product, a YAML correction nor member count permits relabeling/migration. Pending/queued/presented replay must reproduce original model bytes and hints without operator journal scans, source refresh or message rewrites. Removing compatibility requires a separate history-lifetime decision.

Steer envelopes already store complete content. Both attention and steer now have one canonical new-message formatter with no presentation selector; the redundant legacy formatting branches/path/body helpers are removed where no retained-data consumer needs them. Existing steer identity is reused before formatting and saved content bypasses the formatter in every pending/queued/presented recovery path. Removing stored Batch codecs later requires a separate retention/data-lifetime decision; an unreleased product is not permission to change previously captured delivery bytes.

Completion and steer acknowledgments intentionally differ. An active completion overlay remains pending until exact model context or bounded active-session evidence proves its committed entry. Successful idle `sendMessage()` acceptance finalizes an ordinary completion batch immediately; durable queued phase also proves acceptance. Both paths mark members through the existing terminal-handled authority, so a missed context callback cannot block every later epoch. Urgent steer still requires exact model-context presentation. If a completion member was synchronously archived or pruned after acceptance, the bounded delivery snapshot remains sufficient and the missing state write becomes a diagnostic rather than invalidating acceptance.

## Completion Streams: Adopted Contract

Status: Adopted product contract; the kernel allocation path is implemented, not enabled in ordinary delivery. run-delivery.ts owns whole-range arithmetic, retained pending requests, active counter/unavailability, immutable numbering projection/correlation and a kernel-only numbered capture entrypoint. Default completion packets still use packet-local indices. An internal kernel opt-in can now bind a verified fresh-session runtime to numbered capture/recovery; the default entrypoint does not opt in. Without that binding, retained stream state cannot authorize capture or completion ACK. Fresh-session bootstrap, complete continuation/command admission and isolated provenance UI remain unimplemented. Remaining work and the coupled activation checkpoint belong only in [BACKLOG.md](../BACKLOG.md).

The kernel request requires an existing valid owner delivery journal, retains/reuses one internally generated fresh target and refuses absent/corrupt/foreign state. A target waits behind any unresolved packet. Reusing it performs no journal replacement; it still validates under the owner lock. Status reads create no state and report missing stream metadata as unavailable, never disconnected; persisted session/counter facts are not current SDK ownership proof. Kernel-only captureRunCompletionStreamBatch requires retained valid stream state and commits the packet, complete fixed order/range and advanced counter in one locked replacement. A pending target activates at zero in that same first-packet commit, never an earlier active-empty state. Packet finalization, urgent writes and receipt rotation retain the active counter and pending target. Sending and inventory effects remain separate; uncertain write/release outcomes require reading the exact saved packet, not blind allocation or target regeneration.

The staged numbering fact is own-data-only and canonical-headings-only. It encodes every member's fixed index using one frozen complete member_order permutation plus an exact first_index, or an unavailable kind/reason and the same frozen order. Projection never re-sorts that order or consults a current counter. Full session/stream scope is retained in one compiler-owned technical block inside the same model content; typed data and framing are consistency checks, not identity/authentication or source permission. A first-zero snapshot emits the saved-boundary text with the full stream ID, including when zero is omitted from shown rows; later frames use bare historical #N, and unavailable frames show #? with a visible reason. Closed-footer recognition validates the canonical numbering block and rejects malformed/mismatched framing without treating it as proven absence. Missing/bad layout hints reveal full text. New inventory hashes bind numbering only when present, leaving old inventories unchanged. Kernel capture now supplies these snapshots, while projection/adapter/native-renderer fixtures also exercise them independently. The journal decoder requires exact owner/session/active-stream correspondence, refuses active state with a packet-local packet, and rejects a known counter below the numbered packet's exclusive end. A valid explicitly unavailable counter preserves existing numbered packets and freezes new packets as #?; an unfitting whole numeric range also freezes #? without advancing or resetting the retained counter. Malformed or missing stream/counter records remain refusal, not permission to reconstruct a counter; classification/recovery needs independent valid evidence. Direct callers cannot select numbering on either admission path. Only the kernel allocator assigns numbers. An internal bridge uses it only with an admitted original manager/current generation and retained stream state; the default entrypoint keeps its integration fence. No fsync/power-loss or stale-storage recovery guarantee follows.

### Internal runtime/session binding

index.ts forwards the actual SDK session_start event into extension-runtime.ts rather than dropping it. A unique async-start ticket refuses older initialization completion even across A→B→A or a reused context object. The kernel-only completionStreamSessionAdmission port is absent from the default entrypoint and public tools/configuration. Its explicit synchronous true is considered only for trusted fresh new/fork creation, an unseen original manager/context and the current runtime ticket. It grants neither bootstrap nor continuation from an ID/event/DTO; missing event, false/deferred admission, reused managers, startup/reload/resume and unknown state stay closed. Valid stream metadata is still required before capture. No stream state is created by status/startup, and this path never falls back to local indices.

run-ui-runtime.ts pins the original manager and private generation, admits fresh wrappers only in that generation and revalidates around completion projection/recovery/ACK. Watchers, reconciliation loops and delayed callbacks retain their birth ticket; old/unstarted callbacks cannot refresh, schedule, report errors or revive authority in a replacement. Shutdown/settled callbacks on the opt-in route also refuse stale contexts. A post-send replacement withholds new ACK/handled facts; the send may already have effects, so this is not recipient-lease/exactly-once proof or permission to replay. Existing urgent/legacy behavior remains separately owned.

Source and compiled owner tests include real SDK new/fork/clone/tree/switch/import operations without model requests or Run launches; terminal metadata and the busy model-boundary probe are controlled fixtures, not actual workload/model acceptance. Copied history retains original numbering bytes/scope. Native resume and import both arrive as reason resume in SDK1.0.0; neither receives stream admission in this cohort. A trusted restoration/independent-copy distinction, positive non-connection/bootstrap evidence, public start/status actions, isolated provenance and separately authorized loaded acceptance remain gates.

### Scope and ownership

- Apply persistent numbering only to newly captured completion elements, not Trace, notify/followup checkpoints, urgent steer or Control.
- The full element key is session_id + stream_id + index. A bare number is not unique across streams or sessions. Use the actual verified logical Pi session, not an actor-supplied owner, current context window, Run generation or Trace rank.
- Keep one active stream and at most one pending fresh target per logical session. Full IDs belong in service data. No global cross-session counter, second registry, presentation selector or numbered AX product mode is introduced.
- run-delivery.ts owns the persistent state, immutable numbering snapshot and bounded projection. file-state.ts owns the existing lock/replacement mechanism; run-ui-runtime.ts owns capture/delivery reconciliation and the switch barrier; extension-runtime.ts and index.ts bind fresh SDK lifecycle/command contexts. pi.ts owns envelope/correlation adaptation. The completion renderer owns only display.
- Store the verified session binding, active full stream ID and next counter or explicit counter-unavailable state, optional pending full target ID, and the current packet's delivery ID, numbering kind/scope, fixed per-element indices or unavailability, sources/bindings and phase.
- Retain active counter and pending target for the logical session lifetime, independently of packet finalization, receipt rotation, Run retirement and model-context cleanup. Deleting that state is a separate explicit decision.

### Explicit creation and the switch barrier

- The first stream and each subsequent stream require an explicit session-level “Start a new stream” action (“Начать новый поток”). Starting a new or forked session must not automatically activate a stream. Provide read-only status separately from that action.
- Before connection, retain packet-local indices only when non-connection is positively established. Missing/unknown state is not “off” and never permits silent initialization from zero.
- Persist one fresh pending target. A repeated action shows/reuses that target rather than silently regenerating or replacing it. The minimal contract has no cancel, replace or old-ID reactivation operation.
- An unresolved current packet remains in its original numbering scope. A requested target waits; requesting a switch does not change its text, sources, indices, phase or delivery ID.
- Confirmed acceptance resolves the old delivery epoch. Proven absence may permit exact replay of the same packet. Unknown/conflicting evidence permits neither blind replay nor bypass.
- Activate the pending target only with its first newly captured packet, starting at zero, in the same atomic commit. Do not create a separate active-but-empty stream or emit an early stream boundary.
- An explicit fresh stream may start after the old packet is resolved even when the old counter is unavailable.

### Assignment, atomicity and replay

- Fix the captured element order once and assign indices to every captured member, including members omitted by the model byte/row budget. Do not derive persistent indices from render position, completion time or file-navigation member_index.
- Under the existing owner lock, atomically save one state containing the packet, all fixed indices and the advanced counter. For a transition, also save activation and removal of the pending target in that same commit.
- Sending, inventory creation and other file effects are outside that transaction. An uncertain write or lock-release outcome requires reconciliation of the exact saved state, never blind reallocation/publication or an assumption that nothing happened.
- Replay/resume reuses the saved delivery ID, scope, indices, text, sources and terminal marker without new allocations. Resuming the same logical session continues active and pending state; completing/cleaning its current packet must not erase the counter.
- Every numeric index is an exact JS safe integer in 0…2^53−2; the next counter is at most 2^53−1. Validate the complete capture range and next value before commit.
- If the complete range cannot fit, issue no numeric indices to that packet: freeze #? with a reason, without partial numeric issuance, rounding, wraparound, reset or automatic creation of another stream. The pure range projection is not a durable allocation; only the owner-locked packet commit assigns numbers.

### Missing counters and recovery

- Never reconstruct a counter from zero, a visible maximum, model history or an unproven older backup. Recovery needs saved evidence proving the upper boundary and the absence of later allocations.
- If only the index is unavailable and all other journal/session/source/delivery checks pass, capture #? with its reason. A later restored counter must not rewrite that packet.
- A valid previously numbered packet replays its fixed numbers even when the current counter is unavailable. #? cannot bypass a corrupt journal, foreign session, invalid source binding or uncertain delivery identity.
- Reject or retain uncertainty for mixed packet stream scopes, active B with an unresolved A packet, a counter not above assigned packet indices, foreign session scope, target equal to active, or activation without the first-packet atomic commit. Never repair these from visible history.

### Session boundaries and presentation

- A genuinely new logical session, including native fork/clone, has its own scope and inherits neither active nor pending state. Copied history keeps original scope/text/numbers, or explicitly unknown provenance, without transferring permissions. Resume is not interchangeable with creating an independent copy.
- Keep index-first frontmatter blocks, separately framed body Markdown and blank separators; retain old #N blocks only for their saved layouts. The first saved delivery of a new stream contains one visible start boundary, for example “— Новый поток a7f2 · отсчёт с #0 —”.
- Derive that boundary only from the captured new-stream snapshot containing its fixed zero-index element, even when that element is omitted from the displayed rows. An authored #0, old local index or current mutable active-stream state is not sufficient.
- Preserve the same boundary during replay. Make compact provenance accessible for isolated views/search/import when the boundary is offscreen; a human reference may use a7f2/#0, while cross-session references also need session scope. Full IDs remain available; extend short labels when ambiguous.
- Preserve one complete model content and its compact/expanded views. Service data still consumes the shared budget. Keep48KiB UTF-8 for fresh captures (16KiB for retained codecs) /64 shown /256 captured members, whole references, source/privacy/generation fences, closed delivery correlation and full-text fallback for bad hints.
- Every older saved packet retains exact bytes and layout hints. Old local #N values never become stream history; do not migrate/relabel packets or scan operator journals for this change.
- Derive transitions from saved active/pending/packet facts rather than adding switching, switched, first_message_sent, counter_initialized or duplicate last_index/next_index flags.

### Source/SDK integration gates and acceptance

The read-only feasibility audit found suitable existing owners, not an implemented stream feature. SDK1.0.0 native fork/clone creates a new ID, while importFromJsonl copies a file and opens the retained ID with reason resume. That import API alone does not prove a new independent scope; distinguishing intended restoration from independent copying remains an integration gate, not an implicitly adopted import policy. Tree navigation keeps the same session ID and must not roll back the counter through branch-sensitive state. Startup/reload and missing metadata are not proof of first connection.

The existing writer provides locked replacement, not fsync-backed power-loss or storage-rollback proof. Do not claim those guarantees, or restore a stale counter, from a successful rename or syntactically valid backup. Normative lifetime retention remains required; any stronger crash/rollback guarantee needs its own established storage/recovery evidence and explicit decisions where necessary.

Enable the feature only as one coupled journal/capture/recovery/correlation/lifecycle/presentation change. Acceptance must cover all captured members and full-range boundaries; interrupted writes/release and immutable replay/resume; pending-switch barriers and uncertainty refusal; lost counters; native fork/clone and copied provenance; exact older pending/queued/presented bytes/hints; source/generation/opacity/budgets; and source/packed/SDK journeys. Loaded visual acceptance remains separately operator-authorized. Do not promise globally unique bare numbers, a complete historical audit, exactly-once network delivery, automatic counter recovery, model understanding, native closure or actor-control authority.

## Completion Collection

Reconciliation admits unhandled terminal generations with status `done`, `failed`, `killed`, or `exited` that belong to the active root delivery owner. A descendant becomes eligible only when its exact parent chain reaches a terminal top-level Run.

It excludes:

- Runs with silent notification policy;
- synchronous stop or cancel outcomes already acknowledged by their caller;
- handled terminal generations;
- internal composition branches;
- every Command lifecycle event.

Candidates sort by terminal timestamp, then stable Run identity, then `run_instance_id`. Replacement generations with the same logical Run id remain distinct internal members.

While Pi is active, candidates remain durable until the next completed `turn_end`; watchers do not enqueue ordinary terminal follow-ups into the native message queue. The boundary itself reads current Run state, so a missed watcher cannot make the next step stale. A flush snapshots eligible candidates into one immutable batch. While acceptance is pending, newer terminals stay unhandled for the next bounded completion epoch.

## Batch Flush

Flush one batch when:

1. A completed active `turn_end` reaches the exact root owner without an aborted signal or native pending input;
2. `agent_settled` fires for the still-active owner and `ctx.isIdle()` remains true;
3. Terminals arrive while Pi is already idle and survive the 100 ms default debounce window;
4. Session restoration discovers unhandled terminal generations or recoverable delivery state.

Active delivery returns `{ entries: [...event.entries, entry], continue: true }`, where `entry` is one `custom_message` with `customType: "pi-actors-run-batch"` and `display: true`. It preserves previous extensions' boundary entries and requests one next model step in the same agent run after the entire tool batch. Aborted/error boundaries, queued native input, and outstanding urgent steer defer the overlay. It never uses `sendMessage(..., { deliverAs: "steer" })` or a native follow-up queue for active completion delivery.

Already-idle delivery uses the same custom message with `deliverAs: "followUp"` and `triggerTurn: true` to wake Pi. Both paths render one gray operator card and supply the same tree-compressed prompt to the model. The bounded content retains the exact batch identity for session evidence and deduplication even though Pi omits private message details from model context. It includes:

- batch ID and completion window;
- counts by terminal status;
- stable parent-child Run rows with status, compact semantic output, and bounded artifacts;
- admitted primary previews with exact UTF-8 ranges, Unicode clipping counts and full retained-export references when available;
- first-result artifact inventory descriptors/counts with full retained references and explicit metadata-only, target-availability/production-not-asserted provenance;
- admitted first-result diagnostic metadata references and one literal field excerpt with exact UTF-8/Unicode counts, explicitly not primary output;
- explicit source unavailability, separately labeled unsupported legacy diagnostics, retained-member overflow counts and a scoped retained inventory reference for newly admitted row-overflow packets.

The journal may retain at most 256 members and 1 MiB. Model-facing content lists at most 64 exact rows within the centralized model-output bound. For newly admitted row-overflow packets, additional captured members remain recoverable from the inventory reference in the message, not only through Inspect. Legacy packets without that reference explicitly disclose its absence. More than 256 unhandled generations form a later batch rather than being discarded.

Completion member details must exclude raw model policy, secrets and private original Recipe/source paths; this is an exposure requirement, not a whole-envelope certificate from a saved binding (see the diagnostic admission boundary below). Explicit authorized export references are included in full, not clipped or mistaken for original inputs. Primary bindings come from generation/owner-admitted source reads only for eligible completion members; ambient candidate checks are metadata-only. Curated members/artifacts/bindings and member arrays freeze at packet admission. Reload, phase changes and literal Markdown rendering use that captured packet without source rereads or availability repair; metadata, paths and protocol flags alone cannot authorize raw body exposure. See the [primary-text contract](run-supervision.md#private-kernel-contract-primary-command-text-publication) for the verified initial source/tarball public-spawn journey and remaining selection/evidence/native acceptance.

### Result-First Completion Content

Fresh outcome records show admitted command output or the executor-selected final Actor response. The whole packet shares48KiB UTF-8 after privacy: one candidate can use nearly all of it, two have at most24KiB each, three16KiB each, and so on for at most64 candidate rows. Service fields, indentation, dynamic fences, source references, numbering/inventory and the closed marker consume that same budget. No fixed per-result16KiB or preview2KiB ceiling remains. Unused shares are not redistributed to exceed another candidate’s equal ceiling. A result is the entire admitted text only when it fits and has no observed upstream clipping; otherwise preview shows the selected scalar/CRLF-safe prefix. Even a complete retained prefix with upstream loss remains preview plus the separate unknown-loss warning. This is completeness of the admitted source/response, not universal Actor output or native closure. Error/failure-reason excerpts are explicitly diagnostic; a recorded command is not an answer and is never substituted into a new preview or secondary excerpt. Command metadata remains available through its exact diagnostic reference. Explicit notify/followup/steer checkpoints retain the Actor-authored message body and their existing wake/acceptance policy.

The original complete-stdout selection stays limited to a successful bare ordinary command, one attempt and its proven complete capture. An additional kernel-only onFinalResponseSelected port selects the successful executor's actual final stdout before tool-display clipping. The runner alone supplies the original producer/privacy capture; no actor value, log scan, command string, formatter or saved DTO can select a response. Compositions, retry wrappers and direct Pi text-print replies can use this distinct response path. Direct Pi JSON/RPC/interactive streams are withheld rather than mistaken for an answer. Failures do not call the successful-response port.

The existing source owner exports that bounded response through the same captured privacy, exclusive source publication, generation fences and first-result binding. text_basis:actor_response and upstream_truncated distinguish it from complete raw command stdout. Counts describe only the retained privacy-projected response. Observed prior stdout or rejected-branch diagnostic clipping is shown separately as upstream_omission:[omitted: unknown]; false is not certification of every earlier transformation. The4MiB input ceiling is unchanged. A complete existing source and privacy/capture/export refusals cannot be replaced or healed through this path; repeated response selection refuses. Missing/empty/oversized/unsupported text stays explicit, not a guessed stdout/session fallback.

Fresh completion admission selects up to48KiB through the same generation/privacy-admitted source observation, without a second body read. Original publication previews remain160code points and public/default primary reads retain their original semantics, including the64KiB encoded-response ceiling. Completion-only admission data allows JSON escaping overhead within the existing1MiB journal bound while its text stays at most48KiB; otherwise valid quote/newline-heavy sources could be falsely withheld before packet fitting. The journal stores only the chosen per-member text prefixes and their frozen shared budget, not64 independent48KiB bodies. Replay/render/phase changes never reopen sources or recompute that allocation. Counts/ranges describe the actual selected prefix; references remain complete. Whole-record omission/inventory remains the fallback when mandatory metadata alone cannot fit or the independent64-row cap applies.

Source/npm SDK checks include a genuine finite Pi text-print answer, actual retry/sequence/parallel/degraded responses and forty-producer metadata-byte-overflow groups under48KiB. Sixteen ordinary previews can now fit without whole-row loss; the forty-producer witness forces mandatory source/reference pressure rather than relying on large source bodies. The public boundary fixture covers nine modes per layout and87 genuine public Runs per layout; row-cap companions remain separately synthetic. These are local controlled-provider checks, not loaded operator UI, native scope closure or three-OS/release acceptance. Saved layouts retain their exact old text, hints and accepted snapshots without migration.

### Captured-Member Inventory

When whole member rows would exceed the shared byte/row budget, admission retains `delivery/<owner-key>/inventory-<content-sha256>.json` before publishing the batch journal binding. The pretty-printed `run-completion-inventory-v1` document fixes batch id/time, all captured member identities/statuses/times/parent identities and already admitted primary/artifact/diagnostic bindings. Its coverage is only `captured_completion_members`: it omits private member/parent state paths, owner identity, steers, summaries, legacy diagnostic bodies and original declaration lists. When artifact bindings are present, `artifact_inventory: "captured_bindings_only"` labels their descriptors/unavailability, never their body contents; diagnostic references similarly use a conditional `result_diagnostics: "captured_bindings_only"` tag and never copy field excerpts/bodies. Older packets without those fields retain the same source payload/hash. Absence of a primary binding is not proof that no work output exists. This is a complete list of this snapshot's members, not all unhandled Runs or all artifacts/results.

The message carries the full path, SHA-256, UTF-8 byte count and exact member count before allocating row space. Ordinary authorized file reads can follow that exact file, verify bytes/hash and recover an omitted member's existing primary source reference; do not open the entire mutable owner journal or guess sibling files. Inventory retention grants no new primary-body permission. Reference metadata is frozen with captured membership and checked against its canonical projection and owner directory on journal reads. Phase transitions, finalization and rendering do not reread or recreate the source, repair availability or manufacture acceptance. The label is retained **at capture**, not a promise of perpetual readability or filesystem immutability. Finalizing a batch does not delete its retained inventory; normal workspace removal may remove it.

Known journal capacity is checked before source creation. Source creation is exclusive and nonoverwriting; write/close or journal publication failure preserves the original error and any unpublished partial/orphan file. A failed source does not publish a batch binding or ACK, and a retained orphan alone is not delivery evidence. Reusing the same identity cannot overwrite/reuse that orphan. Source and journal are not a multi-file transaction, rollback, fsync or power-loss guarantee. These owning publication/projection/phase properties are tested.

Historical preparation before result-first capture: a linked source/installed-tarball SDK witness launched six real public compositions with one launch per model request and immediate PID/state/generation capture, then releases their bounded fixture gate after all receipts. Their explicit Unicode command-metadata excerpts exceed the shared byte budget; diagnostic-aware rows suppress the old formatted-stdout fallback: one automatic batch supplies the model context with an inventory reference, ordinary bounded file reads verify its complete SHA-256/bytes/membership, and exact omitted counts agree with visible rows. All six natural outcomes retain explicit `not_selected` primary bindings; composition body permission is not widened. Each layout retains one agent run/one accepted batch, eight model requests, six public spawn calls and no native completion-send queue or status-polling tool. Terminal order is checked against the inventory, not assumed to equal launch order. This witness also recovers all captured diagnostic references, not all result bodies. A fourth source/packed mode now launches six real **bare one-attempt commands** with >2-MiB primary sources, actual memory-tail truncation and long Unicode command metadata to exceed the same shared byte budget without changing production preview limits. The model receives one captured-member inventory reference; ordinary bounded strict-UTF8/hash/range/code-point checks recover every exact canonical primary binding/source, including omitted members, and both prefix/tail secret redaction. The full source size alone is not an overflow trigger: primary previews remain 160 code points, so Unicode metadata drives representative row pressure. Source hashes may repeat; exact Run/generation/source bindings still differ and must match. Each overflow mode remains eight model requests/six public spawns/one batch/no status-tool polling/native sends, with immediate durable launch capture and fresh ESRCH cleanup. Those four modes cover eight layout scenarios/28 real public producers. A fifth source/packed mode separately proves the **row cap** with one real public bare Run plus 64 explicitly synthetic legacy metadata companions: 65 captured members, exactly 64 shown and one omitted. Its counterfactual byte upper bound keeps the existing header/inventory/footer and adds the omitted minimal row; it still fits below16KiB, excluding byte pressure as the cause. The model-context inventory verifies all65 exact identities/generations/statuses, the omitted companion and the real primary reference/source; all65 handled markers bind their captured generations. Controlled synthetic timestamps keep the genuine outcome first and assert no live-clock/native facts. Three requests/one public spawn/one actual batch/one agent run/no status polling or native sends remain. Those five modes cover ten layout scenarios/30 actual public producers; the synthetic records are not extra launches, source permissions, OS membership or fan-out capacity proof. Broader artifact/summary/error/selection acceptance remains open.

### Artifact Outcome Capture

`artifact_inventory_protocol` is an ambient detection hint, never body permission. Only eligible member collection calls the retained-evidence owner to admit exact owner/generation, one strict canonical result and natural outcome classification. It preserves first-result null/unavailability without following a healthy later source. An available descriptor must match the deterministic inventory path and the complete independently admitted index/view/source projection, hash/bytes/counts and canonical terminal status. Post-stop captures, mismatched statuses, malformed bindings and source loss become explicit unavailability; no original target, raw metadata path map or sibling source substitutes for it.

Packet admission curates/freezes optional flat `artifact_inventory`/`artifact_inventory_unavailable` fields through the shared data schema and rejects competing legacy `artifacts` paths for inventory-aware members. Legacy packets remain readable. The shared operator/model renderer emits full dynamically fenced source/generation/hash/byte/declaration metadata and says availability/production are not asserted and bodies were not read. `not_declared` stays quiet; other unavailability is explicit. Journal reload, phases, model projection and retained member-inventory projection do not reopen sources or repair availability. Whole-row budget omission retains these captured descriptors through the scoped member inventory.

The source/installed-tarball public SDK tools-mode journey now recovers all five declarations from the **artifact reference parsed from actual model context**, alongside the primary-text reference, using ordinary bounded strict-UTF8/hash-checked file reads. It checks that no legacy target-path slice appears in the completion batch. This is bounded metadata-outcome acceptance, not file creation/content proof, all large/binary/row-limit/omitted-primary scenarios, manual phone/TUI visual quality, native scope closure or release readiness.

### Diagnostic Outcome Capture

`result_diagnostics_protocol` is a marker hint only. Eligible collection calls `readRunResultDiagnosticOutcome` with the expected terminal status. One exact owned canonical snapshot must have a cooperating protocol, natural classification, matching done/failed status and a curated first binding **before any diagnostic source read**. Captures, foreign identities/paths and status mismatch cannot gain terminal or body authority. Saved null/unavailability remains unchanged even if an orphan source later becomes healthy; no raw `result.error`, formatted stdout, sibling file, mutable Result view/index or live privacy reproject substitutes for it.

Available references require the complete deterministic source's strict UTF-8/hash/bytes/closed schema, full scalar-valid field set and exact canonical field names. The closed-source decoder is shared with saved-role readonly follows, not their weaker recorded-view classification. Source/frame fences remain observations, not multi-file atomicity, durable immutability or authenticity certificates. No work/producer reconstruction, process probe, export/repair or ACK occurs.

Packets curate/deep-freeze flat result_diagnostics/result_diagnostics_unavailable and optional diagnostic_excerpt data. An excerpt selects error, else failure_reason, else command as retained diagnostic data, not as the fresh visible-result policy. New outcome rendering withholds command excerpts while preserving their references and old-layout replay. The excerpt is a literal prefix of at most 1000 Unicode code points with exact decoded-field UTF-8 range and total/shown/omitted counts. The data-only excerpt codec does not grant primary publication. Detached excerpts and any legacy output competing with a diagnostic-aware binding, including null, refuse packet admission. not_recorded stays quiet; other unavailability explicitly has no legacy body fallback. Reference-only packets disclose recorded fields without inventing an excerpt. The shared renderer preserves literal whitespace/CRLF/BOM/U+FFFD/backticks, full dynamically fenced source/generation/hash/bytes/field names, metadata-only/not-primary scope and other recorded fields not shown. The admission-privacy label applies to recorded fields, not a whole reference/identity envelope. Eligible collection omits reader.identity/ownerId but retains complete member generation and diagnostic binding; formatting and captured inventory preserve those references literally. Original first-result diagnostic publication now checks complete header identity and the generated source path/generation/hash against original privacy before source retention/first binding. Unsafe refs bind immutable source_reference_redacted without changing code/acceptance; quiet no-field absence and safe original refs remain recoverable. The pre-repair source-only witness preserved a private variable root through a separate post-host-exit DTO collector/pending projection; source/compiled-dist validation now projects only explicit unavailability for that case, without a source ref, excerpt or legacy fallback. Neither witness was actual SDK/model delivery. Original publication/ref privacy, current file observation and recipient lifetime remain separate. The narrow publisher repair and subsequently accepted [same-session ordinary file-research contract](run-supervision.md#same-session-file-investigation) are distinct. Resume of that logical session needs no original producer key to investigate its owned files; this does not recertify older curated excerpts, repair a formatter/source, change packet phases or activate a new default route. Reload/phases/rendering do not reread sources or refresh availability.

The historical pre-result-first source/packed SDK profile recovered complete diagnostic JSON from the reference parsed from actual model context, matching the canonical first binding alongside primary/artifact refs. Its six real one-element compositions carry long Unicode command metadata to force byte overflow; the captured-member inventory recovers all six diagnostic refs, including omitted rows, but never their excerpts or formatted stdout. Primary remains not_selected for those compositions. Real runner failure7 and diagnostic-publication loss also project metadata/refusal without a raw legacy body fallback. The added six-bare-command mode also recovers omitted available primary refs through that exact captured inventory; it does not extend composition primary permission. This is bounded synthetic-provider/public-runtime and literal-renderer evidence, not all failures/summary/primary/fan-out cases, manual TUI/phone quality, native closure or release readiness.

### Failed-Natural Diagnostic Witness

A sixth source/packed SDK mode now launches one real gated command that writes long multilingual diagnostic stderr and exits7. Actual execution evidence and first canonical natural result both retain code7; the fixture never substitutes detached-runner exit for workload code. At the third model request one automatic failed batch carries exactly one diagnostic reference and explicit primary_not_selected_for_failure, with no primary/body authority or synthetic companion.

The reference parsed from actual model context matches the canonical first binding and ordinary bounded strict-UTF8/hash/byte reads recover the full projected command-error metadata JSON. Its error field equals the entire canonical result.error after prefix/tail Bearer and producer-admission literal masking; this is not a claim to raw/unformatted stderr or complete task output. The literal1000-code-point error prefix, full UTF-8/count/omission values, BOM/CRLF/U+FFFD/backticks/Unicode tail and separately unshown failure_reason are checked. Prior model-owned spawn arguments deliberately contain the fake literal canary; redaction assertions apply to delivered batch/source, not a rewritten model history. A different canary written only into raw runner stdout after proven producer exit appears in neither metadata nor model batch, proving no legacy stream fallback.

One agent run/three model requests/one public spawn/one batch/zero status-tool polls/native sends and immediate real PID/state/generation/fresh-ESRCH cleanup remain. That historical six-mode profile covered twelve layout scenarios/32 real public producers, with the row-limit synthetic companions still separately labeled. This bounds one real failed-natural diagnostic path, not failure-primary permission, all failures/summary/selection/artifact cases, manual visual/external-model quality, native closure or release readiness.

### Large Declaration Inventory With Real Outputs

A seventh source/packed SDK mode launches one real gated bare command, no synthetic companion, and writes an8-MiB binary plus6-MiB UTF8 file while declaring1800 artifacts. These caller-owned workload files exceed the separate4-MiB context-source allowance without a launch/file quota. Fixture-only lstat checks their regular-file sizes; no artifact body is followed/read/hashed by the fixture inventory recovery. Product inventories still state contents not_read, availability not_observed and production_provenance not_asserted; file observations by the test do not upgrade declaration provenance.

The third actual model request carries one automatic done batch plus its exact canonical inventory reference. Ordinary bounded strictUTF8/hash/full-byte reads recover the complete >64-KiB declaration source under4MiB: every ordered name/reference/optional field is checked,1799 paths are disclosed and one admission-secret path is null/artifact_reference_redacted, never a usable masked path. The <=64-KiB reference view shows zero declarations with exactly1800 omitted. The <=16-KiB packet retains the full inventory reference/count, no target path slice, withheld secret or legacy declarations. Fake secret values already in model-owned spawn arguments do not imply whole-history redaction.

This exposed a genuine runner defect: duplicating meta.artifacts in command.done exceeded the unchanged65536-byte Trace event limit and falsely converted successful work into code1. Runner Trace now reuses the already prepared inventory descriptor/unavailability instead of copying declarations. The public witness checks natural0, bounded nonattention command.done, no raw artifacts map and exact equality of its inventory descriptor to the canonical first result; other command/capture/session/level evidence remains unchanged. It neither catches/ignores arbitrary Trace failures nor raises quotas or grants a Trace reference terminal/body authority.

That historical seven-mode profile covered fourteen scenarios/34 actual public producers, with existing synthetic companions separately labeled. This bounds one large declaration/privacy/binary-output path, not every artifact type/limit, target-body permission, all summary/selection cases, native closure or release readiness. Immediate receipt capture remains; after validating the durable frame, the parent now rechecks every captured positive safe PID for fresh ESRCH immediately before state removal. Live/denied/unknown probes retain state and primary/exact probe causes; a focused mocked-probe property covers absent/live/denied classes without asserting native authority. Owner tests, not this SDK journey alone, prove exporter/readonly target-probe refusal.

### Public Source Loss And Visible Packet Reuse

An eighth source/packed SDK mode starts one real gated bare command/no synthetic companion and verifies natural0 plus healthy canonical primary/artifact/diagnostic bindings after producer ESRCH. The fixture bounded-checks the exact three generation-bound source references, then explicitly parks their original files outside evidence without deleting/recreating sources or touching result/view/index. It leaves a separate raw runner stdout canary. At the third real model request one automatic done batch has three exact source_unavailable reasons and no available source refs, primary tail, legacy body/path slice or stdout canary; canonical result bytes remain unchanged.

A dedicated fixture-only tool then moves those same original files back after checking that product code has not repaired the absent paths. Ordinary full-byte/hash reads confirm restored originals. At the fourth actual model context the captured batch content and identity are byte-identical and still unavailable, equal to its one saved public SDK custom-message entry, while canonical result bytes remain unchanged. This is explicit test manipulation, not implicit product repair, producer/work reconstruction or newly acquired publication authority. It proves reuse of one visible capture across two model-context builds, not restart/durable-journal reload, independent FS-I/O instrumentation or global immutable storage; owning packet tests retain those narrower reload/phase/no-source-read responsibilities.

The mode uses one agent run/four requests/one public spawn/two tool executions including the explicit fixture restoration/one accepted batch/zero status-tool polls/native sends. There are now eight modes per layout/sixteen scenarios/36 real public producers. Immediate durable launch capture and parent fresh-ESRCH cleanup remain. Broader summary/selection/artifact cases, external-model/visual acceptance and native/release gates remain open.

## Acceptance, Presentation, And Recovery

Returning boundary drafts is a proposal, not an SDK receipt. An active completion batch advances through queued acceptance to finalization only when exact model-bound `context` or a bounded active-session parent-chain read proves the committed entry. If another extension replaces or invalidates the proposed draft chain, the absent batch remains pending and can retry with the same identity. Idle delivery advances immediately after `sendMessage()` returns. Acceptance marks every still-present member generation terminal-handled and retains a bounded owner receipt. The `context` lifecycle adapter also deduplicates completion envelopes and handles exact urgent-steer presentation; presented steer writes `delivery.steer_presented` in the exact Run generation.

The generation-fenced Trace marker prevents a retained historical steer from replaying after bounded owner receipts rotate: suffix compaction cannot retain the older steer while discarding its newer presentation marker. Missing, archived, pruned, or replaced Run state needs no marker because it can no longer replay that original generation.

Recovery rules:

- Send failure: keep `pending`, record failure evidence, and retry.
- Pending batch after a boundary attempt or restart: inspect the bounded active Pi session chain for the exact batch ID and content. Proven presence finalizes; proven absence permits retry; incomplete or conflicting evidence stays pending with a diagnostic.
- Completion send accepted: finalize immediately and release the next epoch.
- Crash leaves a queued completion: queued itself proves `sendMessage()` acceptance, so finalize without resend or content reformatting.
- Presented urgent steer: never resend.
- Session or context replacement: close timers and callbacks; never deliver through stale context.
- Owner mismatch: do not inspect, acknowledge, or deliver the envelope.

Session evidence inspection must reuse the existing bounded owned-session readers rather than adding raw unbounded session parsing.

## Explicit Urgent Steer

Extend canonical Trace attention with `"steer"`:

```json
{
  "kind": "checkpoint.blocked",
  "summary": "Approval required before destructive migration",
  "attention": "steer"
}
```

A steer event is:

- explicit and actor-authored;
- admitted to the durable owner delivery journal before Pi delivery;
- sent through `deliverAs: "steer"` with `triggerTurn: true`;
- presented only when its exact event ID appears in model-bound `context`;
- retried after delivery failure without duplicate presentation;
- independent from the eventual root-terminal batch.

Pi steering is a safe-boundary continuation, not token-level interruption: while streaming, Pi delivers it after the current assistant turn finishes its tool calls and before the next LLM call. If Pi is idle, it triggers a new turn immediately.

Fresh urgent-steer text uses observability's single AX formatter after the runtime's exact retained event lookup. There is no omitted-selector compatibility branch for new messages; saved envelope.content is replayed directly. Fresh ordinary notify/followup uses its one AX formatter at the existing sink, sharing only the pure checkpoint/body/literal-group projection: first-eight-slot reference coverage is unchanged, and no urgent16KiB shared limit/reservation is added to ordinary delivery. Source run/checkpoint metadata is block YAML, bare without a selected body and delimited before a raw zero-added-indent body when present. The legacy body selection keeps its500UTF-16 pair-aligned source allowance, original stringify faults, authored JSON/fences, ellipsis and unknown-count basis, not normalized or recovered original text. Typed whole-reference sequences retain first-eight unique-slot selection, Artifacts-before-Run-files order, honest shown/omitted/total coverage and later-group reservation under the same16KiB COMPLETE serialized message bound. Raw malformed or overlarge essentials refuse before reference reads; unfit minimum coverage also refuses before admission. Ordinary delivery inherits no compact48KiB/depth ceiling. No next action is guessed from body text.

Envelope.content is itself the captured presentation, so no extra journal field or retroactive formatting aspect is required: pending/queued/presented recovery replays that exact string. Existing identity must be checked before formatting, including when current source text would fail new formatting. The source and installed owners preserve that behavior with malformed current summaries and older partial-reference content. Ordinary routing remains one visible notification per event and only followup's non-displayed pi-actors-run-trace message with the same content/original event details. Physical order, source/seen-id/startup priming and sink throw semantics remain unchanged; already committed strings are not regenerated. Pi details/IDs/acceptance, completion batching, delivery diagnostics, source and native permissions remain separate.

New urgent diagnostics are fresh UI projections, not rewrites of envelope.content or a saved formatting version. Event/attention/stage records keep missing-generation or failed admission retryable; they do not assert that no journal effect occurred or instruct workload replay. Failed send requests leave delivery/presentation unconfirmed. Unknown/conflicting recovery keeps the exact queued envelope and evidence status/reason without a forced resend. Raw diagnostic Markdown/CRLF stays opaque under the existing240UTF-16 source allowance; pair-safe clipping uses boundary …/[omitted: unknown], malformed visible text is unavailable, and exact private-tail counts are never inferred. The journal's separately normalized/trimmed4096-unit last_error, attempt/failure facts, original Error/cause, recipient/generation checks, wake/retry policy and safe-boundary delivery remain unchanged.

Locally owned core runtime notices now also use AX fields without changing when they occur: callback failures preserve original error forwarding and opaque diagnostics; completion recovery starts with one newline so the SDK's Warning: heading stays above the AX fields, keeping the same batch/evidence/pending/reason and dedup/no-resend behavior; idle completion delivery says accepted only after the existing durable acceptance, not confirmed model handling. Shutdown counts and whole literal summary path explicitly carry teardown-report basis, never positive native scope closure. Notification severity/no-throw/stale-context containment, stored packets, source fields and stop/teardown behavior are unchanged. Watcher and retirement messages now arrive already projected as AX records by their observation owner and still pass through untouched. Whole literal paths, opaque diagnostics and raw watcher signatures/dedup/rearm meaning stay with that owner. Retirement reports stop returned/cancellation reported/skip/failure with unconfirmed closure, not new native actuation or a no-effect promise; the transport neither retries nor reinterprets those messages.

Urgent steer capacity is bounded to 64 unpresented envelopes within the same 1 MiB owner journal. Capacity pressure remains visible and retryable; it never degrades into generic follow-up or drops an admitted envelope silently.

## Settled Lifecycle Ordering

`onAgentSettled` must use this order:

```text
active-context and exact-owner check
-> completion flush
-> if a batch was sent, defer automatic Recipe review
-> batch-triggered model run settles
-> schedule automatic review only when no batch remains
```

Another extension may start work during `agent_settled`; recheck `ctx.isIdle()` immediately before sending. A completion/settled race places each generation in either the current immutable batch or the next batch, never both.

## Validation Contract

Implementation is complete only when source and packed-extension tests prove:

1. Multiple Runs finishing during active work produce one boundary entry and one next model request before idle, after all tools in the current batch finish; no native steering/follow-up enqueue occurs.
2. Idle completions inside the debounce window form one batch.
3. Completion/settled races project every generation exactly once.
4. Send failure and restart before queueing retry without a handled marker.
5. Restart in the narrow queue-acceptance/finalization boundary neither loses nor duplicates the batch.
6. Boundary proposals do not acknowledge terminals early. Exact committed-entry evidence or idle send acceptance acknowledges members atomically and idempotently; urgent steer still requires exact `context` presentation.
7. Replacement generations sharing a Run id remain distinct.
8. Silent, stopped, cancelled, handled, and foreign-owner Runs remain excluded.
9. Legacy or malformed `command.done` attention, including `steer`, remains non-projectable.
10. Explicit steer reaches the next safe Pi boundary once and root terminal still batches later.
11. Overflow, corruption, journal backpressure, archive/prune races, and stale contexts fail safely.
12. Completion flushing precedes automatic Recipe review.
13. Pi 1.0.0 is the minimum source and packed lifecycle baseline; coding-agent and TUI peers share that floor.
14. The packed extension runs through the public SDK with a synthetic provider, proving one batch reaches the next request before settlement for both a full tool batch and a tool-free final answer, while preserving preceding boundary entries.

Focused observability and delivery tests precede TypeScript/build/import checks. The acceptance checkpoint then runs full product validation, dependency audit, package dry-run, and ABCd context validation.

## Product Boundaries

Active overlays and idle follow-ups share the same batch identity, bounds, lineage, terminal authority, and acceptance journal. They differ only in the Pi scheduling port and its acceptance evidence. Urgent semantic steer remains independent; completion status never implies urgency. The extension has no dependency on Telegram and does not modify Telegram reply or preview ownership.
