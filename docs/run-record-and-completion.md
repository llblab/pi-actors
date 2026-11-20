# Run Records and Completion Cards

**Status:** partially implemented. Session-scoped Run naming, the per-session name ledger, cross-session singleton refusal and the canonical-file declaration guard shipped in 1.0.0. The canonical outcome record (`result.json` schema, `primary.txt`/`diagnostics.json`/`artifacts.json`), the clean state root and the remaining card changes are still the proposed contract, not a description of the installed extension. The format cut has no migration, legacy reader, dual writer, or compatibility period.

## The contract in one paragraph

A logical Pi session names its Runs. Each Run directory belongs to one execution and is never reused. `run.json` answers what was launched; `result.json` answers what was recorded at the end and where to read more; `execution.json` and `trace.jsonl` explain how it happened. Completion presents a small YAML map of the outcome and useful files, then the selected Actor Markdown when there is one. The card is a captured presentation of those facts, not another result store or a filesystem inventory.

## Identity and launch

- The public address remains `run:<name>` in the current logical Pi session. The address is exact, never “the latest execution of this Recipe.” Another session can have the same name. Resume continues the same namespace; a new or forked session gets a new one. A Pi process, Telegram thread, working directory, or copied transcript is not a session identity.
- Without an explicit name, a new execution gets `<recipe-stem>-<ordinal>`, beginning at `0` per resolved Recipe in the session. A registered-tool invocation and direct spawn share the allocator if they resolve to the same Recipe. The name basis must distinguish same-named Recipes from different Skills; use a stable qualified stem for Skill Recipes. Inline launches can use `run-0`, `run-1`, etc. as their own series. The ordinal is a launch sequence, not a completion position or the separately specified completion-stream index.
- `as: run:<name>` requests that exact name. It neither restarts nor attaches. It is refused if that name was already used in the session; the refusal names the collision, the earlier status and generation, and the fact that the earlier execution is still addressable by that name rather than reusing its directory. Only two launch kinds may re-enter a name: a singleton service keeping its own address, and an internal per-work-item caller that declares re-entry explicitly. Auto and explicit names share the same collision check. Auto allocation begins at zero and advances past occupied candidates; failed reservations can leave gaps. A terminal Run, retry of the whole launch, and retry of a command are different things: a new execution needs a new name, a command retry does not.
- Reserve names and update counters under the same session-scoped admission boundary. Retain name reservations across archive/prune and counters across resume. Do not infer the next number from a directory listing or reset corrupt/missing established state to zero. Use one session name ledger; avoid synchronizing an allocator with an independent name index. The existing navigation catalog is evidence for lookup, not by itself a reservation ledger. The ledger is not a Run: it lives beside the session namespaces (`<run-state-root>/names/<session-key>.json`), so a session directory contains Runs plus their own retention records (`archived/`, `preserved-artifacts/`, `retention.jsonl`, archive tombstones) and never the ledger; those container names, the root-level runtime entries (`names`, `index.json`, `teardown`) and Windows device aliases are refused as Run names or session keys, and a name may be as long as the filesystem allows a directory (the current bound is 200 characters, matching the ids real Recipes and fixtures use).
- Path components must be bounded, portable, and collision-checked consistently on case-insensitive filesystems. Reject separator/dot traversal, reserved runtime names, and device aliases. Session metadata or path spelling alone does not grant access. Keep current owner/generation and stale-writer fencing internal; an internal `run_instance_id` is not a second user address or part of a path.

### Singleton services

Singleton is a **launch policy**, not an identity format. A compatible repeat invocation of a singleton Recipe can return its admitted live Run without reserving a name. An incompatible invocation must not attach or launch a duplicate. Once a fresh execution is admissible, it receives a new exact name. For example, `music-player/playback` locates the service via the Recipe and returns `run:music-player.playback-0` while that instance is live; the next fresh execution of the service in that session gets its next ordinal. Neither `Control` nor `inspect` substitutes the new execution for the old address.

Session-local storage does not narrow an existing service exclusivity boundary. Service admission must protect the same resource across sessions before permitting fresh launch, and may refuse an otherwise live instance to a different owner. Implemented now: a singleton launch scans for an active instance of the same `singleton_recipe_id` under another session and refuses instead of starting a duplicate service; the compatibility check stays scoped to the Run directory it protects. State intended to survive service restarts (for example a validated playback checkpoint) belongs to the service, not to a reused execution directory. Service adapters must resolve the current admitted execution or use an exact one; they must not guess a directory or gain Control by discovering a name. No legacy `run:<skill>` alias is required by this proposal.

