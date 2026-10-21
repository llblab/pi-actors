# Coordinator Delivery Scheduler

Status: Implemented coordinator-delivery contract.

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

Completion and steer acknowledgments intentionally differ. An active completion overlay remains pending until exact model context or bounded active-session evidence proves its committed entry. Successful idle `sendMessage()` acceptance finalizes an ordinary completion batch immediately; durable queued phase also proves acceptance. Both paths mark members through the existing terminal-handled authority, so a missed context callback cannot block every later epoch. Urgent steer still requires exact model-context presentation. If a completion member was synchronously archived or pruned after acceptance, the bounded delivery snapshot remains sufficient and the missing state write becomes a diagnostic rather than invalidating acceptance.

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
- explicit overflow evidence and the canonical runtime Inspect route.

The journal may retain at most 256 members and 1 MiB. Model-facing content lists at most 64 exact rows within the centralized model-output bound. Additional members remain represented by exact status counts and supported Inspect guidance. More than 256 unhandled generations form a later batch rather than being discarded.

Completion member details remain redacted through existing terminal projection rules: no raw model policy, secrets, private Recipe paths, or machine-local source paths enter the message.

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
