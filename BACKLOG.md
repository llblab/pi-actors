# Project Backlog

## Implementation Boundary

Work only inside `pi-actors`: strengthen the current Pi extension and local actor kernel. Do not split work into an external transportable standard, do not design `mcp-actors`, and do not change public positioning.

Current carrying contour:

- `spawn`, `message`, and `inspect` stay the durable public verbs.
- Async run state stays file-backed and inspectable.
- Tool exposure stays recipe-based and location-derived from `~/.pi/agent/recipes`.
- Durable inbox and outbox files remain canonical intent and message state.
- Rooms, rosters, and branch inboxes remain local coordination memory.
- Wake notifications remain advisory acceleration, not the queue.
- Operator-facing observability stays explicit and bounded.

Core invariant:

```text
Recipe = portable executable capability.
Run = addressable lifecycle instance.
Message = typed semantic envelope.
Mailbox = durable intent queue.
Wake = advisory acceleration.
Room = shared local coordination memory.
Inspect = intentional observation.
Artifact = durable result.
```

Non-goals:

- Distributed workers.
- Generic scheduler DSL.
- Cloud sync.
- External transport standard.
- MCP implementation.
- Arbitrary subrooms.
- Heavy broker abstraction.

## Open Work

### Manual draft-memory consolidation

- [ ] Add a manually invoked command that launches an agent-led consolidation cycle over `~/.pi/agent/recipes/drafts`. The cycle must inventory and classify every draft, propose a complete `promote`, `merge`, or `discard` plan, require explicit operator confirmation before mutations, normalize approved reusable capabilities into active recipe-backed tools under `~/.pi/agent/recipes`, and remove every handled source so the drafts directory finishes empty. It must never run automatically or promote tools silently; preserve evidence for each decision and add regressions for plan-only, confirmation, promotion, merge, discard, failure recovery, and empty-directory completion.

### Overlay actor inspector

- [ ] Replace the command-driven inspector workflow with one large keyboard-driven overlay while preserving the compact striped information design. Stop conditions: `/actors-inspector-toggle` only toggles the overlay; an operator can select an owned run and subagent, switch `Messages` / `Turns` tabs, navigate rows, open/close detail, scroll bounded content, and understand keys/current scope without entering subcommands.
  - [x] Close the dogfood security prerequisites: reset selection across Pi sessions, revalidate ownership before every selected-run read, contain session evidence beneath the owned run state, broaden structured/text redaction, and add regressions.
  - [x] Build the centered responsive overlay shell with bordered header/footer, tabs, owned-run/subagent selector, active-scope summary, empty/loading/error states, and Escape close.
  - [x] Move compact striped Messages rows, filters, unread filtering/attention markers, roster context, and row detail into keyboard navigation.
  - [x] Move Turns rows and full bounded provenance/tool detail into keyboard navigation with scrolling and explicit persisted/unavailable reasoning labels.
  - [x] Remove the subcommand grammar and below-editor widget lifecycle, retain only the toggle command, and document discoverable key hints plus responsive behavior.
  - [ ] Run full package, conformance, and context validation, then close this item. Component input/render/width/scroll/tab/ownership/live-refresh regressions and iterative manual TUI dogfood now cover the accepted visual interaction contract.

### Inspector execution observability

- [x] Consolidate the actor inspector into one manually opened, navigable operator surface for communication and execution evidence. Stop conditions: an operator can choose an owned run/subagent, switch between communication and turn timelines, open one bounded detail view, and inspect every persisted user/assistant/tool-result turn in source order without exposing another session or claiming unavailable hidden reasoning.
  - [x] Persist deterministic Pi session provenance for each child `pi -p` command under its owned run state, without overriding an explicitly supplied session policy; record the session path in command evidence and tolerate commands that never create a session.
  - [x] Add a resilient, bounded session-evidence reader that follows the active JSONL entry branch, groups assistant responses with correlated tool calls/results into turns, preserves model/usage/error metadata, redacts sensitive argument/content fields, and reports malformed or incomplete evidence honestly.
  - [x] Replace communication-specific inspector controller state with a shared navigation model: run selector → `communication` or `turns` timeline → numbered detail, with stable back/toggle/filter behavior and useful empty states for actors that never send messages.
  - [x] Render compact turn rows and bounded manual detail views for effective prompt/context references, assistant text, host-exposed thinking blocks, tool arguments/results, model/usage, and source-file provenance; label missing reasoning as unavailable rather than inferred.
  - [x] Add ownership, truncation, redaction, malformed JSONL, active-branch ordering, tool correlation, parallel tool completion, terminal run, coordinator-launched subagent, and communication-navigation regressions; update the Actors skill and inspector documentation after the interaction contract stabilizes.

## Backlog Curation Rules

- Completed work belongs in `CHANGELOG.md`, not in `BACKLOG.md`.
- File length alone is not a domain-split trigger: ~1000-line cohesive domain files are acceptable when ownership is clear.
- Consider splitting only when a file crosses roughly 2000 lines, mixes real ownership zones, or hides a clearer domain boundary.
- Prefer semantic compression before file splitting: fewer public nouns, consistent outcomes, compact diagnostics, and domain-owned constants/helpers.
- Preserve signal/noise balance: feedback should be state-backed, compact, and action-shaped; do not add advisory prose just because a surface exists.

The backlog is intentionally pruned to the 20% of work most likely to deliver 80% of value for `pi-actors` as a local actor kernel. Bias toward consolidation, smaller public surface area, and reliability over new feature breadth.

## Explicitly Deferred

These are valid ideas but not current focus. Reintroduce only with concrete evidence from real actor workflows.

- Spawn preflight mode: useful later, but lower value than resilient inspect and mailbox-loop consolidation.
- Run restart/reattach policy: risky for isolation; defer until corruption recovery and protocol fixtures are stronger.
- Cross-session force kill or attach/adopt/reparent: useful later, but ownership policy should not change until observability makes current boundaries clear.
- Actor address helper CLI: keep diagnostics improving opportunistically inside existing parser/tests.
- Golden flow docs and flow conformance runner: useful after the diagnostic and promotion surfaces are stable.
- Host-level tool unregistration: blocked on host API support.
- Branch-local checkpoint semantics: wait for real collaborative branch-runner experiments.
- Actor recipe feedback loop: keep advisory and operator-gated after real runs produce evidence.