## Disk layout and ownership

Use a clean state root, illustrated as `tmp/pi-actors-v2/`: a sibling of the old root, not another level of nesting inside it. Root spelling is private configuration; the layout is one session level followed directly by named Runs.

```text
<run-state-root>/<session-key>/
  .delivery.json             delivery state shared by the session's Runs
  package-review-0/
    run.json                 launch identity and Recipe provenance
    result.json              first recorded outcome and useful read map
    primary.txt              selected response/output, if retained
    diagnostics.json         complete safe diagnostics, only on overflow
    artifacts.json           declaration inventory, only on overflow
    execution.json           command and attempt map
    trace.jsonl              recorded events
    …                       existing support files with an identified reader
  package-review-1/
```

The tree omits the session name ledger and internal ownership, process, lifecycle and Control records. Those are support state, not navigation defaults. The first cut need not rearrange prompts, captures, runner logs, or session journals; sort those by actual readers and retention needs before consolidating. A Run can refer to a user artifact outside its directory without taking ownership of that artifact. Moving or pruning Run state must not silently delete arbitrary artifact targets.

Keep delivery in the session's `.delivery.json`: it owns packet membership, acknowledgement, and recovery, not workload results or name allocation. Parent/descendant links and coordinator delivery scope are explicit metadata, not inherited merely from a directory position. Keep `draft-sleep` with the shared Recipe-library scheduler, outside individual session directories. The reviewing Run belongs to its launching session; the scheduler's batch state does not. During the format cut, do not resume an old scheduler batch by guessing a new Run from its name.

## One canonical outcome

`result.json` is the first accepted **record of the workload outcome**, committed atomically with its published references. It is not a live status cache. It distinguishes an accepted terminal outcome from a capture after a stop request; a stored exit code alone is not terminal state, delivered Control, or native closure. Subsequent publication does not change the first outcome or silently repair a missing binding. `run.json` and the existing lifecycle/Control owners retain their distinct facts.

- **Outcome:** Acceptance, recorded time, exit code when known, and terminal state only when established.
- **Response:** `response` describes selection and retention. Its fixed role resolves to `primary.txt` with byte length and content digest when retained.
- **Diagnostics:** `diagnostics` is inline by default; large retained text uses `diagnostics.json`. Distinguish `not_recorded` from `unavailable`.
- **Artifacts:** Named declarations carry references and evidence states. Keep bounded entries inline; `artifacts.json` is the complete declaration inventory only when it needs its own retention budget.

### Privacy and persistence delta

Today the canonical outcome persists the diagnostic strings **as recorded**: `lib/runs-results.ts:547-551` copies the raw `command`, `error` and `failure_reason` into the admitted diagnostic candidate, and the same raw values are written into the root `result.json` capture. Projection happens later, at export time, through `projectDiagnosticMetadata(..., createRunRecipeTextRedactor(captured))` (`lib/runs-context-exports.ts:616,651`). A canonical record that carries diagnostics itself therefore moves the projection boundary: the admitted text must be projected by the existing owner (`lib/recipe-projection.ts:122`, `capturedBodyPolicy`/`capturedSecretMask`) **before** it becomes the recorded value and before any size or clipping decision. Keep that owner's ordering rules: project the original source spelling, mask an ambiguous encoded scalar whole instead of its syntax, never pass protected JSON through the generic text path again, and do not re-derive privacy from live metadata. If the reuse is refused, record an explicit diagnostic unavailability rather than persisting raw text; the workload outcome does not change.

### What is already the implemented shape

Three parts of this card are not new invention. New captures already render `files` as rooted groups of relative entries (`lib/run-delivery.ts:1818` via `rootedCompletionPath`, `lib/run-delivery.ts:1797`), declared artifacts are already folded into their own parent-root groups (`lib/run-delivery.ts:1865`) with a group-level note that existence and production are unproven, and the visible layout already omits role keys and diagnostic field inventories. The genuine changes are the completion-independent record design, the naming and layout cut, and the removal of duplicated saved representations where a caller is shown to be derivable.

For example, the relevant fields of a failed Run might be:

```json
{
  "outcome": { "acceptance": "natural", "state": "failed", "exit_code": 2 },
  "diagnostics": { "state": "inline", "error": "Package manifest is missing." }
}
```

