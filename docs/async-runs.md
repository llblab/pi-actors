# Async Run Standard

Async runs are detached executions of a template recipe or inline command template.

**Meta-contract:** the command template is still the execution graph; the async run is only a lifecycle envelope with state, logs, actor messages, status, cancellation, and coordinator-scoped observability.

**Scope:** run id, state path, runner pid, process-group cancellation, logs, status, tail, list, script-authored actor messages, run-local control messages, cancel, force-kill, terminal result state, ambient activity indicators, and extension-owned temp storage. No scheduler, queue daemon, workflow DSL, distributed worker, or second execution language.

Actor-mode trigger: choose an async run when work may outlive the current turn, needs later steering or inspection, produces artifacts/follow-ups, runs as a service, fans out, or should become repeatable recipe memory. Keep short foreground checks in ordinary tools/templates.

Layer boundary: async-run configuration may inject lifecycle values such as `{run_id}` and `{state_dir}` and may choose detached execution through `async: true`, but it does not add command-template graph syntax. Recipe imports and recipe-local references belong to the template-recipe layer; status, control messages, actor messages, cancel, and kill belong to the async-run layer.

---

## Layer Ownership

Async-run standard owns:

- Detached process lifecycle for one execution instance.
- Run identity, state directory, pid/process-group tracking, logs, status, list, tail, actor-message inspection, run-local control, cancel, and kill.
- Injected lifecycle values such as `{run_id}` and `{state_dir}`.
- Coordinator-scoped observability and script-authored actor messages.

Async-run standard does not own:

- Command-template syntax, placeholders, graph semantics, or branch policy.
- Recipe import resolution, filename-derived recipe identity, or recipe storage format.
- Domain semantics for subagents, swarms, release readiness, media playback, or project policy.
- Scheduling, queue daemons, distributed workers, or workflow DSLs.

## Reading Model

```text
recipe       = saved JSON definition
run          = one execution instance
lifecycle    = state/logs/messages/status/control/cancel/kill envelope
state dir    = ordinary files for status/logs/messages/result
coordinator  = agent session that started the run
```

Use async runs when work may outlive the current agent turn, should not block the agent, or should remain cancellable after launch.

Rule of thumb:

```text
short call or pipeline → foreground template/tool
reusable saved graph   → template recipe
long or background work → spawn run actor
```

## Starting Runs

A recipe with `async: true` starts detached when invoked through its registered tool:

```json
{
  "async": true,
  "template": "play-audio {source}"
}
```

A caller can also start any recipe or inline template explicitly through `spawn`:

```json
{
  "as": "run:music",
  "file": "music-player",
  "values": {
    "source": "~/Music"
  }
}
```

`spawn` always starts a detached run actor. Registered recipe tools follow the recipe's `async` flag.

Use `run_id` on async recipe tools or `as: "run:<id>"` on `spawn` when the caller wants a stable id for later inspection or control. The recipe filename identifies the saved definition; the run id identifies one execution instance of that recipe. Async runs inject lifecycle and communication values into template values so scripts can write run-local status files, control endpoints, or room-aware coordination messages:

- `{run_id}`: stable run id.
- `{state_dir}`: run-local state directory.
- `{actor_address}`: run actor address, e.g. `run:review`.
- `{default_room}`: default room address, e.g. `room:review`.
- `{communication_file}`: compact communication snapshot path.

Review commands that require semantic evidence apply marker acceptance before command completion accounting. Rejected code-zero output is reported consistently as a failed command in events, progress, evidence, and outbox delivery; it cannot emit a success-level completion notification. Evidence records are written before command launch and lifecycle cancellation or kill finalizes any running record with its interrupted state, effective exit code, and attempt capture paths. Async attempt stdout/stderr files exist from attempt start, so even small partial streams remain auditable when a command never returns.

## State Files

Use ordinary files under the extension temp directory so status tools stay simple and inspectable:

