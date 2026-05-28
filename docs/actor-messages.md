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

Cross-branch communication adds one organic endpoint kind:

```text
room:<run>
```

A room is the task's single shared discussion channel: an addressable mailbox with an append-only message log and a compact member roster stored under the owning run state. It is not a broker or coordinator: it accepts normal actor-message envelopes, records shared timeline entries, tracks join/leave presence, and lets actors discover peers for direct messages. `room:<run>` is the public address; named subrooms are intentionally not exposed in 0.17.

An alternate implementation shape is a dedicated non-LLM communication actor: a small script-backed service recipe, possibly singleton-scoped, that owns room timelines, rosters, subscriptions, and fanout. This is attractive when communication needs outgrow simple file-backed room state, but it should remain an implementation adapter behind the same `room:<run>` address and message envelope. The public model should not fork into a separate chat API.

That actor-backed shape can also reduce direct file storage. Instead of every protocol feature owning JSON files as primary state, a helper actor can keep live room/roster structures in memory or another local structure and write files only as snapshots, audit logs, artifacts, or recovery checkpoints. The decision boundary is practical: keep files when durability and inspectability are the main value; prefer actor-owned structures when live coordination, subscriptions, fanout, unread state, or mutation consistency becomes the main value.

Current backend decision: keep the file-backed adapter for now. The covered workload is append-heavy room coordination plus direct branch inbox queueing/claiming, where durable local files are still the useful source of truth for recovery and `inspect`. Live notification is a separate advisory wake layer: actors may subscribe to `wake.jsonl` changes through a cross-platform file notifier and still reconcile canonical mailbox files if a wake is missed. A communication helper should be introduced only when a real workflow needs long-lived subscriptions, live fanout policy, or shared mutable room state beyond the current lock/debounce/compaction safeguards.

