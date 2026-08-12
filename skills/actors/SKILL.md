---
name: actors
description: Required practical guide for non-trivial pi-actors use and Run-kernel work. Read before using or changing spawn, message, inspect, Runs, tools, Recipes, command templates, Control, Trace, artifacts, or lifecycle mechanics.
---

# Actors (pi-actors)

`pi-actors` treats any runnable local capability—a script, tool, service, pipeline, or subagent—as an actor. A Recipe is its reusable executable definition; a Run is one concrete actor instance:

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

Use the swarm skill separately for decomposition, quorum design, reviewer lenses, and consensus methodology.

## Public Verbs

- `spawn`: create one Run from a Recipe or inline command template.
- `message`: send one actor-local Control to `run:<id>`, or the reserved review actions to `runtime`.
- `inspect`: inspect `run:<id>`, `runtime`, `recipes`, or `tool:<name>`.
- `register_tool`: persist a trusted capability; it does not address a running actor.

A Run target exposes exactly three inspect views: `recipe`, `trace`, and `control`.

## Recipe

A Recipe defines execution. It may declare named typed args, inline fallbacks, configuration `defaults`, composition `values`, imports, artifacts, command-template flags, and `control: ["action"]` when a long-lived service actually consumes actor-local inputs.

Do not declare Control for ordinary one-shot work. Runtime lifecycle actions such as `kill` stay runtime-owned and must not appear in Recipe Control declarations. Imported Recipes act as local definitions inside one Run; they do not create nested Runs unless execution explicitly spawns them.

Prefer maintained packaged Recipes over ad hoc wrappers. Use `std:<recipe>` for exact packaged lookup and `skill:<skill>/<recipe-path>` for a component bundled with a Pi-active Skill. File-backed Recipes own `{recipe_dir}` and Skill Recipes own `{skill_dir}`; callers never pass or override these origins. Skill Recipes are components, not automatic tools. Keep model, thinking, mission, concurrency, quorum, and timeout choices caller-owned unless a Recipe documents a stable policy.

## Trace

Trace records bounded structured observations in `trace.jsonl`:

```json
{
  "id": "…",
  "ts": "…",
  "kind": "progress.update",
  "summary": "…",
  "data": {},
  "level": "info",
  "attention": "notify"
}
```

Trace never carries sender, recipient, route, reply, or message-envelope fields. It is a bounded retained suffix: the canonical lock appends within 2,048 events and 4 MiB or atomically keeps the newest suffix plus one warning-only `runtime.trace_compacted` marker. That marker means older history was discarded; terminal/result/execution/artifact evidence stays independently authoritative. `inspect view=trace` reports completeness. Equal timestamps use same-source physical order, fixed source rank, then stable id without exposing an ordinal or claiming cross-source causality. Attention is a wake hint, not a queue: persist durable state or an artifact first, use `notify` for visible status, and reserve `followup` for needed coordinator context. Compaction may discard old hints.

## Control

The public Control request is exact:

```json
{ "target": "run:<id>", "action": "pause", "input": {}, "verbose": false }
```

Valid Controls persist in `controls.jsonl` before delivery; invalid envelopes remain outside it. One token-owned lock rejects a 65th pending Control or 1 MiB rewrite before admission, fails closed on malformed or stale-generation evidence, and atomically admits one queued record. Exact-id claims/finalization preserve a 128-terminal tail, expected-state fencing, and 4 KiB errors. Admitted nonterminal Controls never expire automatically. `inspect view=control` reports capacity, saturation, stale work, bytes, and diagnostics. Endpoints carry immutable startup `run_instance_id`; FIFO and named pipe share limits of 64 action characters, 380 serialized input bytes, and 512 newline-terminated wire bytes. Partial writes fail. Put larger data in an artifact and send only its reference. Delivery revalidates owner, generation, state, and process identity.

`kill` remains the runtime recovery path for a stuck saturated Run: it bypasses actor-local Control capacity and adds no synthetic Control. Use actor-local `stop` only when declared and implemented. Restart clears generation-local evidence; archive preserves the bounded terminal tree, while prune preserves only requested artifacts.

## Run State and Safety

Run state lives under `~/.pi/agent/tmp/pi-actors/runs/<run>/`. Important evidence includes:

- `run.json`: captured Run identity, Recipe, owner, generation, process identity, and policy.
- `trace.jsonl`: structured observations.
- `controls.jsonl`: durable actor-local inputs and outcomes.
- `control-endpoint.json`: generation-fenced service readiness.
- `execution.json`: command/session provenance and bounded complete-capture references.
- `result.json`, logs, and declared artifacts.

Trace/Control quotas do not constrain user-declared artifacts, repositories, media sources, complete captures, or actor-owned workload state. No public noun, tool, target, or view is added by bounded retention.

Never bypass owner filtering, immutable generation fencing, process-identity verification, path containment, redaction, terminal reconciliation, or shutdown kill behavior. Do not edit active Run state to force a result.

## Operating Pattern

1. Inspect the Recipe before launch when its contract or policy matters.
2. Spawn with explicit values and retain the returned `run:<id>`.
3. Let short Runs finish; avoid polling.
4. Inspect Trace when evidence or attention requires it; its summary states whether retained history is complete.
5. Inspect Control capacity before diagnosing stale work or saturation, then send only declared actor-local Controls.
6. Use runtime kill/cancel behavior for lifecycle termination.
7. Inspect artifacts and execution evidence for final validation.

If work may outlive the current turn, needs steering, produces artifacts, fans out, or must remain inspectable, use a Run rather than shell backgrounding.

## Top Recipes

- [Repository health](../../recipes/pipeline-repo-health.json)
- [Quorum review](../../recipes/pipeline-quorum-review.json)
- [Artifact bundle](../../recipes/pipeline-artifact-bundle.json)
- [Music player service](../../recipes/music-player.json)
- [Resource locker service](../../recipes/resource-locker.json)

## Deep References

- [Recipe library](../../docs/recipe-library.md)
- [Async Runs](../../docs/async-runs.md)

Read repository source and tests for exact contracts when changing pi-actors itself. Update this skill whenever durable Run mechanics change.