- `.pi-actors-run-state.json`: runtime ownership marker binding the run id to the canonical state directory; launch reuse and destructive retention fail closed when it is absent, invalid, mismatched, or reached through a symlink alias. State reuse also fails closed whenever the persisted process identity mismatches a still-live pid, preventing corrupted metadata from admitting overlapping runners.
- `run.json`: pid, cross-platform `process_identity` proof (start time, command, and canonical cwd where available), optional source metadata (`launch_source`, `tool`, `recipe`, `recipe_file`), command-template config, cwd, coordinator owner id, values, named `artifacts`, mailbox metadata, created time, and state dir. Existing launch cwd aliases are resolved through native `realpath` before proof matching, so symlinked working directories do not degrade control to `unsupported_proof`.
- `communication.json`: compact actor communication snapshot with self/root/parent, default-room, member, and contact hints for room-aware scripts and agents.
- `progress.json`: phase, active command count, completed count, failures, updated time, and optional `model_policy` provenance for inherited/explicit model and thinking values.
- `events.jsonl`: append-only implementation lifecycle log.
- `outbox.jsonl`: implementation storage for actor-message envelopes used by `inspect view=messages`, coordinator notifications, or follow-up context. Coordinator follow-ups preserve bounded `body` previews plus message metadata for decision points.
- `stdout.log` and `stderr.log`: detached process output.
- `prompts/command-NNN.md`: state-owned prompt files that collapse child `pi -p` natural-language positional fragments and appended recipe context into one authoritative `@file` prompt while preserving intentional file/image arguments.
- `captures/command-NNN/attempt-NNN/{stdout,stderr}.log`: complete byte-exact command streams, retained even below the bounded in-memory capture limit and separated across retries.
- `review-evidence.json`: stable command/stage manifest linking prompts, repeated branches, capture attempts, byte counts, exit state, semantic marker acceptance, recipe context, and model/thinking policy; terminal status aligns with the run. Review pipelines inject prior-stage `ACTOR_EVIDENCE_REF` values into downstream prompts, record cited/missing report sources, and fail closed if a normalized report claims `complete` without every required reviewer, verifier, merger, and judge reference.
- `result.json`: final code, killed flag, output selector, and optional full-output path.

Public `spawn` always uses the runtime-owned run root; caller-selected state directories are rejected so `run:<id>` addressing and retention share one boundary. Internal adapters may still supply isolated state directories for deterministic fixtures, but those are not part of the public actor contract. Every launched runner also persists a process identity proof and revalidates it for status, state reuse, message delivery, cancellation, kill, and retirement; dead pids, reused-pid owner mismatches, and unavailable platform proofs remain distinct diagnostics and destructive controls fail closed.

For pi-actors, actor run state defaults to:

```text
~/.pi/agent/tmp/pi-actors/runs/
```

State files use this shape:

```text
~/.pi/agent/tmp/pi-actors/runs/<run>/run.json
~/.pi/agent/tmp/pi-actors/runs/<run>/communication.json
~/.pi/agent/tmp/pi-actors/runs/<run>/progress.json
~/.pi/agent/tmp/pi-actors/runs/<run>/events.jsonl
~/.pi/agent/tmp/pi-actors/runs/<run>/outbox.jsonl
~/.pi/agent/tmp/pi-actors/runs/<run>/stdout.log
~/.pi/agent/tmp/pi-actors/runs/<run>/stderr.log
~/.pi/agent/tmp/pi-actors/runs/<run>/review-evidence.json
~/.pi/agent/tmp/pi-actors/runs/<run>/captures/command-NNN/attempt-NNN/stdout.log
~/.pi/agent/tmp/pi-actors/runs/<run>/prompts/command-001.md
~/.pi/agent/tmp/pi-actors/runs/<run>/result.json
```

Terminal status is `done` for result code 0 and `failed` for non-zero result code. A stopped run reports `cancelled` after graceful cancel or `killed` after force kill once the runner is no longer alive. If the runner process exits before writing a result and no stop event was recorded, status is `exited`.

## Reactive Coordinator Loop

Async runs are designed for message-driven coordination, not polling loops. A good coordinator starts long-lived or multi-agent work, lets completion and decision-point actor messages bubble upward, and sends corrective commands only when the run asks for input or the operator changes direction.