Diagnostics are complete privacy-projected values for the selected `command`, `error`, and `failure_reason` fields, not raw logs, a second Actor answer, or arbitrary stack/session dumps. Apply admission privacy **before** persistence in the agent's canonical outcome and before size decisions. Inline keeps the selected fields whole. Overflow retains a separately bounded, safe source and binds it by role, byte length and digest; a concise explanation may be retained in `result.json`, but not a second full copy. If policy, source limits or publication prevent a diagnostic binding, record why it is unavailable without changing the workload outcome. Do not fall back to raw stderr, prompt text, or the primary response. Audit existing consumers before eliminating raw outcome fields or the separate `evidence/result.json` view; retain a second saved representation only if its distinct historical or privacy guarantee still needs it.

Fixed source roles derive their paths from the validated Run directory; do not store absolute self-paths. Byte digests verify content, not authority. Dynamic local file references must be normalized Run-relative paths and are validated under the owned directory. External artifact targets are explicitly external; no reader automatically follows them, treats their presence as proof the Run created them, or gains access from the declaration. Publish an observed state only from admitted evidence; by default a declaration is just `declared`, even on success. Source writes, first-result commit, and delivery are distinct effects. A crash may leave a file without an accepted binding; neither a reader nor a new writer may promote it by presence alone.

### Persisted outcome representations today

Five artifacts currently describe one Run outcome. Recording them separates the guarantees that a single record would have to replace:

- **Root `result.json`** — first accepted workload outcome, written once by `lib/runs-results.ts:562` after producer admission. Readers: `lib/runs-start.ts:48,116`, `lib/runs-status.ts:254`, `lib/inspector.ts:51`, `lib/runs-outcomes.ts:356` and the context-exports capture (`lib/runs-context-exports.ts:602`). Guarantee: the canonical, first-writer-wins outcome, including the fields the workload reported as recorded. It is also the only place where an outcome exists at all; everything else is derived.
- **Published saved view `evidence/result.json`** — bounded projection written by the Result exporter (`lib/runs-context-exports.ts:634`) and listed in `context-index.json`. Reader: `readRunResultContextView` (`:472`) and the diagnostics view (`:849`), which treats this file as the authority for the diagnostic descriptor. Guarantee: an immutable, generation-bound publication with coverage/counts that later reads verify instead of re-deriving from a mutable canonical outcome.
- **Diagnostic source `evidence/result-diagnostics.json`** — complete projected `command`/`error`/`failure_reason` text (`RUN_RESULT_DIAGNOSTICS_MAX_BYTES`). Guarantee: complete diagnostic text even when the published view only carries previews and counts; its hash and byte total are what the view references.
- **Primary source `evidence/primary.txt`** — selected Actor/command output under its own 4 MiB budget. Guarantee: full text beyond the displayed prefix, with an independent size bound and no diagnostic mixing.
- **Artifact inventory `evidence/artifact-inventory.json`** — bounded declaration inventory. Guarantee: the complete declared list when the inline entries exceed the view.
- **Delivery journal copy** (`tmp/pi-actors/delivery/<owner-key>/projection.json`) — captured member references, excerpt and unavailable markers (`lib/run-delivery.ts:34-43`). Guarantee: replay of the message that was admitted, without reading Run sources again.

Since 1.0.0 the three retained sources use these fixed names per execution: the generation binding lives in the descriptor (`run_instance_id` and SHA-256), a fresh generation removes the previous copies before work, declarations may not occupy them, and saved bindings/packets keep their original generation-keyed spelling for exact replay.

Derivability: the published view is *not* a copy of the canonical outcome — it adds publication, coverage and preview decisions that the canonical record does not carry, and the diagnostics reader depends on exactly those. The diagnostic source, primary text and inventory exist for size and scope reasons: each is bounded and referenced by hash, and none can be reconstructed from the canonical outcome once the workload's own copies are gone. Making the canonical record hold projected diagnostics would remove the *duplication of meaning* but not the source: a retained source is still needed for complete text beyond the record's own budget.

## Completion: one YAML header, optional Markdown

