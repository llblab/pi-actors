# Actor Messages

Protocol target for organic communication across pi-auto-tools.

## Contract

Compress communication to three durable verbs:

- `spawn`: create an addressable actor from a recipe, template, or tool.
- `message`: send one typed message to one address.
- `inspect`: intentionally observe state, logs, events, or artifacts.

Everything else is an adapter until proven otherwise.

## Nouns

- **Actor**: any addressable execution or coordination endpoint.
- **Address**: stable route string for an actor or sub-actor.
- **Message**: typed envelope flowing between addresses.
- **Artifact**: durable result path declared by recipe or produced by actor.
- **Inspection**: explicit diagnostic/read operation, not a coordination loop.

## Addresses

Initial address forms:

```text
run:<id>
branch:<run>/<branch>
coordinator
session:<id>
tool:<name>
```

Future forms may include `chat:<id>` or package-specific endpoints, but the envelope stays the same.

## Message Envelope

One shape covers upward, downward, lateral, parent-to-branch, and branch-to-parent traffic:

```json
{
  "to": "run:review",
  "from": "coordinator",
  "type": "control.approve",
  "summary": "Approve checkpoint",
  "body": "approve",
  "delivery": "direct",
  "reply_to": "msg_123",
  "correlation_id": "task_456",
  "metadata": {}
}
```

Field rules:

- `to`: required address.
- `from`: optional address; runtime fills when known.
- `type`: required semantic message type.
- `summary`: short human-facing line for notifications/follow-ups.
- `body`: string or JSON payload.
- `delivery`: `direct`, `log`, `notify`, or `followup` depending on route. Defaults to `followup` for `coordinator` and `direct` for actor mailboxes.
- `reply_to`: optional message id for conversational checkpoints.
- `correlation_id`: optional task/run/workflow id.
- `metadata`: optional structured routing or domain hints.

## Symmetry

The same `message` primitive must represent:

```text
coordinator -> run
run -> coordinator
run -> run
parent -> branch
branch -> parent
coordinator -> tool
```

Transports differ, but the public contract does not:

- `to: run:<id>` may route to FIFO, mailbox file, socket, or process stdin.
- `to: coordinator` routes to outbox/watch/follow-up delivery when `from` names a run actor. Generic async-runner `command.done` events and explicit coordinator-bound messages include the actor envelope fields alongside the runtime event fields.
- `to: branch:<run>/<branch>` routes through the parent run mailbox with the full envelope preserved so the run can dispatch branch-local control.
- `to: tool:<name>` invokes an executable pi tool by name. Object bodies become tool parameters; primitive bodies are passed as `{ "input": body }`.

Transport is not public API unless a recipe explicitly documents a custom endpoint.

## Mailbox Declaration

Recipes can declare their conversational surface:

```json
{
  "mailbox": {
    "accepts": ["control.continue", "control.revise", "control.approve", "control.stop"],
    "emits": ["checkpoint.needs_scope", "branch.done", "run.done"]
  },
  "events": {
    "checkpoint.*": { "delivery": "followup" },
    "branch.done": { "delivery": "followup" },
    "progress.tick": { "delivery": "log" }
  }
}
```

`mailbox.accepts` is a contract for coordinator-to-actor messages. `mailbox.emits` is a contract for actor-to-coordinator or actor-to-actor messages. `events` remains delivery policy, not transport selection. Packaged interactive and event-oriented recipes declare mailbox metadata so coordinators can discover semantic message types without reading FIFO details. Event-authoring recipes produce actor-message-envelope-shaped records with `to`, `from`, `type`, `event`, `delivery`, `summary`, `body`, optional `correlation_id`/`reply_to`, and optional `metadata` fields. Deterministic pipelines should prefer `utility-actor-message` for this wrapping so event shape is validated and guaranteed instead of delegated to a prompt; its recipe args intentionally mirror the envelope field names.

## Spawn

`spawn` creates an actor and returns its address:

```json
{
  "recipe": "subagents-prompts.json",
  "as": "run:review",
  "values": {},
  "artifacts": { "report": "{state_dir}/report.md" }
}
```

Low-level `async_run action=start` becomes an adapter for `spawn` when the actor is a detached run. The implementation supports spawning `run:<id>` actors from a recipe file/name or inline command template. Spawn metadata may include explicit `state_dir`, recipe event delivery policy, and named `artifacts` for terminal follow-ups and inspection.

## Inspect

`inspect` reads state intentionally:

```json
{
  "target": "run:review",
  "view": "status"
}
```

The implementation supports `status`, `tail`, `events`, `artifacts`, `files`, and `mailbox` for `run:<id>` actors, plus `status`/`runs` for `session:<id>` actors. `inspect` is for decision points and diagnosis only; examples must not teach sleep-then-inspect polling.

## Adapter Direction

Low-level runtime operations map onto the actor/message vocabulary:

```text
async_run action=start  -> spawn
async_run action=send   -> message to run:<id>
outbox append           -> message to coordinator
tool execution          -> message to tool:<name>
async_run action=status -> inspect view=status
async_run action=tail   -> inspect view=tail
async_run action=events -> inspect view=events
```

Compatibility shims are allowed only when they do not obscure the model.

## Non-goals

- No generic expression language in templates.
- No public FIFO/outbox vocabulary in recipe args.
- No polling-first examples.
- No separate upward and downward message schemas.
- No broad facade that hides artifacts, logs, or ownership checks.