The core loop is:

1. Start an async recipe and keep the coordinator free:

   ```json
   { "recipe": "music-player.json", "as": "run:music" }
   ```

2. Let terminal completion, `command.done`, and script-authored follow-up messages reach the launching coordinator automatically. When a directly spawned inline/ad hoc actor or a recipe outside `~/.pi/agent/recipes` completes successfully, the coordinator follow-up tells the agent to offer recipe persistence only as a question to the operator; it must not auto-save.

3. Respond with explicit run-local messages when needed:

   ```json
   { "to": "run:music", "type": "player.next", "body": "next" }
   ```

4. Do not inspect just because time passed. Inspect `status`, `tail`, or `messages` only when a follow-up asks for inspection, a real decision depends on it, or a suspected stuck run needs diagnosis.

Addressed `message` calls and coordinator follow-ups are the paired control plane: run-to-coordinator actor messages flow upward, while coordinator-to-run actor messages flow downward. Recipe scripts own the message vocabulary (`next`, `pause`, `approve`, `revise`, `continue`, and so on); pi-actors owns the safe run-local transport, coordinator-session ownership checks, and coordinator attention policy.

### Persistent backlog implementers

Backlog implementer actors should be long-lived workers, not one-shot prompts, when the coordinator wants continuous branch work. A typical run starts two actors, such as `branch:<run>/front` and `branch:<run>/back`, that claim from opposite ends of the canonical backlog and share `room:<run>` for visibility.

The stable loop is:

1. Coordinator sends `task.assign` to an idle branch actor with the exact backlog slice and validation boundary.
2. Actor posts `task.claim` to `room:<run>` before editing.
3. Actor completes the slice, validates, and posts `task.result` plus `awaiting_assignment`.
4. Actor remains alive and waits for the next coordinator message.
5. Coordinator either sends another `task.assign` or sends `control.kill` after confirming no actionable work remains.

Implementer recipes should declare this contract in `mailbox.accepts` and `mailbox.emits`. They should not self-terminate after a successful slice, and they should not silently self-select a new task unless the coordinator deliberately configured that policy for the run. This keeps task choice centralized while preserving actor-local execution autonomy.

## Tool Surface

The actor-level surface is:

- `spawn`: start a detached `run:<id>` actor from `file`, `recipe`, or inline `template`.
- `message`: send one typed envelope to `run:<id>`, `branch:<run>/<branch>`, `room:<run>`, `tool:<name>`, `coordinator`, or `session:<id>`.
- `inspect`: intentionally read owned `run:<id>` status, tail, messages, artifacts, files, mailbox metadata plus recent run inbox entries, or communication snapshot; read `room:<run>` status, messages, previews, roster, or contacts; read current `coordinator` run inventory only when a coordinator session is known; read `session:<id>` or `session:all` run inventory with optional status filtering when the session is explicit; read `tool:<name>` status or schema for registered tool actors.

Opt-in supervisor retirement uses `retire_when: "children_terminal"` as lifecycle metadata. Run summaries discover nested child run state dirs under the visible state root so bounded supervisor trees are observable. Candidate detection is conservative: a supervisor is not retirement-ready while command-template progress, descendant `pi -p` worker processes, or nested child async runs under the supervisor state dir are still active. Candidate metadata includes observed child-run counts. When the session watcher observes a ready candidate, it sends a graceful `stop` control message once; if the run has no ready control endpoint, it falls back to owned-run cancellation and records the terminal action through normal run events. Persistent or non-opt-in runs are not retirement candidates.

Low-level async actions map into the actor surface instead of forming a second public model:

- Start → `spawn`
- Send/control → `message`
- Status/tail/messages/list → `inspect`
- Force kill → `message` with `control.kill`, with synchronous results
- Archive/prune terminal state → `message` with `control.archive` or `control.prune`, with active runs rejected fail-closed; retained artifacts use collision-safe identity-derived filenames, preserve timestamps, skip missing optional files, and abort prune before source deletion on any copy failure

