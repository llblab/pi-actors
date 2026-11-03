# Windows Process Observation Recovery

Status: User-approved architectural preparation. The first inert Windows x64 prototype is independently reviewed and passes scalar/one-row-shared compatibility on one directly owned ready child. The private raw-wire codec is now implemented and independently reviewed, with mirrored properties and normal build/invariant/process-owner integration; it is not imported by production readers. The subordinate-adapter preparation contract below has independent identity/fallback and artifact-handoff review, with an explicit raw-null exclusion closing the identified profile-admission gap. This is not an adopted binary-distribution or default-activation decision. Broader profiles and full-load convergence remain unproved. Production readers, packaged native assets, full-SDK fixture interception and default backend selection remain unchanged. The existing [invocation-local identity contract](coordinator-delivery.md#invocation-local-windows-identity-observation) remains the production contract until a separately reviewed change supersedes a specific clause.

## Problem and non-goals

The current Windows reader starts PowerShell for each independently fresh scalar acquisition and each bounded shared acquisition. Both commands now project only consumed properties, but native convergence remains unproved. CI [41915780299](https://github.com/llblab/pi-actors/actions/runs/41915780299) finished with eight successful checks, Windows installed failure and macOS installed cancellation for hosted-runner capacity. Windows installed failed both packed genuine research and source public-spawn acceptance; public packed execution was not reached.

The original failed public settlement bracket contains one synchronous shared call of 4511.520 ms in a roughly 8294.288 ms driver-local bracket. This establishes substantial blocking cost, not the cause of the entire policy gap or the original runner's state. Numeric PID presence, a later final-precommit snapshot and cross-process duration sums cannot establish original-runner survival or exit. The separate research reader retains its existing 20000 ms parent timeout; the captured SIGTERM does not identify its last operation.

The later unchanged-production candidate `16a3417` completed [normal validation 42018306856](https://github.com/llblab/pi-actors/actions/runs/42018306856) with nine successful checks and Windows installed failure. Source-and-packed private research passed this time; source public-spawn failed in the first `overflow` cohort, and public packed execution was not reached. The original slightly wider 9773.292 ms driver bracket recorded one shared call of 5651.349 ms; original-runner exit remained unproven. This is still a PowerShell-path failure, not a native-adapter result or evidence that query cost explains the entire gap. The isolated MI pass does not relabel it.

The goal is cheaper fresh observation with unchanged evidence strength, not a cache, longer deadline, new supervision system or a diagnostic subsystem for its own sake. Product correctness, observation quality and speed are separate gates.

### Bounded original-runner diagnostic

The public SDK fixture now has a temporary observer, with failure-only output, for the first `overflow` Run in each layout driver. It reserves one constructor candidate through public `node:diagnostics_channel`, matches executable/full public arguments/state directory/PID at successful `spawn`, and retains that original object's `close` callback facts. Private receipt binding follows the unchanged durable capture and requires the exact frame object and immutable signature. An unrelated first candidate makes the diagnostic unavailable; there is no replacement search, spawn interception, product hook, extra query, timer or wait.

Optional `failure_evidence.original_runner` freezes facts at settlement catch entry, revokes callbacks, attempts owned teardown, then projects frozen observations with post-attempt teardown uncertainty. `close_not_observed` means callback not observed, never “alive”; unavailable binding or listener coverage admits no close timestamp. A valid `sampled_ms` is only the same-driver catch sample, not admitted close evidence. Positive close-before-catch does not establish eight-second compliance, exact kernel-exit timing, descendant closure, absence or cleanup authority. Failed removal may leave an inert callback and remains unconfirmed.

Source, pure-property and independent implementation review cover this diagnostic; actual source/packed SDK and Windows convergence remain separate gates. It changes neither the shipping PowerShell reader nor the ESRCH, original-close, workload, watchdog or fresh-absence cleanup requirements. Retain uncertain roots; do not add manual probes or cleanup to improve diagnostic yield.

## Selected architecture

Recommend a one-shot user-mode Windows helper using the documented native Management Infrastructure client API against local `root/cimv2`, `Win32_Process`, WMIDCOM. Each invocation owns one application/session/query operation, consumes complete results, releases native resources and exits naturally. It receives numeric PIDs and a fixed query profile only, never expected identities, Run metadata, paths, control instructions or cleanup authority.

```text
Existing scalar/shared admission and original frame
  -> internal fresh acquisition
     -> one-shot native MI application/session/query
  -> compatibility decoding
  -> existing identity comparison and frame/callback fences
```

This removes PowerShell initialization, not synchronous provider cost. MI result retrieval can still block. Neither speed nor deadline recovery follows from the API choice.

- `runs-process.ts` continues to own acquisition/decoding/native identity. The helper is a platform adapter, not another lifecycle facade.
- `runs-status.ts` retains original metadata/ownership/physical-frame admission and independent assembly/fallback/revalidation.
- `async-runs.ts`, `runs-results.ts` and Control retain their current authority boundaries and checks. No production hook, public backend selector or observation bridge is introduced in the first slice.
- Native observations never survive an invocation or cross a callback. No broker, daemon, retained PID map or asynchronous stale snapshot substitutes for a fresh read.
- A helper session/operation is query-resource ownership, not an original-child lifecycle capability.

### Representation and failure contract

The existing consumed identity remains exactly:

```text
start_time = decoded CreationDate string
command = `${string ExecutablePath or ""}\n${string CommandLine or ""}`.trim()
cwd = absent
```

Do not reconstruct command lines, strengthen optional path visibility, canonicalize paths or silently rewrite historical fingerprints. Native FILETIME, DMTF, MI timestamps and the PowerShell JSON date are not interchangeable strings. The prototype must retain typed MI timestamp components privately and validate its candidate formatter against real reference values, including offset and precision. Unknown profiles are unsupported, not guessed. Unicode and optional/null/type handling must preserve the consumed JavaScript strings without normalizing or dropping UTF-16 code units.

Scalar and shared profiles remain distinct: only the shared result needs a returned native ProcessId for correlation. Query inputs remain unique positive safe integers, at most 64 for shared, with no DWORD truncation. Numeric-only textual query construction remains bounded at 4096 ASCII characters; complete output remains bounded at 1 MiB. Complete retrieval, duplicate/foreign-row rejection and borrowed-instance copying precede consumption. A missing row, denied access, malformed output or query failure is not native absence.

The prototype must distinguish transport, retrieval and operation outcomes, copy borrowed values before the next retrieval, drain to `moreResults=false`, close operation before session before application and release owned error data. A cleanup hang or leaked helper is a falsifier, not permission to force exit.

The next candidate's fallback contract is specified below, separately from current production behavior: no retry through an identity mismatch or replacement, no rebinding to later metadata and no fabricated absence. Existing PowerShell remains the baseline for unsupported optimized profiles; neither the inert experiment nor this design changes reader selection.

## First implementation checkpoint: inert differential prototype

Implement only excluded test/prototype sources under `tests/fixtures/`, with no production imports, package assets or native default selection. The checkpoint owns a native MI source, one standalone harness and focused protocol/adapter properties in the existing installed-script owner where appropriate. It does not add skips or alter the fixed SDK journey.

1. Launch one controlled child owned directly by the harness. Capture the original ChildProcess and its actual spawn/close receipts, require a genuine ready message, and retain its workload gate until observations finish. This uses ordinary owned-child fixture lifecycle, not a global spawn interception or cross-process clock carrier.
2. Obtain a reference identity through the existing PowerShell reader and retain that reference in a fixture-owned on-disk frame. Exercise the historically consumed representation, not a native-formatted replacement presented as old data. The harness must verify any additional full-instance reference command against the actual old grammar rather than accidentally comparing the candidate to itself.
3. Query the same original child through native MI. Compare decoded date and combined-command strings, native identity digest and existing verifier decisions against the retained reference. A wrong expected identity must reject without repair. A child replacement, unexpected close, unsupported date profile or incomplete query is not a successful comparison.
4. Record acquisition durations separately in the harness's one local clock. Close receipt times describe callback dispatch, not exact kernel-exit times; no clock alignment or inference that query cost explains the whole policy gap is allowed. Do not log raw command lines, identity strings, paths, stacks or private digests; report bounded compatibility flags, status categories and durations.
5. Release the child normally, await actual close and require fresh ESRCH immediately before any deletion. Keep uncertain state on all failures. No kill, unref override or forced process exit.

Start with one ready child and scalar plus one-row shared comparison. Broader PID/type/Unicode/date partitions use deterministic properties; broader live differential coverage follows only after the basic native experiment succeeds. One comparison cannot establish all-provider equivalence or full-load performance.

### Native execution and CI

The current Linux/offline TypeScript build cannot manufacture a Windows helper. The initial native build is a test-only Windows x64 experiment using the hosted runner's installed SDK/MSVC, with exact toolchain/source/artifact provenance recorded. No operator compiler, download-at-install, privileged setup or release asset is added. If those tools are unavailable, report an unexecuted experiment rather than success or a product skip.

Use a separately bounded Windows prototype CI job/workflow if needed to obtain the native experiment. Keep its CPU workload on a separate runner from the unchanged product benchmark, use existing pinned action conventions and read-only permissions, and add no publication/OIDC behavior. Existing normal validation is not weakened, bypassed or relabeled by a successful prototype. Prototype wiring and trusted build-command quoting are part of implementation review before any guarded same-PR update.

A CI watchdog is an administrative execution bound, not observed helper/child absence. Canceled or hung experiments retain uncertainty and never authorize cleanup. Do not increase existing product, SDK or fixture deadlines to obtain a pass.

## First native result

On candidate `16a3417`, [isolated experiment 42018307139](https://github.com/llblab/pi-actors/actions/runs/42018307139), job `127214304702`, passed on Windows x64. Toolset `14.51.36231` and SDK `10.0.26100.0` compiled source SHA-256 `3c0a68950d86d5b00de4fe0ee475ec9b1b50ccb728085716cee312a515f3abe5` into artifact SHA-256 `28f136e00048a7c025a67fd21fcd257d7c30af299af70e89bd327847c6d47716`; the inspected direct dependency list was `kernel32.dll`, `mi.dll`. This is recorded build provenance, not a reproducible-build or general runtime-dependency guarantee.

All four focused properties passed without skips. Scalar and one-row shared results matched the reference's consumed date, combined command, digest and verifier decisions, including wrong-expected rejection and unavailable-proof distinction. Both native helpers closed naturally; the original child was spawned, ready, released and closed, and every captured PID qualified by fresh ESRCH before cleanup.

Measured acquisitions were 66.703 ms scalar and 56.641 ms shared; sequential current/historical PowerShell references measured 1450.226 ms and 342.047 ms. These are one child's sequential observations with different warm-up conditions, not an equivalent full SDK benchmark, statistical speedup or recovered eight-second settlement. The production reader was unchanged. Accept only this tested child/profile; do not infer 64-row/large-Unicode/non-UTC/provider-error/architecture parity or default activation.

## Next integration contract — reviewed preparation

This is a concrete preparation boundary, reviewed independently for identity/fallback and artifact handoff, not approval to ship or activate a native executable. Open work and approval gates remain solely in `BACKLOG.md` (N1); this section owns the proposed design. The selected approach is one private subordinate adapter plus reviewed committed assets, not a general backend framework or second release assembly.

### Ownership and supported representation

The native producer now has one unrouted source owner at `native/windows-mi/windows-mi.cpp`; the standalone differential remains a test consumer. Invocation/asset verification and raw-MI compatibility decoding belong to `lib/runs-process-windows-mi.ts`, with mirrored adapter properties. Keep one producer implementation rather than independent prototype/shipping copies. Source placement does not approve executable distribution, package inclusion or production routing. `runs-process.ts` retains legacy identity construction, digest/comparison and its public contract; the subordinate adapter must not import that owner. At eventual activation, change only the acquisition seam in `readWindowsIdentity` and `readWindowsProcessIdentities`. Do not move original-frame admission, liveness/status precedence, scalar fallback or callback/publication/Control/teardown fences from their current owners.

The complete private adapter will return validated legacy-shaped property rows and a closed acquisition outcome, never expected identities, verifier decisions, Run metadata or lifecycle capabilities. Its implemented observation stage retains typed timestamp components and raw optional-field facts explicitly as `decoded_unadmitted`, with no date-to-legacy promotion, process invocation, asset loading or profile-admission port. Initial raw-null refusal belongs before normalization; native producer properties and the asset/invocation seam are separate slices. This stage alone cannot supply a process identity or establish freshness. Scalar and shared profiles stay distinct; shared rows require unique exact selected-PID correlation regardless of result order. Preserve the consumed string/optional normalization above, including `.trim()` and UTF-16 code units, lone surrogates and non-BMP pairs. Unexpected MI types, missing required properties and unsupported representations make the entire optimized observation unusable; no stronger path lookup, argv reconstruction or identity-format migration is permitted.

The same private owner separately implements `decodeProvenanceBinding` for an already parsed, flat JSON-value fragment with exactly `source_sha256`, `executable_sha256`, `executable_bytes`, `originating_source_commit` and `originating_build_job`. Complete lowercase ASCII hash/commit lexemes, positive safe-integer byte counts and exact positive decimal-string job identifiers decode into fresh primitive claims labeled `decoded_binding_unadmitted`; malformed fragments return only `unusable/invalid_binding`. Source and installed compiled properties cover those boundaries, including final line terminators and copy independence. This is not a complete manifest, trusted descriptor, byte reader or asset verifier: it checks no file/hash, authentic origin, compiler, dependency or profile and grants no execution permission. Full-manifest format/resource bounds, trusted exact-byte selection, fixed asset lookup and invocation remain separate preparation work; arbitrary executable JavaScript objects are outside this JSON-value contract.

Do not promote the prototype's broad `candidateDate` range wholesale. The initial candidate is UTC-only; production eligibility requires a positively recognized environment/representation profile and real PowerShell serialization witnesses, including precision boundaries. An MI timestamp's zero offset alone, a runner label, a local JavaScript timezone or equality with an expected identity is not that predicate. The first experiment did not record a complete environment-admission witness. Establish the exact native environment/version facts and executable predicate in the broader differential before claiming a supported optimized profile; until that predicate is evidenced, keep profile admission unsupported. Non-UTC/historical profiles remain baseline-only unless separately admitted.

Optional `MI_STRING` null normalization defines codec compatibility only, not admission of an unproved provider-visibility partition. Until that partition has real differential evidence, the initial optimized profile admits only rows whose raw `ExecutablePath` and `CommandLine` are non-null `MI_STRING` values. Preserve and check those raw facts before normalization; a null optional field in any returned row makes the entire optimized acquisition unsupported and selects baseline once. Broader null admission requires separate evidence and a predicate based on observable raw fields/environment facts, never expected-identity equality. Do not strengthen path reads. Non-null fields alone do not establish all-provider equivalence, and they do not bypass the UTC-profile gate.

The six-byte ASCII escape for every UTF-16 unit is deliberately retained for the minimal candidate. Sixty-four 32,767-unit command strings alone require about 12.6 MB before other fields, exceeding the 1 MiB output limit. This is a real unsupported partition, not 64-long-command parity. The native serializer must bound the whole response, continue draining, close resources and reject the entire optimized observation on overflow. Never truncate rows, accept a prefix or widen the budget. Test the actual native producer at the limit; parser-only properties do not prove bounded serialization.

`tests/fixtures/windows-native-mi-producer-properties.cpp` includes that exact owner with test-only compile-time MI/stdio call targets. It exercises actual input, UTF-16 escaping, row copying, aggregate bounds, finite draining, cleanup-attempt ordering and output-failure control flow without another serializer or live process query. Malformed-row witnesses leave subsequent rows otherwise admissible, so duplicate/cardinality refusal cannot mask the intended validation. The isolated Windows workflow now compiles both translation units and executes these producer properties; acceptance requires results bound to the actual sources, compiled artifact and toolchain rather than a Node-only pass. Synthetic MI faults, controlled copy `bad_alloc` and close/delete counters prove only their exercised control-flow/attempt partitions, not real OOM, provider permission or physical resource closure. The real one-child differential remains separate.

### Native producer property checkpoint

Candidate `62a0dcb` passed [isolated Windows validation 42308530762](https://github.com/llblab/pi-actors/actions/runs/42308530762), job `128203935655`, on checked merge `ea114af6b82ab540d7a2f33a83093799e3c377d3` and tree `bb1afbe85e90e2fd4e417eb1afe4c5128bf424f3`. MSVC `14.51.36231` and SDK `10.0.26100.0` compiled the unchanged single producer and corrected property fixture; all seven native property groups and 256 assertions passed. The prior actual Windows run's one failure was a test comparing the 12,582,528-byte escaped command payload to 12 MiB instead of the normative 1 MiB limit. The one-line correction preserves whole-response refusal, all 64 retrievals and the unchanged producer.

The job also passed all four Node properties without skips and the existing one-child scalar/shared differential against current and historical PowerShell. The tested producer artifact was `7a50b77cb3fa6f767896d4f78ddc52f160ea362bad59f8b565d71d211f506fec`; the property artifact was `4e772cb8226d281a2a84600c951057f11c60e507898935f2cb2061fdc3406a63`. Both helper closes, the original child's ready/release/close and fresh ESRCH cleanup were observed. These results close the bounded producer-property/source-promotion checkpoint, not synthetic-fault physical cleanup, broader provider/UTC admission, executable distribution, exact shipping-asset review, default routing or full-load SDK convergence. The shipping reader remains PowerShell.

### Acquisition and fallback

Distinguish complete native observation, unusable/unsupported optimized acquisition, and no admitted identity from a completed observation. These are private acquisition outcomes, not new public status values.

- Unsupported architecture/profile, absent/corrupt/wrong-version assets, unavailable dependency, policy-denied execution, spawn failure, nonzero exit, malformed/incomplete response or representation overflow may select the existing PowerShell acquisition once for that acquisition. Preserve its exact grammar, options and existing scalar/shared error behavior; do not convert a native failure into absence or leak new raw errors into public surfaces.
- Do not bypass execution policy, relocate/copy an executable to evade blocking, download a replacement, elevate or add a retry loop. Runtime damage selects the baseline; required release-asset damage is a build/package failure instead.
- A completed native response with a missing PID has no admitted identity for that PID. It does not itself trigger baseline repair and never establishes absence. Preserve the existing independently fresh higher-level shared/scalar fallback against the original fenced row; do not rebind to replacement metadata.
- Once a supported native identity reaches comparison, mismatch is final for that observation. Neither baseline acquisition nor a more privileged path may repair it. Changed original metadata/ownership/physical frames discard the observation instead of retrying through replacement.
- Only an independently qualifying fresh liveness observation can produce `dead_pid`. Helpers, empty responses, missing rows, errors, earlier liveness samples and Kill receipts cannot do so.

The first adapter implementation is unrouted: no production import/selection, public backend knob, environment enable switch or dormant default-enable flag. Test the adapter directly. Invocation resources are fresh each time; no result/profile shortcut may smuggle cached native identities across callbacks.

### Artifact and release handoff

Recommendation, pending explicit owner approval: distribute a reviewed unsigned Windows x64 executable as versioned committed repository/npm assets. This adds executable bytes, not a new operator compiler/runtime/privilege requirement. Unsupported architectures remain on the baseline. Approval of this distribution model is distinct from production activation.

```text
native/windows-mi/windows-mi.cpp
native/windows-mi/win32-x64/<helper-version>/windows-mi.exe
native/windows-mi/win32-x64/<helper-version>/manifest.json
dist/native/windows-mi/…
```

The versioned manifest binds protocol/profile version, architecture, native source SHA-256, executable size/SHA-256, actual compiler/SDK/build arguments, inspected dependencies and originating exact source commit/build job. The originating commit is the checked-out commit whose source was compiled, not the later asset-import/release commit; retain it unchanged while checking the current source digest. No manifest-containing-own-commit requirement is introduced. Helper versions are independent of the npm version. Digest/manifest verification is integrity and provenance, not executable authenticity, a signature, reproducibility or comprehensive dependency availability. The manifest is not allowed to self-authorize an unreviewed binary/profile.

The isolated Windows workflow may prepare the exact candidate executable plus manifest as a retained CI artifact after its own differential, with existing read-only permissions, no OIDC, no publication and no automatic repository writes. An authorized maintainer imports those exact reviewed bytes in a normal asset-review change; a separately rebuilt executable cannot borrow that artifact's evidence. Retain only executable/provenance/closed test results in the distributable handoff, never private process identities, command lines, fixture state or raw diagnostic logs. Candidate artifact retention does not authorize committing or publishing the executable.

After asset approval, `scripts/build-dist.mjs` verifies the manifest/source/artifact binding and copies the approved bytes into its temporary candidate before atomic replacement. Existing `build:check` compares the binary inventory/bytes too. Add root `native` to the npm allowlist only at that admitted packaging change. Resolve fixed versioned assets relative to `import.meta.url`: source `lib/` → root `native/`, compiled `dist/lib/` → `dist/native/`; never search cwd, PATH or caller-supplied locations.

Offline Linux build/prepack must only verify and copy existing bytes: no Windows execution, MSVC, download or compiler prerequisite. Required asset corruption/missing data must fail packaging rather than silently publish an incomplete optimized package. The existing reusable validation and Ubuntu immutable-tag publish job each check out the repository independently; no native artifact handoff currently connects them. Committed reviewed assets preserve `release.yml` as the sole assembly/publication owner and avoid release-time downloads or a second publication service.

### Minimum broader differential

Actual Windows x64 evidence must use the exact proposed candidate bytes, not merely another compilation from the same source:

- Two simultaneously ready directly owned children, distinct commands and a real long Unicode/quoting payload with non-BMP characters, spaces, quotes and backslashes. Compare each scalar and the two-row shared observation against current projected PowerShell and the historical full-instance reference, correlating by PID rather than returned order.
- Retain genuine PowerShell identities in owned on-disk frames. Check exact date/combined command/digest, legacy-metadata acceptance and wrong-expected rejection without mismatch fallback. After a captured child's natural close, missing native rows remain unsupported observation; fresh ESRCH independently supplies absence.
- Record the real environment/profile facts needed for UTC admission and verify the exact predicate independently of expected identity. Controlled date/precision boundaries must also use actual Windows PowerShell serialization; disclose formatter fixtures separately from actual `Win32_Process` rows. Unsupported profiles must select baseline without guessed date repair.
- Exercise denied launch and MI initialization/query failure through narrowly scoped controlled ports without changing machine policy or privileges. Injected denial proves error routing, not actual provider-permission parity; an unproved provider partition remains unsupported/baseline-only. Do not claim access to arbitrary protected processes.
- Every captured helper/child closes naturally, and every deletion requires fresh ESRCH. A watchdog, timeout, aggregate timing or callback close receipt is not exact kernel-exit timing or authority to remove uncertain state.

Deterministic ports and native producer properties separately cover PID boundaries 1/64/65, duplicates/invalid safe integers/no DWORD truncation; reordered/duplicate/foreign/missing shared rows and scalar multiple rows; optional null/type codec partitions plus whole-query initial-profile refusal before null normalization; UTF-16/lone-surrogate round-trip; profile/date refusal; complete-wire bounds including actual six-byte expansion; malformed UTF-8/JSON, incomplete retrieval, nonzero/signal/spawn denial, absent/corrupt/wrong-version assets and cleanup faults. Unknown liveness stays unknown. Synthetic 64-row frames cover cardinality/size without spawning 64 workloads or scanning arbitrary PIDs. Existing original metadata/ownership/source-byte/physical-frame and callback-freshness families stay with their owners.

### Preparation, shipping and activation boundaries

The dependency-ready preparation is the unrouted private adapter/codec, mirrored properties, promoted native source and reviewed candidate artifact build/retention path. Keep the package's binary inventory unchanged until asset ownership is approved. No global SDK spawn interceptor or research-marker layer is justified by this integration question.

Before shipping assets, independently review codec/fallback, native resource closure and provenance/distribution, then verify source/dist lookup, offline normal build/prepack, package inventory and exact shipping-byte differential. Before default activation, separately admit the routing change and pass unchanged source-and-packed genuine SDK/native validation through the actual shipping path. The fixed Run layout, workloads, watchdogs, settlement/close/research boundaries, privacy/history/budgets and independently fresh checks remain those of the existing contract; standalone helper latency does not prove recovered SDK settlement.

## Deferred observation and activation work

Do not implement the full 87-Run spawn interceptor or research marker stream merely because a design exists. The inert prototype's directly owned child already supplies its necessary lifecycle evidence. Add further observation only for a specific unanswered question after reviewing its cost and provenance.

If original SDK lifecycle discrimination remains necessary, a later fixture-only interceptor may observe the exact returned ChildProcess in a single launch slot, bind once to the first captured Run/owner/generation/physical frame and retain closed dispatch facts. No error listener may suppress product errors, no original spawn/return/throw/ref/unref/kill behavior changes, and failed/ambiguous binding stays unavailable. Public DTOs are not physical-frame capabilities; any additional file-only capture must be explicit, bounded and reviewed. Close receipt before numeric presence does not by itself prove PID reuse; absent receipt under a blocked event loop does not prove a live original child. ESRCH remains the deletion gate.

For research timeout diagnosis, a later closed enter/ok marker stream can identify last observed entered/completed operations, not assert the phase active at timeout. It must preserve exact provider/workload rejection and ordered cleanup causes, reject arbitrary stderr noise, retain existing raw capture bounds and use the smallest justified record budget. The proposed 512-marker/48-KiB allowance is not adopted. No timestamps, signal handler or extra native probe is necessary for stage ordering.

Default native activation is a later checkpoint requiring consumed-string/status compatibility across supported profiles, naturally closing resources, source/packed parity and unchanged full native acceptance. Approved optimized architectures need auditable source/build/artifact provenance and install-time-independent prebuilt assets; unsupported profiles keep the baseline. Do not promise arm64 support, reproducible binaries, blocked-executable fallback or no-runtime-prerequisite support without verifying them. No package/backend activation follows from a successful scalar experiment.

## Rejected paths and acceptance gates

Reject further query-flag experiments without new evidence, PID-only lifecycle joins, timeout inflation, stale async caches, native-check elision, direct-image-path substitution, undocumented Nt/PEB command-line reads as a presumed drop-in, or a persistent PowerShell broker without demonstrated need.

The first checkpoint is accepted only after independent identity/clock/lifetime, native cleanup, temporal/error/privacy and packaging review; deterministic protocol/adapter checks; and an actual native differential result. Production activation separately requires the unchanged 87 planned genuine Runs/layout, nine modes, both 40-spawn cohorts, 300 s/10 ms workload, 900 s Windows/300 s other SDK watchdog, eight-second ESRCH settlement and ten-second original-close boundary. Preserve all source/privacy/generation fences, framing/history contracts and fresh ESRCH before each deletion. Loaded-host UI acceptance and release automation remain separate gates.

## Evidence references

- [Get-CimInstance, PowerShell 5.1](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-5.1)
- [MI_Application_NewSession](https://learn.microsoft.com/en-us/windows/win32/api/mi/nf-mi-mi_application_newsession)
- [MI_Session_QueryInstances](https://learn.microsoft.com/en-us/windows/win32/api/mi/nf-mi-mi_session_queryinstances)
- [MI_Operation_GetInstance](https://learn.microsoft.com/en-us/windows/win32/api/mi/nf-mi-mi_operation_getinstance)
- [MI_Timestamp](https://learn.microsoft.com/en-us/windows/win32/api/mi/ns-mi-mi_timestamp)
- [Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
- [Node 24 ChildProcess events](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
