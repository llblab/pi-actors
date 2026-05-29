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

## Minor Backlog

The backlog is intentionally pruned to the 20% of work most likely to deliver 80% of value for `pi-actors` as a local actor kernel. Bias toward consolidation, smaller public surface area, and reliability over new feature breadth.

### M-14 Session Mismatch Follow-through

- Priority: Medium.
- Status: Planned.
- Goal: Extend 0.27 structured session diagnostics consistently across room, branch, run, coordinator, and session workflows.
- Why now: M-12 established the shape; dogfood should now make every ownership denial equally actionable without relaxing ownership gates.
- Direction:
  - Audit all session mismatch errors for consistent `reason`, owner/current session fields, and inspect-session hints.
  - Keep read/write ownership policy unchanged.
  - Update docs with session mismatch examples and recovery inspection paths.
- Acceptance:
  - Room, branch, run, coordinator, and session denials share the same compact/verbose shape.
  - Tests cover representative inspect and message paths.

### M-15 Worker Stale-Claim Dogfood

- Priority: Medium.
- Status: Planned.
- Goal: Validate and harden actor-worker v2 stale-claim visibility under intentionally stale claimed branch messages.
- Why now: M-09 exposed `stale_claims`; real dogfood should verify the operator can diagnose stuck claimed work before adding recovery policy.
- Direction:
  - Create deterministic stale claimed branch inbox fixtures or smoke tests.
  - Verify `worker-status.json`, room events, and inspect surfaces make stale claims visible.
  - Defer auto-recovery unless workflow evidence proves it is safe.
- Acceptance:
  - Stale claims are reproducible and visible in worker status.
  - Tests cover stale-claim counting without adding scheduler/broker policy.

### M-23 Tool Boundary Type Tightening

- Priority: Low.
- Status: Planned.
- Goal: Remove avoidable `any` at the Pi/tool boundary where a narrow local type can express the real contract without broad rewiring.
- Why now: `index.ts` still keeps runtime tool definitions in a `Map<string, any>`; this is small but visible in the composition root.
- Direction:
  - Add or reuse a narrow exported tool-definition type from the Pi adapter or tools domain.
  - Keep SDK details behind `lib/pi.ts`.
  - Do not introduce a broad type-modeling pass across every schema helper.
- Acceptance:
  - `index.ts` no longer uses `Map<string, any>` for actor tool definitions.
  - TypeScript validation still passes without weakening public tool schemas.

### M-17 Message Delivery Outcome Contract

- Priority: High.
- Status: Planned.
- Goal: Normalize `message` results so operators can distinguish delivered, queued, persisted, forwarded, unsupported, and ownership-denied outcomes.
- Why now: Branch message UX already treats durable branch mailbox persistence as a successful queued outcome when a parent endpoint is unavailable; that local fix should become a consistent message-result membrane.
- Direction:
  - Define compact delivery fields: `queued`, `delivered`, `persisted`, `forwarded`, `consumer`, `reason`, and `hint`.
  - Apply the shape to `run:<id>`, `branch:<run>/<branch>`, `room:<run>`, `coordinator`, `session:`, and `tool:<name>` where meaningful.
  - Reuse M-14 session mismatch shape for ownership-denied outcomes.
  - Do not claim guaranteed live consumption unless a known consumer exists.
  - Do not add a broker, distributed delivery semantics, or a new public noun.
- Acceptance:
  - Branch messages clearly report queued/persisted state and known worker-consumer state where available.
  - Room messages distinguish timeline append success from forwarded branch-targeted copies.
  - Tests cover at least run, branch, room, coordinator, and ownership-denied outcomes.

### M-18 Candidate Recipe Promotion UX

- Priority: High.
- Status: Planned.
- Goal: Make successful ad hoc actor patterns easy to promote manually from candidate memory into active user recipe memory.
- Why now: Candidate recipes under `~/.pi/agent/recipes/candidates` are replayable but intentionally not active tools; the two-stage memory model now needs an explicit operator-gated promotion path.
- Direction:
  - List candidate recipes with source run, timestamp, fingerprint, description/template preview, and validation status.
  - Promote a selected candidate to `~/.pi/agent/recipes/<name>.json` only through an explicit action or explicit tool argument.
  - Run recipe validation/doctor before writing and expose collision/shadowing diagnostics.
  - Preserve candidate files unless deletion is explicitly requested.
  - Prefer extending existing registry/tool surfaces over adding a new public noun.
- Acceptance:
  - Candidate recipes remain non-tools until promotion.
  - Promotion writes atomically and never auto-promotes.
  - Tests cover valid promotion, invalid candidate, name collision, and packaged-recipe shadowing.
  - Docs explain candidate memory vs active tool memory in one compact section.

### M-24 Registry Path Naming Cleanup

- Priority: Low.
- Status: Planned.
- Goal: Reduce legacy-storage naming noise without changing the persistent file path.
- Why now: `legacy-tool-registry.json` is still a compatibility storage path, but helper names and tests should make clear that the stable path is retained intentionally.
- Direction:
  - Prefer neutral helper/test wording such as registry path or retained registry storage path.
  - Keep the on-disk filename unchanged unless a separate migration is justified.
  - Do not reintroduce legacy migration code.
- Acceptance:
  - Path helpers and tests no longer imply an unfinished migration.
  - Existing registry storage compatibility remains unchanged.