Compact text is returned by default so async management does not flood agent context; use verbose inspection when the full state object is needed. List output intentionally shares one state root across music, subagents, timers, and other async work; source fields such as `tool` and `recipe` distinguish run purpose when the launcher recorded them. The run root may contain a rebuildable `index.json` with run id, state directory, owner, status, update time, and recipe/tool hints; corrupt indexes fall back to recursive scan. Registered tools are the preferred user-facing surface for reusable recipes. `control.prune` accepts `body.preserve_artifacts=true` to copy existing named artifacts beside the run root before deleting terminal state.

## Run-Local Messages

`message` is the explicit coordinator-to-actor command channel. Use it when a running recipe exposes a control vocabulary, a branch needs parent-mediated control, a registered tool should be invoked as `tool:<name>`, or the coordinator needs to redirect work without killing or restarting it.

Some recipes expose a run-local control channel. When present, a caller can send a typed actor message:

```json
{
  "to": "run:music",
  "type": "player.next",
  "body": "next"
}
```

For `run:<id>`, `message` adapts the body to the recipe's run-local control channel. For `branch:<run>/<branch>`, it sends the full envelope through the parent run mailbox and records a queued branch-local inbox entry at `branches/<branch>/inbox.jsonl` so the run can dispatch branch-local control. Current consumers are recipe-specific worker protocols that read the parent run mailbox or branch inbox; independent one-shot prompt processes do not automatically consume branch inbox entries. In packaged coordinator flows, queued branch inbox records are claimed immediately before the branch's next prompt is launched, appended as direct prompt-steering context, and then marked `handled` or `failed` from the prompt result. This path is not a follow-up notification; it is a runner-owned prompt queue. For `tool:<name>`, object bodies become the target tool parameters and primitive bodies are passed as `{ "input": body }`. The generic runtime records control messages but does not interpret arbitrary run mailbox content. For example, a music player may accept `play`, `pause`, `next`, and `stop`, while a collaborative agent recipe may accept `continue`, `revise:<note>`, `approve`, or `abort`. Recipes may treat terminal control messages such as `stop` as synchronously handled so the later process exit does not generate a duplicate async follow-up.

Run-local control uses a platform adapter under the same `message` API. Unix recipes may keep the existing FIFO endpoint, and native Windows recipes can expose a named-pipe endpoint in run state. Recipe authors should document message vocabulary through `mailbox.accepts`, not through transport arguments. Packaged scripts that still create Unix-only endpoints remain WSL/Linux/macOS-only until migrated.

Portable control matrix:

| Control surface | Linux/macOS/WSL | Native Windows | Guidance |
| --- | --- | --- | --- |
| File-backed run inbox + wake | Supported | Supported | Preferred durable baseline. |
| Mailbox-only endpoint | Supported | Supported | Use for cross-platform workers. |
| FIFO endpoint | Supported | Rejected before delivery | Keep only for Unix-compatible recipes. |
| Named-pipe endpoint | Optional | Supported | Use for native Windows live delivery. |
| Kill | Process group signal with pid fallback | Process-tree adapter | Same public `message type=control.kill` API. |


Runtime wake notifications are now modeled separately from durable queues. Message handling records canonical state in file-backed mailbox/event files before attempting optional live endpoint delivery. Runs may expose a mailbox-only control endpoint when durable inbox plus wake notification is the intended delivery path; FIFO and named-pipe endpoints remain compatibility/fast-wake paths rather than the durable queue itself. Successful FIFO or named-pipe delivery marks the run inbox entry `sent`; mailbox-only delivery leaves the entry queued for the runtime to claim. `wake.jsonl` is an advisory doorbell that lets a live runtime subscribe through file-system notifications plus explicit initial, wake-triggered, and polling reconciliation callbacks. A missed wake must not lose work because actors can re-read the canonical mailbox state. Runtime loops that consume the file-backed mailbox should claim queued run inbox entries, then mark them `handled` or `failed`; the helper path uses a small lock so concurrent reconciliation callbacks do not process the same entry twice.

## Coordinator Notifications

