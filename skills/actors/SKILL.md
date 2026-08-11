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

A Recipe defines execution. It may declare args, defaults, imports, artifacts, command-template flags, and `control: ["action"]` when a long-lived service actually consumes actor-local inputs.

Do not declare Control for ordinary one-shot work. Runtime lifecycle actions such as `kill` stay runtime-owned and must not appear in Recipe Control declarations. Imported Recipes act as local definitions inside one Run; they do not create nested Runs unless execution explicitly spawns them.

Prefer maintained packaged Recipes over ad hoc wrappers. Keep model, thinking, mission, concurrency, quorum, and timeout choices caller-owned unless a Recipe documents a stable policy.

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

Trace never carries sender, recipient, route, reply, or message-envelope fields. First-party writers use the canonical append authority, which validates and size-checks under a token-owned cross-process lock before one append-only JSONL write. Use `attention: "notify"` for visible notification and `attention: "followup"` only when the coordinator must receive semantic follow-up context. Prefer artifacts or complete execution captures for large evidence.

## Control

The public Control request is exact:

```json
{ "target": "run:<id>", "action": "pause", "input": {}, "verbose": false }
```

Valid Controls persist in `controls.jsonl` before delivery; invalid envelopes remain outside the journal. Token-owned locks serialize atomic journal replacements. Service endpoints publish readiness in `control-endpoint.json` with the immutable startup `run_instance_id`; only FIFO and named-pipe endpoints transport Controls. Both transports share one portable envelope: action is at most 64 lowercase ASCII characters, serialized JSON input is at most 380 bytes, and the newline-terminated wire record is at most 512 bytes. Partial writes fail, and controlled FIFO readers remain gap-free across writers. Put larger data in a declared artifact/path and send only its bounded reference or instruction through Control. Delivery revalidates owner, generation, running state, and process identity under the lifecycle lock.

`kill` remains a runtime lifecycle action. Use an actor-local action such as `stop` only when the Recipe declares and implements it.

## Run State and Safety

Run state lives under `~/.pi/agent/tmp/pi-actors/runs/<run>/`. Important evidence includes:

- `run.json`: captured Run identity, Recipe, owner, generation, process identity, and policy.
- `trace.jsonl`: structured observations.
- `controls.jsonl`: durable actor-local inputs and outcomes.
- `control-endpoint.json`: generation-fenced service readiness.
- `execution.json`: command/session provenance and bounded complete-capture references.
- `result.json`, logs, and declared artifacts.

Never bypass owner filtering, immutable generation fencing, process-identity verification, path containment, redaction, terminal reconciliation, or shutdown kill behavior. Do not edit active Run state to force a result.

## Operating Pattern

1. Inspect the Recipe before launch when its contract or policy matters.
2. Spawn with explicit values and retain the returned `run:<id>`.
3. Let short Runs finish; avoid polling.
4. Inspect Trace when evidence or attention requires it.
5. Send only declared actor-local Controls.
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
- [Baseline and preservation gates](../../docs/0.43-baseline.md)

Read repository source and tests for exact contracts when changing pi-actors itself. Update this skill whenever durable Run mechanics change.
