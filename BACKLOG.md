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

## Hotfix Backlog

No open hotfix items.

## Backlog Curation Rules

- Completed work belongs in `CHANGELOG.md`, not in `BACKLOG.md`.
- File length alone is not a domain-split trigger: ~1000-line cohesive domain files are acceptable when ownership is clear.
- Consider splitting only when a file crosses roughly 2000 lines, mixes real ownership zones, or hides a clearer domain boundary.
- Prefer semantic compression before file splitting: fewer public nouns, consistent outcomes, compact diagnostics, and domain-owned constants/helpers.
- Preserve signal/noise balance: feedback should be state-backed, compact, and action-shaped; do not add advisory prose just because a surface exists.

## Minor Backlog

No open minor items.

The backlog is intentionally pruned to the 20% of work most likely to deliver 80% of value for `pi-actors` as a local actor kernel. Bias toward consolidation, smaller public surface area, and reliability over new feature breadth.

## Explicitly Deferred

These are valid ideas but not current focus. Reintroduce only with concrete evidence from real actor workflows.

- Spawn preflight mode: useful later, but lower value than resilient inspect and mailbox-loop consolidation.
- Run restart/reattach policy: risky for isolation; defer until corruption recovery and protocol fixtures are stronger.
- Cross-session force kill or attach/adopt/reparent: useful later, but ownership policy should not change until observability makes current boundaries clear.
- Actor address helper CLI: keep diagnostics improving opportunistically inside existing parser/tests.
- Golden flow docs and flow conformance runner: useful after the diagnostic and promotion surfaces are stable.
- Documentation refactor: defer until the canonical mailbox loop and worker recipe exist; avoid rewriting docs twice.
- Host-level tool unregistration: blocked on host API support.
- Branch-local checkpoint semantics: wait for real collaborative branch-runner experiments.
- Actor recipe feedback loop: keep advisory and operator-gated after real runs produce evidence.

## Suggested Milestone Order

1. Re-curate after the next real packaged review-swarm dogfood run.