The launching coordinator should not busy-poll long-running async runs. The extension watches run state directories and queues terminal `done`/`failed`/unhandled `killed`/`exited` transitions back to the owning session through Pi's `followUp` delivery mode with `triggerTurn: true`; a busy coordinator finishes its current work before queued actor results arrive, while an idle coordinator starts a normal turn without a racy manual idle check. Pi's configured `followUpMode` determines whether concurrently queued results arrive together or one at a time. Script-authored `notify`/`followup` actor messages still follow their declared outbox delivery policy. Terminal notifications include recipe-level named `artifacts` when declared. The generic runner also emits compact `command.done` actor messages for completed leaf commands; recipe authors declare that capability in `mailbox.emits` rather than configuring a separate delivery policy. Failures and in-flight parallel branch completions can bubble according to outbox policy, while successful final leaf completions stay diagnostic to avoid flooding long sequential pipelines. Intentional `control.kill` and recipe-local stop commands stay out of coordinator context because the initiating message already returns synchronously or is handled by actor-local policy. If a notification asks for direction, answer with `message` rather than starting a polling loop. Use explicit `inspect` only when a delivered notification requests inspection, a real decision depends on state, or a suspected stuck run needs diagnosis — never merely because a timeout elapsed.

Ambient status indicators may refresh while work is active, but coordinator attention is driven from run-state changes rather than a coordinator agent loop. This lets the coordinator continue other work after `spawn`; the run signals back through lifecycle state, results, and actor messages. File-system watchers accelerate live discovery, while a bounded ten-second terminal-only reconciliation pass scans owned unhandled terminal state without reading or replaying outbox traffic. Failed root or run-directory watcher attachment, runtime errors, error-driven watcher removal, and successful rearm remain available as bounded runtime diagnostics; normal run-directory deletion stays quiet; reconciliation rearms degraded watchers but does not depend on them. An owned terminal run without `terminal-handled.json` remains retry-eligible during same-runtime and extension/session replacement reconciliation; the marker is written only after successful follow-up delivery, and initial reconciliation does not replay historical outbox traffic. Watch-triggered and periodic delivery share an in-flight guard so one live runtime sends one follow-up when both paths race. This is an at-least-once contract: a process crash after send but before marker persistence can produce a duplicate notification, while a failed send remains durably retryable. The ambient triangle count represents active async work units: each running async run contributes at least one triangle, and a run with multiple active parallel command/subagent branches contributes the reported active branch count. If a coordinator starts one parent run with four active parallel branches, four triangles are shown; if the same coordinator starts five independent single-branch runs, five triangles are shown.

## Run Actor Messages

A recipe or script may emit coordinator-bound or session-bound actor message records. The runtime persists those records in the run state dir and exposes them through `inspect target=run:<id> view=messages`.

Shape:

```json
{
  "type": "player.track",
  "to": "coordinator",
  "from": "run:music-player",
  "summary": "Now playing: track.flac",
  "level": "info",
  "ts": "2026-05-19T00:00:00.000Z",
  "body": { "track": "/Music/track.flac", "index": 3, "count": 42 }
}
```

`level` is `info`, `warning`, or `error`. The public message describes sender, receiver, type, summary, and body; it does not choose notification mechanics. Runtime attention policy infers whether a coordinator-bound message stays available for explicit `inspect`, becomes a UI notification, or re-enters the launching coordinator as compact follow-up context.

Use coordinator/session-bound messages for completion and decision points, not for every progress tick. Packaged multi-agent branch completion is a completion message and should bubble by default. Follow-up path lists use Markdown hierarchy: a section heading, `- Base: ...`, and `- Files: ...`, so repeated run-state prefixes do not flood agent context.

## Cancellation And Ownership

An async run belongs to the current user, cwd, and launching agent session at start time. Send, cancellation, and force-kill target only the recorded runner pid when command line and cwd still match the recorded owner data. Stale pid reuse must fail closed.

