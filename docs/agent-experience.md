# Agent Experience (AX)

| Item | Value |
| --- | --- |
| Status | Adopted project-wide design standard |
| Version | r2, 2026-11-20 |
| Scope | Presentation only: no new machine protocol, Recipe schema, source permission or release claim |
| Per-surface implementation status | [Runtime Output Projection Map](./output-projection-map.md) |
| Rollout and acceptance work | [BACKLOG.md](../BACKLOG.md) |

This document is the normative presentation standard. What is already migrated, still on an earlier layout, or accepted on which host lives in the projection map and the backlog, never here, so design adoption is not mistaken for runtime delivery.

**The rule in one line:** structured inputs stay JSON; runtime-authored output metadata is block YAML; authored text stays unchanged Markdown outside that metadata.

## Purpose

AX means **Agent Experience**: give an agent enough structured, visible context to understand what happened and choose its next step, in a form a person can read at a glance. One projection serves both audiences. The agent should not have to reconstruct meaning from a raw dump, and the human should not get decorative prose that hides the facts.

- **Compact means selected meaning**, not the fewest lines. Two or more useful lines are normal; do not clip a short complete phrase to keep a record on one line.
- **Truth over polish.** Real uncertainty, loss and refusal stay visible. A cleaner answer must never claim readiness, completion, delivery or "no effects" that is not established.
- **Responsive, not chatty.** Reuse the current admitted snapshot on the hot path instead of rereading bodies, and keep explanations in detail views rather than standing hints on the first screen. Caching follows its owner's refresh and invalidation policy; it does not invent freshness or immutability. Inspector notifications live in overlay chrome, never as rows inserted among source data: showing or dismissing feedback must not shift the document, selection or stripes.

## Scope

Apply this standard when creating or changing:

- public tool launch, success, refusal and error text;
- agent-bound completion, attention, diagnostic and other contextual messages;
- Actor Inspector lists, detail documents, notices and actionable explanations;
- human-facing examples of those surfaces and the checks that preserve them.

Facts, field meanings, ordering priorities, uncertainty and omission semantics stay consistent across surfaces; layout and exact bytes may differ between a terminal, a tool result and a phone. Source permissions and recipient ownership stay authoritative everywhere, including verbose and detail views.

Out of scope: machine JSON, canonical journals, SDK DTOs, parameter schemas, native wire formats and literal source text. They keep their own contracts and are never rewritten into this presentation because the default view changes.

## JSON Input, YAML Output, Opaque Content

- **Structured inputs.** Tool arguments and SDK parameter schemas remain JSON machine contracts. JSON and supported Markdown Recipe definitions remain inputs; this rule authorizes no Recipe-schema or container migration.
- **Runtime-authored outputs.** Launch and attachment receipts, registration, status, Control, inspect, notices, refusals, diagnostics and completion metadata use one YAML presentation for agent and human. A verbose view adds admitted information in that same presentation; it is not a licence to dump internal JSON into readable text. Machine `details`, journals and stored artifacts keep their own formats and authority.
- **Authored content.** The selected Actor or producer text keeps its original format, usually Markdown: outside the metadata, at the left margin, with no `answer:`/`output:` scalar, universal body fence, JSON escaping or per-line list marker. Existing privacy, source selection and admitted clipping still apply; this is not permission to recover discarded text or widen retention.
- **Literal source.** An explicitly requested Recipe, file, code or JSON source may stay literal. That literal is not a second output mode; never disguise a generated object dump as source text.
- **One metadata language.** Structured runtime fields are native YAML nodes, never a JSON string inside YAML or a nested JSON fence. Authored bodies are never parsed and reserialized to conform.

## Document Envelope and YAML Syntax

Framing depends only on whether the output has a separate selected text body:

- **Metadata only** — bare YAML: no `---`, no code fence, no empty frontmatter. Routine tool, spawn, attachment and registration receipts usually take this form; they report invocation facts, not the Actor's eventual result.
- **Metadata plus body** — exactly one `---` line above and below the YAML header, then the selected text at the left margin. The delimiters separate two languages; the body is neither a YAML scalar nor fenced.

Choose by **actual body presence**, not by sync versus async execution: an async launch receipt can be metadata-only and a sync tool can carry text. Do not invent filler prose, trim selected content, or infer the case by parsing it. This is one presentation with body-dependent framing, not two selectable formats.

Syntax:

