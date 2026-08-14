# Runs

Use a Run when execution may outlive the current turn, needs declared Control, produces retained artifacts/evidence, fans out, or must remain inspectable.

## Launch

```text
spawn recipe=<skill>/<recipe> values={...} as=run:<id>
```

Use the owning capability Skill to choose the Recipe and capability-specific values. Retain the returned Run id. A spawn result reports `launch_kind: "spawn"`; it is never evidence of registered-tool invocation.

## Observe

Normally wait for terminal follow-up. Inspect only when requested, when meaningful attention arrives, or when the Run is overdue or blocked:

```text
inspect target=run:<id> view=recipe
inspect target=run:<id> view=trace
inspect target=run:<id> view=control
```

Trace is bounded retained observation, so read its completeness summary. Prove final outcomes with terminal status, result, declared artifacts, and execution evidence rather than assuming retained Trace is exhaustive.

## Control

Send an actor-local action only when the root Recipe declares and implements it:

```text
message target=run:<id> action=<declared-action> input={...}
```

Inspect Control when readiness, capacity, stale work, or saturation matters. Put large data in an artifact and send only a bounded reference or instruction. Use runtime-owned termination for a stuck Run rather than inventing undeclared service actions.

Control is not actor chat, peer routing, or a task inbox. A Recipe import does not create a peer actor. Several actors/subagents require the `swarm` methodology in addition to these Run mechanics.

## Safety

Operate only on owned Runs and their active generation. Never edit Run state to force an outcome, bypass process identity checks, or signal processes directly from UI/instruction code. Restart creates new generation-local evidence; inspect the exact generation before destructive lifecycle action.