The completion shown to the user and supplied to the agent has the same semantic card. Runtime-owned facts go in deterministic block YAML; authored subagent text goes **after** it. Keep the [AX framing contract](./agent-experience.md#document-envelope-and-yaml-syntax): `---` around the header only when there is a separate body. Metadata-only cards are bare YAML. Capture the typed card plus body boundary before the render step. A literal `---`, `run:`, or `files:` line inside the answer cannot add metadata, another Run, or a follow-up action.

Representative successful subagent card:

```markdown
---
run: package-review-0
state: done
files:
  - root: "/home/user/.pi/agent/tmp/pi-actors-v2/session-a/package-review-0"
    entries:
      - path: primary.txt
        status: "Actor response; admission privacy"
      - path: result.json
      - path: execution.json
  - root: "/home/user/project/reports"
    entries:
      - path: package-review.md
        status: "Declared output; existence not verified"
---

## Package review

The package is ready for release. The report covers the two remaining warnings.
```

`files` uses the existing rooted list shape: one `root` per group, with exact relative `entries[].path`. It serves both Run-owned reading points and selected declared outputs. No separate visible `artifacts` block and no role keys such as `result: result.json`. For a subagent, put its retained response first when admitted and useful, then `result.json` and the few files that add value for this outcome. A recoverable failure diagnostic may lead a failure without a response. `execution.json` serves drill-down; `trace.jsonl` normally belongs in explicit inspection. Inline diagnostics have no separate link. `name` adds a useful logical label; `status` adds facts the filename cannot convey. Omit routine absent optional files and repeated size/hash/format/generation data.

Additional roots are a **projection of already admitted references, not discovery**. For example, a Recipe or spawn explicitly declaring the target `/home/user/project/reports/package-review.md` can supply the reference in the example. Once admitted to the receiving session, split that exact path into its literal parent directory and leaf; a target under the Run's recorded root shares its group. Relative declarations can be anchored only from the captured launch base under the artifact owner's existing admission rules, never the renderer's current directory. If a reference cannot safely be represented under a known root, omit it from the file map and report meaningful unavailability without inventing a path. A grouped root does not assert filesystem containment or give access to its other children.

The default model is explicit declarations, not watching the workspace, attribution from a Git diff, collecting arbitrary tool writes, or scraping paths out of Actor Markdown. Undeclared edits outside the Run stay out of the card, even if the Actor mentions them. A declaration is not creation or existence evidence; distinguish an admitted observation from a declaration and do not infer production from either. No target reads are performed for grouping. Use whole entries and preserve omission coverage; the full admitted declaration inventory stays reachable from `result.json`. A reference is not an attachment or permission to read it.

For a failed execution with no Actor-written body, a compact message can be just:

```yaml
run: package-review-1
state: failed
error: "Package manifest is missing."
files:
  - root: "/home/user/.pi/agent/tmp/pi-actors-v2/session-a/package-review-1"
    entries:
      - path: result.json
      - path: execution.json
```

`error` is a safe selected summary from the outcome, not the runner's raw exception. For non-subagent Runs use bare YAML unless the selected output has an eligible text body; plain command output does not become authored Markdown by inference. If there is a subagent body, deliver the admitted text with its Markdown intact: no quoting, code fence wrapper, generated body heading or runtime footer. Rich rendering may change the visual presentation, not the captured text or meaning. External targets and paths mentioned by the Actor in the body are authored text, not verified file references.

### Bounds, continuation and batches

- Preserve the existing bounded whole-packet envelope (48 KiB UTF-8, including metadata and transport-owned correlation) and captured membership/order safeguards. Protect Run identity and accurately recorded state first; prefer the canonical result location over auxiliary paths. Allocate room for an eligible body, then omit secondary references/entries as needed. Never shorten a path, invent a missing name, or silently drop covered Runs. A batch carries the same per-Run card and explicit omitted-member coverage, not a different filesystem schema. Render each card/body using trusted recorded boundaries and the existing root/descendant admission, not by splitting Actor Markdown on delimiter-looking text.
- Use `omitted.files` for a positive count of eligible entries dropped to fit, regardless of whether they are internal files or declared outputs. Report expected-but-unavailable references separately from budget omissions; do not expose policy-withheld paths. No empty groups. Batch member omissions belong to the packet, not an arbitrary member's header.
- A clipped body keeps a Unicode-safe prefix of the admitted text. Report exactly known omitted characters as `body.omitted_chars` and upstream uncertainty separately as `body.upstream_loss: unknown`. Mark the selected source entry `Read first` only when more of the displayed answer or diagnostic is in that source. On a primary prefix with a valid exact source, `continue_from_line` belongs on that entry: it is a one-based physical line, repeating the line cut in the middle. Omit the pointer if unavailable. A complete body with no known loss does not need a `body` node.
- Freeze the admitted file map, body selection, omission and text at delivery capture; retry/replay must not rediscover, reselect, or rerender the stored message against current disk state. UI may collapse the technical map if expansion reveals the exact admitted references. A missing/invalid presentation binding cannot hide content or turn body text into runtime metadata. When a batch is displayed, present independent card/body regions so an unfinished Markdown fence in one body cannot capture a sibling card.

## Manual investigation

Same-session investigation stays ordinary: open the `result.json` named in the card; select `primary.txt`, `diagnostics.json`, or a declared artifact deliberately. To investigate a command, open `execution.json` and follow the recorded attempt/stream reference. Open `trace.jsonl` for chronology rather than reconstructing state from logs. For a live or incomplete Run, begin at its owned `run.json` and recorded execution information instead of guessing a result from present files. An exact location helps navigation; it is not a grant of read, publication, Control, or native authority. A new/forked session does not acquire rights from copied text.

## Current implementation inventory (R1 evidence pass)

Facts below were read from the current source; they are the coupling the format cut must handle, not approved design.

**Launch entrypoints.** Every Run is created through `AsyncRuns.startRun` from four call sites in the library: the public spawn adapter (`lib/tools-spawn.ts:184`), the registered-Recipe tool adapter (`lib/tools-local.ts:273`), and the two silent automatic-review launches (`lib/automatic-review-runtime.ts:102,128`). Name selection now happens in `allocateRunName` (`lib/async-runs.ts:272-296`): a singleton keeps its own address, an exact caller or internal name is recorded once (and refused on a second use unless the caller declares re-entry), and everything else is allocated as `<recipe>-<ordinal>`. The older chain (Recipe `run_id`, Recipe `name`, file basename) supplies only the stem. Public names arrive only through `as:` in the spawn adapter or a non-singleton `run_id` argument on a Recipe tool. Automatic review supplies explicit names of its own: `draft-sleep-<batch>` (`lib/draft-sleep.ts:573`) and `tool-review-<reviewId>` (`lib/tool-review-scheduler.ts:633`). They are per-batch by design, so re-reviewing the same batch resolves to the same name rather than a new ordinal; those two call sites therefore opt into re-entry explicitly. The allocator keeps three name kinds distinct: auto ordinal, exact caller name, and internal per-work-item name.

**Declaration entrypoints that embed paths.** Several maintained Recipes pass `state_dir` themselves, so a new root or layout changes their behavior without any user input:

- `skills/actors/recipes/resource-locker-snapshot.json` used to default `state_dir` to a literal `~/.pi/agent/tmp/pi-actors/runs/coordinator-locker`. Resolved in 1.0.0: `state_dir` is runtime-owned (the snapshot Run's own directory always wins over a caller value), so the Recipe now takes an explicit required `locker_dir` and reads exactly that locker's state.
- `skills/actors/recipes/resource-locker.json` declares `{state_dir}/queue.json`, `{state_dir}/locks.json`, `{state_dir}/journal.jsonl` as artifacts inside its own Run root. These are live service data, not deliverables.
- `skills/swarm/recipes/subagent-prompts.json` used to declare `{state_dir}/stdout.log` and `{state_dir}/result.json` as `report_path`/`summary_path`. Those names collide with canonical runner and outcome files, so a completion card would present a declared copy as if it were the canonical record. Resolved: the recipe no longer declares those paths; a run's stdout and outcome are reached through their canonical roles, and a caller that wants a separate file asks the subagent to write one deliberately.
- `skills/music-player/recipes/playback.json` is the only maintained `singleton: true` Recipe. It takes `state_dir:path` as an argument, and the Skill text, the maintained Generative App and the documented Control/inspect examples all use the literal address `run:music-player`.

**Outcome and view consumers.** At least these currently read the Run root `result.json` directly: `lib/runs-context-exports.ts:602,779,1070,1819`, `lib/runs-outcomes.ts:356`, `lib/runs-results.ts:184,515`, `lib/runs-start.ts:48,116`, `lib/runs-status.ts:254` and `lib/inspector.ts:51`. The published saved view `evidence/result.json` is a separate export (`lib/runs-context-index.ts:20`, `lib/runs-context-exports.ts:849`) that repeats part of the outcome with previews and counts. Raw diagnostic selection is confined to `command`, `error` and `failure_reason` (`lib/runs-outcomes.ts:19`), with preview selection at `lib/runs-context-exports.ts:800`. A canonical-outcome redesign must therefore handle a direct-read canonical file, one published duplicate view, and a diagnostic projection, and show which of them still earns an independent guarantee.

### Cutover inventory

The layout change landed inside the existing state root, so "cut over" means finishing and reconciling, not moving a tree. What is already true and what still has to be decided:

- **Written now:** Runs at `<run-state-root>/<session-key>/<run>`, reservations at `<run-state-root>/names/<session-key>.json`, explicit names refused after one use, singleton launches refused while an instance runs in another session, and declared outputs refused on canonical root files and the nine `evidence/` export paths.
- **Not changed:** the root path itself, the delivery journal location (`tempDir/delivery/<owner-key>/projection.json`), the automatic-review roots, retention, and inspector defaults. Six library owners read the root through `getRunStateRoot()`/`runStateRoot` (`lib/paths.ts`, `async-runs`, `automatic-review-runtime`, `inspector-command`, `observability`, `run-ui-runtime`, `tools-inspect`), and 27 test/fixture sites still spell the on-disk path literally.
- **Observed divergence, decided:** a pre-upgrade Run directory that sits directly under the root is still *discovered* by directory scanning but is **not resolvable by name** in the new model. A probe with one legacy directory shows `discovered: ["legacy-flat"]` together with `byName: "refused: Run not found"` and `byPath: "done"`. Options: (a) leave it as observed and document that inventory may list legacy rows that only a path can reach, or (b) make discovery require the `<session-key>/<run>` shape for the default root while custom roots passed by callers keep their existing behavior. Option (b) hides pre-upgrade rows from inventory but changes a scanner that retention and observability share. Decision for 1.0.0: option (a). Old flat directories are left untouched and ignored; they are reachable by path only, age out through ordinary retention, and no reader reconstructs a name for them.
- **Ordering:** finish the naming and singleton decisions (R1.4), decide what a canonical outcome may store (R2.1), then perform the root/layout finish and the Skill/adapter updates in one pass. A fresh sibling root is not required to separate layouts: old flat directories are already unaddressable by name, so a new root would only hide them from a scanner that a decision above controls.

## Cutover and implementation gates

No data migration, old-format probe/fallback, dual write, transfer of pending deliveries, or retroactive renumbering. Leave the old tree and old transcript messages untouched. The new runtime uses only the new state root for affected Run and delivery state; an old link in a transcript is just historical text, not a request to resolve it against a new Run with the same name. Upgrade requires settling old active work and shared service/review ownership; parallel versions sharing exclusive resources are not assumed safe merely because their paths are different. No automatic cleanup or live reload is part of this work.

Reuse lifecycle/name admission for allocation, outcome/evidence owners for canonical publication and privacy, and delivery for the captured card. Renderers consume that admitted card; they do not read results or own paths. Keep the [coordinator delivery](./coordinator-delivery.md) and [run supervision](./run-supervision.md) guarantees that are not explicitly replaced here. The new card framing does not activate completion streams, change termination/Control, or broaden evidence privileges.

Before implementation approval, resolve the couplings recorded above: whether the name chain keeps three distinct name kinds, how `state_dir`-declaring maintained Recipes resolve under the new layout, how a declared copy that shadows a canonical filename is rejected or renamed, and which of the direct canonical readers, the published saved view and the diagnostic projection survive. Review singleton resource/adapter behavior, old active work at cutover, and current callers of the saved Result view and raw diagnostic fields. The preferred design is not permission to remove a distinct guarantee when its replacement is unproven.

Acceptance witnesses for the eventual implementation:

- **Names and ownership:** parallel same-Recipe launches, tool/direct equivalence, distinct qualified Recipes, explicit collision, same-session resume after prune, new/forked session, and exact stale Control refusal. Exercise supported path semantics on Linux, macOS and Windows.
- **Singleton:** compatible reuse, incompatible/foreign refusal, restart with a new address, safe service checkpoint continuity and two-session exclusion for the existing exclusive resource.
- **Outcome:** success, failure, capture without terminal acceptance, inline/overflow/withheld diagnostics, interrupted first publication, wrong owner or changed source, and declaration versus observed artifact. Show that no raw payload or unbound source becomes the delivered response, and that a recorded diagnostic string was projected before persistence rather than after export.
- **Completion:** source and packed SDK witnesses for a Markdown subagent, YAML-only failure, a clipped prefix with a real continuation, an external declared artifact, an undeclared workspace edit that must stay out of the card, and a multi-Run batch. Check delimiter-like Markdown, exact paths, whole-entry omission, packet replay without source reads and authorized terminal/phone rendering. The operating Skills and maintained service adapters must match the implemented contract before release.