Immediately before signaling, control revalidates the persisted process identity a second time inside the state-directory lifecycle lock. On Unix-like systems, `control.kill` signals the runner process group when available and falls back to the exact runner pid only when group signaling returns `ESRCH` and one additional identity revalidation still matches; authorization and permission errors fail closed without fallback. On native Windows, `control.kill` uses Windows process-tree termination through the platform adapter. The runner starts command-template children in the owned process tree, so long-running descendants such as audio players should stop with the run instead of becoming orphaned background processes. A recipe may manage a true detached daemon, but then daemon ownership is recipe-local: the script must persist and verify a pid or service handle, expose status/stop behavior, and bridge `control.kill` to daemon cleanup. The generic runner does not scan for or guess detached services. After the process exits, status reflects the operator action as `killed` instead of a generic `exited`. Programmatic `cancelRun()` remains an internal lifecycle helper for retirement and tests, but it is not a documented actor-message action. Node does not expose one portable identity-stable process-group handle across Linux, macOS, and Windows, so a runner can theoretically exit and its PID/PGID can be reused after the final identity read but before the OS signal call. Generation fencing, lifecycle serialization, immediate revalidation, and error-specific fallback minimize this residual platform window; docs and evidence must not claim pidfd/handle-level atomic signaling where the host cannot provide it.

State is append-only where practical. Final result writes should be atomic. Recipe-local control endpoints and actor-message logs may live in the state dir. pi-actors core owns the generic run-local message adapter and runtime attention policy; command and message vocabularies belong to the recipe/script.

## Extension Temp Directory

Extension-owned temporary runtime files live under the pi agent directory:

```text
~/.pi/agent/tmp/<extension-name>/
```

Rules:

- Use the pi agent temp tree, not system temp, for extension-owned state.
- Use system temp only for OS-level scratch files or explicit operator overrides.
- Keep each extension in its own subdirectory named after the local extension name.
- Prepare the extension temp directory on session start.
- Prune stale entries on session start.
- Default stale age is 24 hours unless the extension has a stronger reason.
- Cleanup must be fail-open: cleanup races should not prevent extension startup.
- The `runs` state root is preserved by startup cleanup; run lifecycle cleanup must be explicit and run-aware.
- State that must survive restarts belongs in the agent root, not in `tmp`.

## Parent Session Teardown

Async actors may outlive individual agent turns. Every Pi `session_shutdown` reason (`quit`, `reload`, `new`, `resume`, or `fork`) scans persisted run state and attempts teardown for discovered readable `running` runs whose exact `ownerId` matches the retiring coordinator session. Each new run persists immutable `run_instance_id`; teardown carries expected owner/generation into canonical `control.kill`, which compares both while holding the state-directory lifecycle lock shared with restart. Missing ownership or generation fails closed; terminal, ambiguous, changed-generation, and other-session runs remain untouched. Teardown never signals processes directly.

Teardown remains idempotent and best-effort across discovered siblings: one signal, process-proof, or evidence-write failure does not block later candidates. A `run.parent_teardown` event is written only while the selected generation still owns that state directory; replacement generations cannot receive stale teardown evidence. Successful kills retain `run.kill`, terminal progress, process-identity fencing, and handled-marker evidence.

This boundary intentionally does not run at ordinary `agent_end`. Teardown uses unbounded directory discovery rather than the ordinary index depth cap. Unreadable directories and corrupt run state become explicit failures, and every invocation persists a bounded summary under `<run-root>/teardown/`; shutdown warnings include that path when failures remain. Actors launched by descendant Pi sessions deliberately remain outside the exact-owner contract and rely on their own session shutdown hook. A hard OS/process kill can still prevent either hook; use the persisted summary plus OS-level/manual recovery for an orphan that a replacement session cannot control safely.

## Ambient Observability

Interactive sessions expose compact activity with minimal screen cost:

- Footer status is shown only while async runs launched by the current coordinator session are active.
- Each running async run contributes at least one `▷`; if the run reports multiple active command/sub-agent branches, those branches contribute additional triangles.
- One `▶` moves across the triangles as a small wave.
- With one active command, the triangle blinks between `▶` and `▷`.
- Triangles disappear as concrete commands exit.
- No prompt-area widget is shown by default.
- Terminal `done`/`failed`/unhandled `killed`/`exited` transitions trigger compact follow-up context only in the launching coordinator session; intentional `kill` and actor-local stop actions stay out of agent context because the action already reports synchronously or belongs to recipe-local policy.
- Full logs remain in state files and are accessed through `inspect target=run:<id> view=tail` or the low-level tail adapter.