- One entity is one YAML 1.2 block mapping of descriptive `key: value` fields with two-space nesting and stable semantic order. Sequence markers (`- `) appear only for real sequences, never before every field. No pseudo-YAML grammar, non-empty flow collections, tags, anchors or alternate document formats.
- Empty `[]`/`{}` and quoted scalars keep their types; never replace an empty collection with null, absence or an invented status.
- Nest naturally related facts (model/thinking provenance, references, Run-file locations). Strings, null, booleans and numbers keep their meaning; syntax never changes an opaque id, ordering, field semantics or permission.
- **Quoting:** plain unambiguous scalars are unquoted (`run: review-0`, `state: done`, paths). Quote a string only when its value is ambiguous, contains structurally significant characters, or is the unknown index `"?"`.
- Runtime-owned multiline metadata uses a proper round-trippable YAML block scalar. Authored reports stay outside metadata; selected diagnostic or advice text stays content and is never parsed into fields or actions.
- A real warning stays next to the record it qualifies. Do not add empty fields, decorate a "no effects" claim or hide safety information in service metadata.
- Budgets and whole-value omission already include YAML indentation, escaping and service data. Formatting never grants a larger budget, an extra source read, a shortened path or the loss of a generation or privacy fact.
- Body-authored frontmatter, `next:`/tool labels, lists, code, YAML, JSON and HTML are opaque content. Compiler boundaries, never text-shaped guesses, identify runtime metadata.

Illustrative metadata-only spawn receipt (not real Run data):

```yaml
run: review-0
state: running
launch_kind: spawn
recipe: swarm/subagent-prompt
model:
  source: explicit
  value: example/model
```

Code fences around examples in this document are explanatory only and never part of emitted text.

## Tool Invocation and Response Separation

Every tool surface shows exactly one blank line between the host-owned invocation header and the first response line: spawn and registered tools, compact and verbose, YAML or text, success, refusal and error alike. This spacing belongs to the result boundary, independent of the YAML framing decision; never add `---` to create it.

Do not trim or rewrite selected text, repeat tool names, options or private inputs in the response, add a filler body, or accumulate blank lines through repeated wrapping. Structured `details`, non-text blocks, error identity and budgets are preserved.

```text
spawn  recipe=swarm/subagent-prompt

run: review-0
state: running
launch_kind: spawn
```

The first line above is host chrome, not response text.

## Identifiers, Facts and Next Actions

**Identifiers.** Display `run: demo`, not `run: run:demo`: the key already names the namespace. Canonical targets keep `run:demo` wherever machine fields, references or tool arguments require it. Avoid authored middle-dot separators and ornamental boilerplate, but preserve them inside producer-authored data or immutable history.

**Stage vocabulary.** A request is not actuation, delivery is not handling, a natural result is not whole-scope closure, and a legacy kill attempt is not proven termination. A later error can coexist with admitted handling or committed filesystem effects. Never merge the Run state with the state of one Control request; preserve original refusal facts and private causes without inventing correlation or exposing a replacement owner's state.

**Next actions.** A next step is an instruction, not observed state. Name the tool and its real arguments instead of hiding a command string in a vague field, and show it only when it is relevant and permitted; healthy responses do not carry a routine inspection command. A displayed action is not evidence it ran and not permission to run it automatically.

Illustrative Control error (not an executed request):

```yaml
run: demo
action: pause
result: request failed
delivery: unconfirmed
handling: unconfirmed
warning: |-
  Effects may already exist.
  Do not repeat automatically.
next:
  tool: actors_inspect
  target: runtime
  view: runs
```

