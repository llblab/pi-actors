# pi-actors

![pi-actors banner](https://raw.githubusercontent.com/llblab/pi-actors/main/banner.jpg)

Local Run kernel and persistent tool registry for [Pi](https://github.com/earendil-works/pi).

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

An **actor** is any runnable local capability: a script, tool, service, pipeline, or subagent. A **Recipe** is its reusable executable definition. `spawn` creates a **Run**—one concrete actor instance—which captures its Recipe, appends observable **Trace**, and may consume actor-local **Control**.

## Agent Experience (AX)

pi-actors adopts **AX — Agent Experience** as a project-wide design standard: give the agent visible, structured context for its next decision while keeping the same facts easy for a person to read. The adopted form is typed block-YAML runtime metadata with opaque authored content, not Markdown-list pseudo-objects. Inspector, tool results/errors and agent-bound outcomes should follow that direction as their owned rollout proceeds.

The [AX standard](docs/agent-experience.md) adopts JSON structured inputs → block-YAML runtime-output metadata, with Actor-authored text/Markdown preserved outside the header. This includes tool/spawn/status/Control/inspect output, not only completion results. It is an adopted direction, not a claim that current mixed-format emitters already conform; [BACKLOG.md](BACKLOG.md) tracks rollout. Machine protocols, privacy/source permissions and immutable saved messages remain separate. Current completion indices are packet-local; independent native owner-loss supervision, execution deadlines and public session completion streams are not enabled. The future contracts do not strengthen the existing stop/closure guarantees.

## Local Coordinator Model

Multi-instance systems commonly put instance creation and routing in an external gateway. pi-actors supports a different topology: the current Pi instance remains the coordinator, companion extensions such as Telegram provide presence, and explicit Runs perform bounded delegated work. The coordinator receives high-level outcomes, decomposes them, stays available for decisions, and owns integration plus final validation instead of becoming another undifferentiated worker.

This topology does not require every task to become a subagent. Short work with one natural validation boundary stays inline; delegation pays when clean context, asynchronous execution, independent judgement, parallel ownership, or coordinator availability exceeds its coordination cost. Bounded implementation can run with reasoning off while the coordinator selectively launches clean-context reasoning-enabled reviewers; several independent reviews can provide broader evidence than one author self-review. Boundary-delivered completion batches, durable Trace, and declared artifacts replace tight polling loops.

Design notes for [portable Recipe composition bundles and CodeMode interoperability](docs/composition-transport.md) are recorded separately. JSONL bundle loading is not implemented or included in the current UX/AX release; host CodeMode, when available, calls existing tools rather than replacing the Run kernel.

## Install

Requires Node.js 22.19.0 or newer and Pi 1.0.0 or newer.

```bash
pi install npm:@llblab/pi-actors
```

For local development:

```bash
pi install /path/to/pi-actors
```

The package contributes the extension and six capability-owning Skills for actors, artifacts, music playback, project work, Recipe memory, and swarm orchestration. Manifest-loaded packages expose those Skills through the package manifest so Pi resource filters and package provenance remain authoritative; a checkout auto-discovered directly under Pi's user or project extensions directory contributes its source Skills even when Pi selects the checkout's compiled entrypoint.

## Public Tools

### `spawn`

Create a Run from an active-Skill Recipe, an explicit Recipe file, or an inline command template:

```text
spawn template="sleep 30" as=run:demo
spawn recipe=project-work/repo-health values={"repo":"/work/project","model":"provider/model"}
spawn recipe=music-player/playback values={"source":"/music"}
spawn template="make test" as=run:test
```

Use a Run when work may outlive the current turn, needs steering, fans out, produces artifacts, or must remain inspectable. Short foreground commands can remain ordinary tools.

### `message`

Send one exact Control:

```json
{
  "target": "run:player",
  "action": "pause",
  "input": { "reason": "operator" },
  "verbose": false
}
```

Run targets accept Recipe-declared actor-local actions plus runtime-owned `kill`, `archive`, and `prune`, subject to Run state. Runtime targets accept only reserved review actions:

```text
message target=runtime action=review.retry input={"scope":"draft"}
message target=runtime action=review.retry input={"scope":"tool"}
message target=runtime action=review.reset input={"scope":"draft"}
message target=runtime action=review.reset input={"scope":"tool"}
```

Lifecycle `kill` remains runtime-owned rather than Recipe-declared.

### `inspect`

Inspect one exact management target:

```text
inspect target=run:test view=recipe
inspect target=run:test view=trace source=lifecycle lines=40
inspect target=run:test view=control
inspect target=runtime view=status
inspect target=runtime view=runs status=failed
inspect target=runtime view=triage
inspect target=recipes view=status
inspect target=recipes view=summary
inspect target=recipes view=doctor identity=music-player/playback
inspect target=tool:my_tool view=status
```

Recipe `summary` and `registry` are the same inspection path; only `verbose` selects compact text versus structured details. Recipe and tool views are listed above; `inspect` parameter help and unsupported-view refusals name the actual accepted view sequences.

A Run exposes exactly `recipe`, `trace`, and `control` views. Run-specific `inspect` and `message` require a current coordinator session whose id exactly matches the persisted non-empty Run owner; possessing `run:<id>` alone is not authorization. Missing-session, ownerless, and cross-owner access fails closed. Use `inspect target=runtime view=runs` for the current session's exact-owner inventory. See the complete [management inspection matrix](./docs/inspection.md).

### `register_tool`

Persist a maintained Recipe with `register_tool name=<tool> from=<skill>/<recipe> defaults={...}`, or register a trusted command through the separate `template` mode. Definitions live under `~/.pi/agent/recipes`. Treat a tool as callable in the current session only when the result reports `callable_now: true`; persistence, Recipe spawning, and registered-tool invocation are distinct states.

## Recipe

Recipes can declare:

- named typed args, inline fallbacks, configuration `defaults`, and composition `values`;
- imports and command-template composition;
- retry, failure, recovery, repeat, concurrency, and timeout policy;
- artifact paths;
- `control: ["action"]` only for inputs a service actually consumes.

Example controlled Recipe:

```json
{
  "async": true,
  "control": ["pause", "resume", "stop"],
  "artifacts": { "state": "{state_dir}/player-state.json" },
  "template": "{skill_dir}/scripts/player.mjs --state-dir {state_dir}"
}
```

Ordinary one-shot Recipes should omit `control`. Recipe imports compose definitions inside one Run; they do not create peer actors.

```json
{
  "imports": {
    "report": "artifacts/report",
    "review": "swarm/quorum-review"
  },
  "template": [{ "name": "report" }, { "name": "review" }]
}
```

Skill Recipe identity is `<active Skill name>/<Recipe filename stem>`. Recipe files have no top-level `name`; the filename is identity. `SKILL.md` `name` remains Pi host metadata and matches the Skill directory—pi-actors adds no second Skill identity field.

References have two classes: exact active-Skill identities such as `project-work/repo-health`, and explicit `.json` / `.md` paths. Entry file paths resolve from invocation `cwd`; relative imports resolve from the importing Recipe's directory; absolute paths remain exact. File-backed Recipes receive immutable `{recipe_dir}` and Skill Recipes also receive `{skill_dir}`. Skill components never become tools automatically.

String command-template leaves execute directly without shell interpretation. Use template arrays for sequencing or an explicit trusted shell/script when shell semantics matter.

## Trace

`trace.jsonl` contains bounded structured observations:

```json
{
  "id": "cfd0…",
  "ts": "2026-01-01T00:00:00.000Z",
  "kind": "progress.update",
  "summary": "Indexed 40 files",
  "data": { "files": 40 },
  "level": "info",
  "attention": "notify"
}
```

Trace fields are exact: `id`, `ts`, `kind`, and optional `summary`, `data`, `level`, `attention`. Address, sender, recipient, reply, and routing fields fail validation. Trace is a bounded retained suffix, not an audit archive: the canonical authority appends within 2,048 events and 4 MiB or atomically keeps the newest suffix plus one warning-only `runtime.trace_compacted` marker. That marker means older history was discarded; `result.json`, `execution.json`, terminal state, and declared artifacts retain their own authority. `inspect view=trace` reports whether retained history is complete. Reads are newline-safe and deterministic; first-party scripts never write this file directly.

Generic command lifecycle is Trace-only: runner-owned `command.done` records preserve completion and execution evidence but never request or project attention, including malformed legacy records carrying `steer`. There is no Recipe-level command-completion delivery switch. Semantic attention is explicit: `notify` shows visible status without a model turn, `followup` supplies ordinary checkpoint context, and `steer` requests urgent delivery at Pi's next safe assistant/tool boundary. `notify` and `followup` remain retained wake hints that may compact away, so persist recovery state or an artifact first. `steer` is admitted to the bounded owner delivery journal before `deliverAs: "steer"`, acknowledged only in exact model-bound context, and never suppresses the eventual root-terminal batch. Store large evidence in artifacts or bounded execution captures. New urgent steers keep the canonical checkpoint and whole optional references within 16 KiB, explicitly counting omitted paths instead of cutting a path; saved envelopes retain their original text. Essential text that cannot fit remains retryable before admission, not partially delivered. Ordinary notify/followup shares exact reference spelling and explicit eight-slot coverage; its wake policy is unchanged. Legacy body and steer-diagnostic clipping explicitly marks unknown omission counts when no retained privacy context admits safe numbers; it is not a new privacy or completeness guarantee.

Ordinary finite Runs project terminal results through one root-coordinator completion scheduler. Nested actors inherit durable parent-generation lineage: their own Pi sessions never emit completion turns, and their results wait for the complete containing top-level tree. While the root Pi is active, the next completed `turn_end` boundary snapshots all ready trees into one immutable bounded batch, appends one visible custom message after the full tool batch, and requests one next model step. This overlay uses boundary entries, not Pi's native steering or follow-up queue, so the model can integrate fresh results before its current run settles. Already-idle Pi retains a short debounce and one automatic follow-up wake. The operator and model receive the same parent-child tree with bounded actor outputs. Proposed boundary entries stay pending until exact model context or bounded active-session evidence proves acceptance; an idle send finalizes on successful Pi acceptance without requiring a later context callback. Sequence, parallel, repeat, and imported branches remain internal, while separately launched Runs retain exact independent generations. Silent Runs and synchronous stop acknowledgments remain non-projecting.

Implemented UX/AX subset: completions share48KiB UTF-8 including service fields, divided equally between up to64 candidate results: nearly48KiB for one,24KiB each for two,16KiB each for three. Whole admitted text fitting its share is result; otherwise preview carries the safe prefix and exact omitted count, without a fixed16KiB result/2KiB preview cap. Completions show admitted work output or the bounded executor-selected final Actor response, never command metadata. Saved packets keep their original budget/text; source-backed prefix selection occurs only at fresh admission, not replay/render. Direct Pi text-print answers and successful composition/retry responses use the original producer privacy; observed upstream clipping stays explicit and is not confused with preview loss. Ordinary completions can carry retained primary-text, artifact-declaration inventory and diagnostic-metadata references. Follow the exact reference for clipped or omitted evidence; it records capture-time identity/hash/counts, not perpetual readability. Artifact inventories list declarations only, not proof that target files exist or were produced, and do not grant body-read permission. Diagnostic excerpts identify the selected field with literal UTF-8/Unicode counts; their source contains recorded command/error/failure-reason metadata, not complete primary output. Source loss is explicit and never replaced by guessed legacy bodies or paths. See [Run supervision](docs/run-supervision.md) for implemented boundaries and remaining acceptance gates.

Implemented A2 subset: `inspect target=runtime view=runs verbose=true` now adds a bounded [root-first file map](docs/run-supervision.md#same-session-file-investigation) for the actual session's already cataloged directories. Follow selected locations with ordinary tools, without an original producer key. Source/npm-packed SDK fixtures resume the same saved session in a new process after real Run producers and their coordinator host have exited, then read the actual result and select recorded stdout via the mapped execution manifest with ordinary tools; another session gets no inherited branch. The read-only map exposes canonical starting-location coverage and expected format hints, not a full file inventory or format/completeness validation. Its published_sessions link locates the fixed role catalog physically under the owned Run root, even without a semantic index or producer key; this does not certify its body or historical publication. SDK checks select one controlled partial preview and also read an actual private-writer preview after its holder exits and the same saved session opens in another process. Exact tool-read paths and final byte/absence snapshots are checked, including selected-preview loss errors without cached/raw fallback; the private publisher uses controlled recorded-session sources, not genuine Actor conversations. A finite public spawn and later same-saved-session research also pass through real source/npm entrypoints, without replacement tools or copied lifecycle wiring. Corrupt catalogs stay unavailable without repair. Inventory filters observe current Run status, not the registration-time cache. Ordinary maps retain root-group recency with known failed children first; add status=failed to the verbose request for observed failed-subtree-first ordering across roots without filtering the full owned map or adding reads. Priority is partial observed data, not terminal authority. Launches and compatible singleton attachments now register after lifecycle release; catalog failure returns `catalog=unavailable` without failing or retrying the launched work. SDK fork/clone preserves inherited history but gives the new logical session no fresh map branch. Compact launch receipts now include exact-generation current-session starting locations without evidence-body or catalog reads, or explicit unavailability/whole-row omission. New completion batches freeze bounded same-session location rows at admission and render them after outcomes within the shared budget, alongside the optional current-session map command. Legacy absent/request-only packets retain their text; source/npm SDK verifies an explicitly requested result read from a terminal row. This closes representative navigation acceptance, not the release. Neither captured locations nor the request execute inspection automatically or grant copied/forked history fresh ownership. Legacy batches keep their original text; no full map is embedded into immutable outcomes. Compact/default inspection, curated previews and timing/work/native authority are unchanged.

Compact spawn/asynchronous-tool launch receipts use bare block YAML with nested file-location data and identify an existing Run reuse instead of implying another launch. Full `spawn verbose=true` metadata remains JSON during the staged rollout; private details and input schemas keep their machine formats. When a complete direct file-location row is shown, it replaces the redundant session-wide map hint; missing, unavailable or omitted rows retain that optional investigation command. Exact references, expert details, shared bounds and saved completion-packet text are preserved.

New automatic completion packets show direct `omitted:N chars` fields for positive tracked primary/diagnostic loss, counted in Unicode code points after privacy projection. Full retained references and older saved packet text stay unchanged. This does not yet cover every legacy summary/body or attention clipping path, nor grant broader output publication.

Runtime argument guidance stops at the execution handoff. Failures after an executor entry or launcher handoff keep their original cause/details, even if their wording resembles a missing or invalid argument. Later-step failures can follow partial work: do not blindly repeat the invocation. This changes presentation, not retry policy or native termination guarantees.

## Control

An exception does not guarantee an unapplied action: actor-local delivery can fail after handling is recorded, and retirement can fail after data has moved or been removed. Use existing owned evidence rather than replaying the action. The [partial-failure evidence map](docs/run-supervision.md#control-partial-failure-evidence-existing-facts-not-a-new-receipt-contract) distinguishes these paths from still-gated native stop receipts.

Controls persist to `controls.jsonl` before transport. One token-owned lock rejects a 65th pending Control or 1 MiB rewrite before admission, fails closed on malformed or stale-generation evidence, and atomically admits one record. Canonical transitions retain a 128-terminal tail, expected-state fencing, and 4 KiB errors. Admitted nonterminal Controls never expire automatically. Every record carries immutable `run_instance_id`. `inspect view=control` reports pending capacity, saturation, stale work, journal bytes, and bounded diagnostics.

Runtime-owned lifecycle and retention actions use the same `message` tool:

```text
message target=run:<id> action=kill
message target=run:<id> action=archive
message target=run:<id> action=prune input={"preserve_artifacts":true}
```

Compact Control replies report an understandable action stage instead of dumping status objects: queued/delivered is not handled; archive/prune success is complete; a kill attempt leaves full termination explicitly unconfirmed. Only a relevant evidence hint is shown (Control for actor delivery, Trace for a stop attempt, owned inventory after identity replacement); already-terminal refusal needs no routine follow-up. Use `verbose: true` on the original request for full JSON, not a repeated destructive action. Changed-owner/generation refusals also omit the replacement status from full/verbose replies; verbosity grants no extra scope. Same-identity receipt detail remains available. Actor-local dispatch exceptions still fail, conservatively leaving delivery, handling and effects unconfirmed; do not repeat automatically. Their optional follow-up starts at fresh owned inventory, not a copied stale Control id/generation. Raw causes remain Kernel-local even with verbose; oversized request targets are wholly omitted with explicit coverage under 16 KiB. This presentation/curation does not change the legacy stop engine or prove closure.

`kill` accepts only a currently running owned generation, bypasses actor-local capacity, and creates no synthetic Control. `archive` and `prune` accept only terminal owned Runs. Archive moves the entire Run state directory and leaves a tombstone. Prune removes Run state; declared existing artifacts survive only when `preserve_artifacts` is explicitly true, in which case they are copied to retained artifact storage before removal.

Startup Run cleanup and manual archive/prune share the existing `runs-retention.ts` owner. The seven-day filesystem-age threshold is unchanged; automatic cleanup additionally requires an owned generation, fresh runner ESRCH and the existing lifecycle/reuse and retained native/descendant guards. Unbound, unreadable, replaced or still-fenced state stays retained, including retention containers without Run identity. These checks are not whole-scope native closure proof. Ordinary temp cleanup does not retire Runs.

Long-lived services publish `control-endpoint.json` only when ready:

```json
{
  "path": "/path/to/control.fifo",
  "type": "fifo",
  "ready_at": "2026-01-01T00:00:00.000Z",
  "run_instance_id": "generation-id"
}
```

Supported transports are Unix FIFO and Windows named pipe. Every actor-local Control uses the same portable envelope: action is at most 64 lowercase ASCII characters, serialized JSON input is at most 380 bytes, and the newline-terminated wire record is at most 512 bytes. Put larger data in a declared artifact/path and send only its bounded reference or instruction through Control. Delivery revalidates owner, generation, state, and process identity under the canonical lifecycle lock.

## Run State

Owned state lives under:

```text
~/.pi/agent/tmp/pi-actors/runs/<run>/
```

Core files:

- `run.json` — identity, owner, generation, captured Recipe, policy, process identity;
- `trace.jsonl` — structured observations;
- `controls.jsonl` — durable Controls and outcomes;
- `control-endpoint.json` — generation-fenced service readiness;
- `execution.json` — command/session provenance and complete-capture references;
- `result.json`, command logs, progress, and declared artifacts.

The runtime preserves owner filtering, process-identity verification, lifecycle locking, shutdown kill independent of actor-local Control capacity, terminal reconciliation, bounded captures, owned Pi sessions, path containment, and redaction. Trace/Control quotas do not constrain user-declared artifacts, repositories, media sources, complete captures, or actor-owned workload state. Restart clears generation-local Trace, Control, endpoint, execution, and terminal evidence; archive preserves the bounded tree, while prune preserves only requested artifacts.

## Actor Inspector

Open the owner-filtered TUI:

```text
/actor-inspector
```

It presents actor instances through Recipe, Trace, and Control tabs, with source filtering, detail navigation, refresh, and generation-fenced Run kill.

## Skill Recipes

Useful entry points include:

- `project-work/repo-health`
- `project-work/release-readiness`
- `swarm/quorum-review`
- `artifacts/bundle`
- `music-player/playback` — singleton controlled playback service
- `actors/resource-locker` — optional controlled resource-lock service

Validate Recipes with:

```bash
npm run recipes:qa
```

## Development

```bash
npm install
npm run build
npm test
npm run validate
npm run test:preservation
```

`npm run validate` runs the full test suite once, including every conformance suite with the same preload and execution flags. `npm run conformance` remains a standalone targeted subset; aggregate validation does not repeat it after the full suite. An invariant checks cohort inclusion and profile equivalence.

Tests normally mirror `lib/<module>.ts` as `tests/<module>.test.ts`, with related contract groups in that file. `tests/invariants.test.ts` checks the naming boundary and the explicit cross-domain/package exceptions; the preservation rules live in [AGENTS.md](./AGENTS.md).

Standard tests, preservation and conformance preload a fresh temporary default agent directory for each test-runner process, ignoring any operator-supplied agent path. These directories are retained rather than deleted on test-runner exit alone; individual fixtures keep their own explicit cleanup evidence. For direct launcher checks, use `node --import ./tests/test-environment.mjs --experimental-strip-types --test ...`.

The atomic build produces the committed JavaScript runtime used by npm and git installs; `npm run build:check` verifies that `dist/` matches source without rewriting it. Pi can load a TypeScript extension entrypoint, but standalone Node processes cannot type-strip modules under `node_modules`; keeping compiled Run modules preserves process isolation without a runtime TypeScript loader.

See the [documentation index](./docs/README.md), [Run lifecycle](./docs/async-runs.md), and [Recipe library](./docs/recipe-library.md).

Project context: [AGENTS.md](./AGENTS.md) · [BACKLOG.md](./BACKLOG.md) · [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