This keeps background work visible without blocking the agent, occupying the prompt area, or leaking async context into unrelated sessions.

## Swarm Mapping

Swarm coordinator responsibilities split like this:

- Generic async runtime: start, pid tracking, status, tail, list, cancellation, stdout, stderr, logs.
- Swarm semantics: lock rules, quorum manifest shape, raw review retention, merger, post-merge review, conflict policy.
- Adapter config: model pool, default merger, default reviewer, prompt lens, tool allowlist, timeout.

pi-actors owns generic actor recipes and run primitives. Swarm should keep domain-specific quorum and implementation-team semantics unless they become reusable across multiple domains.

## Collaborative Subagent Branch Adapter

A collaborative implementation swarm can use pi-actors as the actor runtime without making pi-actors own swarm semantics. The coordinator prepares scope files and chooses branch names. A trusted local runner owns one branch lifecycle. The async run owns fanout, state, logs, status, tail, cancel, and terminal result metadata.

Recommended flow:

```text
coordinator writes scope files
→ async recipe starts one branch runner per scope
→ each runner clones or worktrees the repo
→ each runner creates one feature branch
→ each runner launches one subagent
→ each runner verifies commit and push
→ coordinator inspects status and tail
→ integrator reviews and merges ready branches
```

Scope files are preferable to large inline prompts because they are inspectable, reusable from logs, and safe for longer task groups. Keep them under an agent-owned run directory such as:

```text
~/.pi/agent/tmp/pi-actors/collab-runs/<run>/scopes/agent-01.md
```

Example recipe:

```json
{
  "async": true,
  "parallel": true,
  "timeout": 1800000,
  "template": [
    {
      "label": "agent-01",
      "failure": "branch",
      "retry": 2,
      "recover": "git -C {work_dir_1} reset --hard HEAD",
      "timeout": 1800000,
      "template": "node {runner} --repo {repo} --base {base=dev} --branch {branch_1} --work-dir {work_dir_1} --scope {scope_1} --model {model}"
    },
    {
      "label": "agent-02",
      "failure": "branch",
      "retry": 2,
      "recover": "git -C {work_dir_2} reset --hard HEAD",
      "timeout": 1800000,
      "template": "node {runner} --repo {repo} --base {base=dev} --branch {branch_2} --work-dir {work_dir_2} --scope {scope_2} --model {model}"
    }
  ]
}
```

The runner is intentionally outside pi-actors. It is a trusted local executable, like any other command-template target. Its minimum contract is clone or worktree, checkout branch, run subagent with bounded tools, verify expected branch, verify a commit exists, push branch, and emit a structured result. If one runner fails, `failure: "branch"` preserves sibling results as a degraded run.

Coordinator responsibilities stay outside the async runtime:

- Partition backlog tasks by stable task IDs and non-overlapping mutation zones.
- Write scope files before starting the run.
- Pass scope paths and branch names as values.
- Use `inspect target=run:<id> view=status` or `view=tail` after terminal run messages.
- Treat pushed branches as artifacts for review, not as automatic merges.
- Record failed scopes back into the backlog.

Do not encode backlog parsing, task assignment, pull-request policy, merge policy, or model selection into pi-actors core. Those are swarm, project, or operator policy.

## Crystallization Questions

Before adding an async feature, ask:

- Is this generic for any long-running command template?
- Can it be represented as state files instead of a daemon?
- Does it preserve `template` plus boolean `parallel` as the only execution language?
- Does failure degrade into observable metadata instead of hidden retries?
- Can a registered tool own the policy instead of the runtime?

If implementing async primitives requires a scheduler, queue daemon, or custom DAG syntax, stop. The async extension should remain command-template execution with a small detached run envelope.