This does not authorize publishing a saved Control id or generation; [recipient-bound correlation](./run-supervision.md#recipient-bound-correlation-preparation) keeps its own gate.

## Completion Cards

A completion card is what the agent and the human see when a Run finishes. It is a captured presentation of admitted facts, not another result store or a filesystem inventory. A batch is simply a sequence of per-Run cards, not a container with members.

### Card shape

Each card's metadata begins `run`, `state`, then `kind`:

- `kind: primary` — admitted primary text or the final Actor response;
- `kind: diagnostic` — explicit error or failure diagnostics, never a launch command.

Untracked fallback text has no `kind` and cannot become primary. Missing text stays explicit. `kind` classifies outcome content, not the launch: a launch receipt never invents a completion index or a final Actor output.

When a card has a body, the admitted Markdown follows the closed header at the left margin: no `#N` heading, no `result:`/`preview:` wrapper, no whole-body fence, and exactly one blank line between cards.

**Display index.** Prepend a packet-local `index` only when two or more cards are shown. A single shown card has no index, even when other results were omitted. An unavailable index is the string `"?"`, never a fabricated zero. A display index is not a member index, generation or global counter.

### Rooted completion files

`files` tells the agent which files are worth opening and why. It is a sequence of groups, each with one literal `root` and relative `entries[].path`:

- **What is listed:** the retained primary, diagnostic and inventory sources; declared artifacts; observed `context-index.json`, `result.json` and `execution.json` as metadata fallback. Not every technical file.
- **What an entry carries:** `path`, an optional logical `name`, and a concise `status` only when the filename alone cannot convey why to read it. Status keeps Actor-response versus exported-text, admission privacy, diagnostic-only scope and unverified declarations distinct. Entries never carry `role` or diagnostic field inventories.
- **Group-wide facts:** optional `files_status` and `files_notes` hold real group-wide uncertainty, such as "Declared artifact paths; existence/production unproven".
- **What stays out:** routine absent optional files and repeated purpose, format, size, mutability, generation and hash facts. Full bindings remain in the saved snapshot and machine detail.

Root and path semantics:

- Paths under the Run's own directory share its group. External absolute paths get their own literal parent root.
- A relative, malformed or dot-segment path without a safe captured base stays as recorded under a null root with explicit base unavailability: no cwd or Run-id guess, normalization, source read or symlink resolution.
- A reader joins a known root with its relative path, never with its own cwd. A grouped root does not assert containment or grant access to its other children.
- Declarations are not production evidence, and paths mentioned inside Actor Markdown are authored text, not verified references.

### Read first and continuation

Prefix one entry's status with `Read first;` **only** when the shown primary text, or the selected error/failure diagnostic, omits retained text that this source can recover. Never for a complete answer, upstream uncertainty alone, extra diagnostics, declared artifacts or result/execution metadata.

For a primary-text cut, the entry carries `continue_from_line: N` and the body ends with `[Read from line N]`:

- lines are one-based LF-delimited lines of the source file (CRLF files included), not terminal wrapping;
- a partly shown line is read again, so `N` is the first line not fully shown;
- lone CR and soft wrapping add no lines; CRLF stays intact;
- one very long line can still exceed a reader's budget.

Diagnostic JSON and other text without an exact file-line mapping use a character count instead (below).

### Markers and omission

| Case | Shown as | Counts | Rules |
| --- | --- | --- | --- |
| Primary text cut at a known file line | `[Read from line N]` in the body, `continue_from_line: N` on the entry | First not-fully-shown file line | As in the line model above |
| Diagnostic JSON or text without line mapping | `[N characters omitted]` at the cut | Admitted Unicode scalars | No added ellipsis; no clipping counters in YAML |
| Unknown upstream completeness or privacy | Header `text_warnings` | None | No invented count and no claim of known positive loss |
| Complete text with no known loss | Nothing | — | Never manufacture an exact zero for unproven completeness |

Counts cover only already-authorized, privacy-projected text: never hidden secrets, discarded upstream lengths, UTF-16 units or bytes. A known local count and unknown upstream loss stay distinct when both apply. Only the exact cut marker may follow a body; every other runtime fact stays in the header.

### Placement, budgets and delivery

- All runtime metadata sits above the Markdown: no service footer, appended file list or trailing warning. Packet-level omission and inventory facts go in the first header.
- The fixed 48 KiB packet budget covers every root, entry and compiler hint across up to 64 shown cards and 256 captured members. Run identity and recorded state come first, outcomes outrank optional file rows, whole omitted rows stay explicitly covered, and no path is ever shortened.
- Successful automatic delivery adds no receipt, outer counters, `members` wrapper, batch caption, time window, status copies or standing "full map" instruction. Real failures stay reportable.
- Fresh packets carry only a minimal packet identity and relative body/marker lengths in YAML metadata, with no compiler HTML tail. That data is display and correlation consistency, not authenticity, read permission or acceptance.

### Rendering

The compact TUI renders compiler headers and markers as literal text and each body as independent native Markdown, so an unfinished fence, list or quote in one body cannot consume the next card. Expansion, or an invalid or missing hint, reveals the original full text. Rendering never rewrites source bodies or retained coverage facts.

### Example

Illustrative two-card packet (not real Run data):

```text
---
index: 0
run: review-0
state: done
kind: primary
files:
  - root: /home/user/.pi/agent/tmp/pi-actors/runs/session-a/review-0
    entries:
      - status: "Read first; Actor response; admission privacy"
        path: evidence/primary.txt
        continue_from_line: 143
      - path: result.json
      - path: execution.json
  - root: /home/user/project/reports
    entries:
      - name: report
        path: review.md
files_status: "Declared artifact paths; existence/production unproven"
---

## Review

The package is ready. The report covers the two remaining warnings.
[Read from line 143]

---
index: 1
run: build-0
state: failed
kind: diagnostic
files:
  - root: /home/user/.pi/agent/tmp/pi-actors/runs/session-a/build-0
    entries:
      - status: "Recorded diagnostic metadata only; admission privacy"
        path: evidence/result-diagnostics.json
      - path: result.json
---

Module was not found.
[120 characters omitted]
```

## Text, Clipping and Omission Elsewhere

Outside completion cards, previews follow their existing owners:

- A derived preview with a known omission fact uses YAML `omitted: "<N> chars"`, counting Unicode code points removed from already-authorized, privacy-projected source at the declared stage.
- Inline annotations, where an owner uses them, read `[omitted: N chars]` or `[omitted: unknown]`.
- Where an owner already uses gap ellipses, U+2026 marks the cut boundary: after a retained prefix, before a retained suffix, on both sides of a removed interior gap, or at both ends of a middle excerpt. A combined count means the total omitted content, not a count repeated per end.

These are presentation patterns, not permission to select a suffix or middle the owner does not admit. An authored ellipsis or replacement character is not a loss flag; U+2026 is one code point but three UTF-8 bytes, so budgets stay explicit. Annotations live outside the literal retained bytes and inside the shared output bound. Actionable paths and references stay whole or are explicitly omitted, never cut for width.

## Service Framing Is Not Authored Content

Fresh readable output carries no pi-actors HTML-comment transport framing. Service data that must travel in content is reduced to its proven minimum (one packet identity plus the relative body/marker segmentation needed to keep opaque content separate) and placed in the YAML header. Do not carry duplicate block tables, derived range tables, prefix digests or default-inactive numbering payloads.

Saved layouts keep their HTML compiler frames and markers, and older installed runtimes may still emit them. Never strip them by regex, infer authenticity from a hash, erase Actor-authored HTML, move warnings out of view, or rewrite historical messages to look uniform. A replacement carrier ships only after replay, model-context recovery, full-content binding, independent boundaries, fallback and fixed budgets are proven equivalent; otherwise keep the existing mechanism and name the blocker.

## Compatibility and Trust Boundaries

- **Adoption is not conformance.** Current source, compiled and loaded-host behavior must stay distinguishable from this target.
- **Saved history is immutable.** Captured completion and steer packets replay with their original codec and exact bytes; steer envelopes replay their saved content directly. Do not relabel, migrate or reformat journals or session messages. Retained encoding identifiers are internal replay data, not alternate AX products — see [retained capture compatibility](./coordinator-delivery.md#retained-capture-compatibility).
- **New captures need their own path.** A fresh read-time projection over admitted data may update its current summary without changing canonical fields; a new capture layout needs a distinct admitted path in its owner. Never reinterpret an existing aspect such as `bracketed_omissions_v1`. Old strings cannot supply original counts or a privacy certificate ([legacy disclosure boundary](./run-supervision.md#legacy-completion-disclosure-boundary)).
- **Formatting grants nothing.** Privacy, ownership, generation fencing, source selection and native or clock authority are separate from presentation. A DTO, path or readable old manager is not permission. Verbose output is recipient-scoped, not a raw-data escape hatch, and rendering a nicer record never enables a policy, retry, source read or refresh.

## Implementation Owners

Each projection stays with its cohesive owner; the [projection map](./output-projection-map.md) records the audited functions, egress paths and test owners.

- `tools-message.ts` — Control receipts, refusals and conservative public errors.
- `tools-response.ts`, `tools-spawn.ts`, `tools-local.ts` — shared response primitives, launch and runtime-tool presentation. `renderYamlMetadata` is the bounded block-YAML foundation (49,152-byte ceiling, at most 64 nesting levels); those limits are not caller allowances.
- `tools-inspect.ts`, `inspector.ts`, `inspector-overlay.ts` — public inspection and Inspector presentation, preserving ranks, ids, source order, selection and focus.
- `observability.ts`, `run-delivery.ts`, `run-ui-runtime.ts` — observed outcomes and attention, versioned packet projection, active-context delivery. Formatting owns neither scheduling nor acceptance.
- `trace-projection.ts` and the admitted source owners — truthful bounded summaries on their existing privacy and count basis.

Do not add a generic presentation authority, lifetime registry or second status implementation; earn a shared primitive through real reuse. Agent Skills describe implemented behavior as slices land and never depend on these human docs as their operating protocol.

## Acceptance

For each implementation slice:

- Compare the same admitted facts in tool text, Inspector and agent context; presentation differences must not change meaning or permission.
- Cover flat records, justified nesting, opaque Markdown with its own lists and keys, literal code, long and empty values, absent optional facts and complete references.
- Check exact and unknown omission classes, Unicode boundaries, unchanged source bytes and byte-exact old-format replay under the real budget.
- Preserve owning scenarios, assertions and teardown, and replay the same properties against source and the npm-packed package rather than a duplicate harness.
- Verify keys, indentation, table fallback, focus, scroll, selection and safety notices at narrow, medium and wide widths. Authorized terminal and phone observation stays separate from headless checks.
- Reconcile implementation notes, agent-facing Skills, human references and the backlog without presenting design adoption as runtime delivery.

Feature contracts and evidence stay with [run supervision](./run-supervision.md), the [Actor Inspector](./actor-inspector.md), [management inspection](./inspection.md) and [coordinator delivery](./coordinator-delivery.md).
