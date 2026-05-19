# Actor Messages

Protocol target for organic communication across pi-actors.

## Contract

Compress communication to three durable verbs:

- `spawn`: create an addressable actor from a recipe, template, or tool.
- `message`: send one typed message to one address.
- `inspect`: intentionally observe state, logs, actor messages, or artifacts.

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
- routing/delivery is inferred from `to`, actor ownership, and coordinator runtime policy; recipes should not expose delivery knobs. When a coordinator session is known, addressed run/branch/control messages fail closed before controlling or emitting from runs owned by another session.
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
- `to: coordinator` routes to outbox/watch/follow-up delivery when `from` names a run actor. `to: session:<id>` uses the same actor-message path only when the sender run is owned by that session, making explicit session-directed checkpoints possible without exposing runtime delivery knobs. Generic async-runner `command.done` events and explicit coordinator/session-bound messages include the actor envelope fields alongside the runtime event fields.
- `to: branch:<run>/<branch>` routes through the parent run mailbox with the full envelope preserved so the run can dispatch branch-local control.
- `to: tool:<name>` invokes an executable pi tool by name. Object bodies become tool parameters; primitive bodies are passed as `{ "input": body }`.

Transport is not public API unless a recipe explicitly documents a custom endpoint.

## Mailbox Declaration

Recipes can declare their conversational surface:

```json
{
  "mailbox": {
    "accepts": [
      "control.continue",
      "control.revise",
      "control.approve",
      "control.stop"
    ],
    "emits": ["checkpoint.needs_scope", "branch.done", "run.done"]
  }
}
```

`mailbox.accepts` is a contract for coordinator-to-actor messages. `mailbox.emits` is a contract for actor-to-coordinator or actor-to-actor messages. Packaged interactive and message-producing recipes declare mailbox metadata so coordinators can discover semantic message types without reading FIFO details. Message-producing recipes produce actor-message-envelope-shaped records with `to`, `from`, `type`, `summary`, `body`, optional `correlation_id`/`reply_to`, and optional `metadata` fields. Coordinator follow-ups preserve bounded body previews and metadata so checkpoints do not lose their actionable payload. Deterministic pipelines should prefer `utility-actor-message` for this wrapping so message shape is validated and guaranteed instead of delegated to a prompt; its recipe args intentionally mirror the envelope field names.

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

`spawn` creates detached `run:<id>` actors from a recipe file/name or inline command template. Spawn metadata may include explicit `state_dir` and named `artifacts` for terminal follow-ups and inspection.

## Inspect

`inspect` reads state intentionally:

```json
{
  "target": "run:review",
  "view": "status"
}
```

The implementation supports `status`, `tail`, `messages`, `events`, `artifacts`, `files`, and `mailbox` for `run:<id>` actors, `status`/`runs` for `coordinator`, `session:<id>`, and `session:all` actors with optional status filtering, and `status`/`schema` for registered `tool:<name>` actors. Prefer `messages` for actor-envelope inspection; `events` remains a compatibility alias for the same run outbox. `inspect target=coordinator` requires a current coordinator session; use `session:<id>` or `session:all` when the session is intentionally explicit. Direct `run:<id>` inspection respects coordinator-session ownership when the current session is known. `inspect` is for decision points and diagnosis only; examples must not teach sleep-then-inspect polling.

## Runtime Direction

Runtime operations use the actor/message vocabulary:

```text
create detached work -> spawn
run-local control    -> message to run:<id>
run stop/kill        -> message type control.stop/control.kill
coordinator signal   -> message to coordinator/session
tool execution       -> message to tool:<name>
intentional observe  -> inspect
```

## Non-goals

- No generic expression language in templates.
- No public FIFO/outbox vocabulary in recipe args.
- No polling-first examples.
- No separate upward and downward message schemas.
- No broad facade that hides artifacts, logs, or ownership checks.