Package-specific endpoints may still exist, but the envelope stays the same.

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
- `type`: required semantic message type. Prefer compact dotted names such as `control.stop`, `task.claim`, or `player.next`, where the prefix is the interaction channel/domain and the suffix is the action. Many script-backed actors should be able to dispatch from `type` alone without requiring a structured body.
- `summary`: short human-facing line for notifications/follow-ups.
- `body`: optional string or JSON payload. Use it when extra context is needed: scripts may ignore it for action-only messages, while LLM-backed agents can accept free-form natural-language prompts without a rigid schema.
- Routing/delivery is inferred from `to`, actor ownership, and coordinator runtime policy; recipes should not expose delivery knobs. When a coordinator session is known, addressed run/branch/control messages fail closed before controlling or emitting from runs owned by another session.
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
branch -> room
room -> branch notification
coordinator -> tool
```

Transports differ, but the public contract does not:

- `to: run:<id>` routes through the run-local control channel selected by that recipe or runtime adapter.
- `to: coordinator` routes to the runtime attention path when `from` names a run actor. `to: session:<id>` uses the same actor-message path only when the sender run is owned by that session, making explicit session-directed checkpoints possible without exposing runtime delivery knobs. Generic async-runner `command.done` messages and explicit coordinator/session-bound messages include the actor envelope fields alongside runtime metadata.
- `to: branch:<run>/<branch>` currently routes through the parent run mailbox with the full envelope preserved so the run or recipe-specific worker protocol can dispatch branch-local control. It also persists a queued branch-local copy under `branches/<branch>/inbox.jsonl`, inspectable with `inspect branch:<run>/<branch> view=mailbox`; compact inspection includes the inbox message `id`, status, route, type, and timestamps so worker protocols can correlate claims/retries. Branch-local inbox append and status rewrites are guarded by a small lock so direct delivery and coordinator claims do not overwrite each other during bursts. Status transitions preserve active queued/claimed records and compact older handled/failed terminal records with bounded retention, so persistent runners do not accumulate unbounded completed inbox history. Coordinator claim handling also assigns an ID to older/manual queued records that do not have one so they can still transition to `handled` or `failed` instead of repeating forever. It is not a broadcast room and it does not make an arbitrary prompt process consume the message automatically. Target direction: direct branch messages should become initiating inbox work for long-lived branch runners, delivered into the recipient's next prompt/context as soon as the runner can accept work.
- `to: room:<run>` appends the full envelope to the room timeline, updates room state for room-control types such as `actor.join` and `actor.leave`, and can route selected-recipient multicast when `metadata.recipients` contains same-run `branch:<run>/<branch>` addresses.
- `to: tool:<name>` invokes an executable pi tool by name. Object bodies become tool parameters; primitive bodies are passed as `{ "input": body }`.

Transport is not public API unless a recipe explicitly documents a custom endpoint.

## Rooms and Rosters

The task room is the discovery and shared-context layer for actors whose spawn-tree positions do not give them each other's addresses. The spawn tree remains the lifecycle/provenance structure; the task room describes the group communication graph. Direct messages and room messages can share the same semantic `type` such as `chat.message`; the route (`to: branch:*` versus `to: room:*`) determines whether delivery is private or group-wide.

Use direct branch messages only when the receiving branch is backed by a worker or recipe that reads the parent run mailbox or branch inbox and dispatches branch-targeted envelopes. Room roster contacts are discovery hints, not a guarantee that an independent prompt process is subscribed to its branch address. The current branch inbox records queued mailbox work; runner-side claiming/handling turns direct messages into prompt work for the recipient branch, while room messages remain shared transcript entries. A direct message may ask the recipient to inspect room history when broader shared context is needed. For ad hoc or transcript-driven swarms without such a runner, prefer room-visible replies and mentions so every participant can inspect the shared timeline.

Direct branch delivery is prompt steering for worker-backed branches, not a coordinator follow-up. Packaged coordinator flows claim queued branch inbox records immediately before launching the branch's next prompt, append a bounded "direct messages for you" section to that prompt, and then mark the claimed records `handled` or `failed` based on the prompt result. Generic one-shot `pi -p` children do not receive this injection automatically; a recipe must own the runner loop or use the packaged coordinator path for direct messages to become next-prompt work.

Selected-recipient multicast stays route-based: send one `to: room:<run>` envelope with `metadata.recipients` set to same-run branch addresses. The room timeline keeps the original room-visible envelope, and the runtime also forwards branch-targeted copies to each listed recipient. This is not a subroom; it is a shared transcript plus explicit direct delivery for actors whose worker protocol consumes branch envelopes.

A minimal join message:

```json
{
  "to": "room:review",
  "from": "branch:review/security",
  "type": "actor.join",
  "summary": "Security reviewer joined",
  "body": {
    "role": "reviewer",
    "caps": ["security-review", "risk-analysis"],
    "claim": "Review auth boundary risks"
  }
}
```

A leave message removes that actor from the roster while preserving the timeline entry:

```json
{
  "to": "room:review",
  "from": "branch:review/security",
  "type": "actor.leave"
}
```

Room messages require `from` so roster presence and provenance stay explicit. The sender must belong to the room's run (`run:<run>` or `branch:<run>/<branch>`), which prevents accidental cross-run roster pollution. Other room posts also refresh sender presence, defaulting the role hint to `actor` when no richer role is known.

Roster entries should keep identity axes separate:

- `address`: Stable route for direct messages.
- `parent`: Spawn-tree parent for provenance and ownership checks.
- `role`: Current task function; dynamic and prompt-dependent.
- `caps`: Capabilities the actor can offer.
- `claim`: Current work claim or focus.
- `status` / `last_seen`: Presence and staleness hints.

Compact roster inspection includes these hints when present so agents can discover direct-message targets without verbose JSON.

Actors should receive a compact visible communication snapshot rather than a full global tree: self, parent/root, joined rooms, relevant sibling/member addresses, and role/capability hints. Current run actors get `communication.json` in their state dir, and async templates receive `{communication_file}`, `{actor_address}`, and `{default_room}` values. The snapshot includes `self`, `root`, optional `parent`, the default room, current default-room members, direct-message `contacts` derived from the room roster, and `updated_at`. Branch-local snapshots are refreshed when a branch joins or posts in the default room, so actors can discover peers without reading full timelines. Full timelines and rosters remain intentional inspection surfaces. For TUI and compact operator display, `view=previews` returns bounded message preview records with `timestamp`, `from`, `to`, `type`, optional `summary`, and optional `body_preview`.

## Mailbox Declaration

Recipes can declare their conversational surface:

```json
{
  "mailbox": {
    "accepts": [
      "control.continue",
      "control.revise",
      "control.approve",
      "control.kill"
    ],
    "emits": ["checkpoint.needs_scope", "branch.done", "run.done"]
  }
}
```

`mailbox.accepts` is a contract for coordinator-to-actor messages. `mailbox.emits` is a contract for actor-to-coordinator or actor-to-actor messages. Packaged interactive and message-producing recipes declare mailbox metadata so coordinators can discover semantic message types without reading transport details. Message-producing recipes produce actor-message-envelope-shaped records with `to`, `from`, `type`, `summary`, `body`, optional `correlation_id`/`reply_to`, and optional `metadata` fields. Coordinator follow-ups preserve bounded body previews and metadata so checkpoints do not lose their actionable payload. Deterministic pipelines should prefer `utility-actor-message` for this wrapping so message shape is validated and guaranteed instead of delegated to a prompt; its recipe args intentionally mirror the envelope field names.

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

`spawn` creates detached `run:<id>` actors from a recipe file/name or inline command template. Spawn metadata may include explicit `state_dir` and named `artifacts` for terminal follow-ups and inspection. Room rosters are durable but burst-safe: repeated messages that only update `last_seen` may be coalesced briefly, while semantic roster changes such as role/status/display still write immediately.

## Inspect

`inspect` reads state intentionally:

```json
{
  "target": "run:review",
  "view": "status"
}
```

The implementation supports `status`, `tail`, `messages`, `artifacts`, `files`, `mailbox`, and `communication` for `run:<id>` actors, `status`, `messages`, `previews`, `roster`, and `contacts` for `room:<run>` actors, `status`/`runs` for `coordinator`, `session:<id>`, and `session:all` actors with optional status filtering, and `status`/`schema` for registered `tool:<name>` actors. Run mailbox inspection shows recipe-declared mailbox metadata plus recent durable run inbox entries; branch mailbox inspection shows branch-local queued/claimed/handled records. Room `status` returns compact message/roster counts plus `last_message_at`, `last_message_from`, `last_message_type`, and `last_message_summary` when available, without parsing the full timeline into actor envelopes. Use `messages` for actor-envelope inspection. `inspect target=coordinator` requires a current coordinator session; use `session:<id>` or `session:all` when the session is intentionally explicit. Direct `run:<id>` and `room:<run>` inspection respects coordinator-session ownership when the current session is known. `inspect` is for decision points and diagnosis only; examples must not teach sleep-then-inspect polling.

## Runtime Direction

Runtime operations use the actor/message vocabulary:

```text
create detached work -> spawn
run-local control    -> message to run:<id>
run force-kill       -> message type control.kill
platform control     -> internal adapter selected from run state
coordinator signal   -> message to coordinator/session
tool execution       -> message to tool:<name>
intentional observe  -> inspect
```

## Non-goals

- No generic expression language in templates.
- No public transport-path vocabulary in recipe args.
- No polling-first examples.
- No separate upward and downward message schemas.
- No heavyweight chat/broker subsystem when an addressable room mailbox is enough.
- No broad facade that hides artifacts, logs, or ownership checks.