### M-19 Recipe Doctor Risk Labels v2

- Priority: Medium.
- Status: Planned.
- Goal: Evolve recipe doctor into a compact capability-risk membrane without pretending to sandbox trusted local execution.
- Why now: Recipe doctor already has remediation UX; the next useful slice is deterministic advisory risk classification for local capabilities.
- Direction:
  - Add advisory labels such as `risk.shell`, `risk.eval`, `risk.broad_fs_write`, `risk.destructive_fs`, `risk.network`, `risk.external_side_effect`, `risk.long_running`, `risk.platform_specific`, and `risk.secret_touching`.
  - Keep labels advisory and deterministic; do not block execution unless existing validation already blocks it.
  - Expose compact risk summaries in `inspect target=recipes view=doctor` and verbose per-recipe labels.
  - Keep launch-time warnings quiet except for already-failing or clearly dangerous cases.
  - Preserve honest wording: trusted local execution, not isolation.
- Acceptance:
  - Risk labels are deterministic and tested.
  - Existing risky shell-boundary diagnostics remain intact.
  - Doctor output stays compact by default.
  - README/docs do not introduce sandbox or security-boundary claims.

### M-20 Runtime Triage Surface

- Priority: Medium.
- Status: Planned.
- Goal: Add one compact operator triage view that answers what needs attention right now without performing repairs.
- Why now: Runtime status, recipe doctor, candidates, stale claims, session mismatches, failed runs, and other-session counts are currently separate bounded surfaces.
- Direction:
  - Add `inspect target=tool:pi-actors view=triage` or an equivalent existing inspect surface.
  - Summarize runtime version/mode, active runs, other-session runs, invalid or blocking recipes, high-risk recipes, candidate recipes, stale worker claims, recent failed runs, attention messages, and suggested next inspect actions.
  - Keep every warning tied to a next inspect/action hint.
  - Do not auto-repair, auto-prune, relax ownership, or hide detailed source-of-truth views.
- Acceptance:
  - Triage output is compact enough for agent context.
  - Healthy and degraded states are covered by tests.
  - Detailed inspect/doctor/status views remain source of truth.

### M-21 Packaged Recipe QA Matrix

- Priority: Medium.
- Status: Planned.
- Goal: Prevent packaged recipes from drifting into inconsistent mailbox, artifact, platform, or package-root behavior.
- Why now: Packaged recipes are standard-library components; they should be boringly consistent before operators copy or register them as durable local capabilities.
- Direction:
  - Add an internal QA check over `recipes/*.json` for descriptions, async mailbox contracts, termination vocabulary, artifact declarations, platform notes, installed-package-safe helper paths, and compiled shim coverage.
  - Keep `control.kill` as generic runtime termination and allow `control.stop` / `control.cancel` only as actor-domain vocabulary.
  - Fail with exact recipe/path/key diagnostics.
  - Avoid a broad recipe-library rewrite beyond violations discovered by the check.
- Acceptance:
  - QA runs under an existing validation command or a clearly named subcheck used by `npm run validate`.
  - Tests/fixtures cover at least one positive and one negative case.
  - Packaged recipes remain optional components, not policy workflows.

### M-22 Wake and Watcher Chaos Fixtures

- Priority: Medium.
- Status: Planned.
- Goal: Harden the invariant that durable files are canonical and wake notifications are advisory acceleration.
- Why now: Wake, watcher, line-counter, and JSONL resilience are central to operator trust as actor counts grow.
- Direction:
  - Add deterministic fixtures for watcher restart, line-counter reset, duplicate terminal events, missing wake with present inbox record, wake before file catch-up, corrupt JSONL with later valid records, and killed run with stale progress phase.
  - Preserve event-driven observability without reintroducing polling-first coordination examples.
  - Keep tests fast and local.
- Acceptance:
  - Duplicate follow-ups do not reappear.
  - Missing wake does not lose durable messages.
  - Corrupt records degrade inspect but do not kill it.
  - Killed/stale progress states remain diagnosable.

## Explicitly Deferred

These are valid ideas but not current focus. Reintroduce only with concrete evidence from real actor workflows.

- Spawn preflight mode: useful later, but lower value than resilient inspect and mailbox-loop consolidation.
- Run restart/reattach policy: risky for isolation; defer until corruption recovery and protocol fixtures are stronger.
- Cross-session force kill or attach/adopt/reparent: useful later, but ownership policy should not change until observability makes current boundaries clear.
- Actor address helper CLI: keep diagnostics improving opportunistically inside existing parser/tests.
- Golden flow docs and flow conformance runner: useful after M-14, M-15, M-17, and M-18 make the diagnostic and promotion surfaces stable.
- Documentation refactor: defer until the canonical mailbox loop and worker recipe exist; avoid rewriting docs twice.
- Host-level tool unregistration: blocked on host API support.
- Branch-local checkpoint semantics: wait for real collaborative branch-runner experiments.
- Actor recipe feedback loop: keep advisory and operator-gated after real runs produce evidence.

## Suggested Milestone Order

```text
Next milestone: M-14 Session Mismatch Follow-through.
Then: M-15 Worker Stale-Claim Dogfood → M-17 Message Delivery Outcome Contract → M-18 Candidate Recipe Promotion UX.
Small cleanup lane: M-23 Tool Boundary Type Tightening → M-24 Registry Path Naming Cleanup.
```
