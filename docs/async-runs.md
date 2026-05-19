# Async Run Standard

Async runs are detached executions of a template recipe or inline command template.

**Meta-contract:** the command template is still the execution graph; the async run is only a lifecycle envelope with state, logs, script-authored events, status, cancellation, and coordinator-scoped observability.

**Scope:** run id, state path, runner pid, process-group cancellation, logs, status, tail, list, script-authored event outbox, line-message send to a run-local Unix FIFO, cancel, force-kill, terminal result state, ambient activity indicators, and extension-owned temp storage. No scheduler, queue daemon, workflow DSL, distributed worker, or second execution language.

Layer boundary: async-run configuration may inject lifecycle values such as `{run_id}` and `{state_dir}` and may choose detached execution through `async: true`, but it does not add command-template graph syntax. Recipe imports and recipe-local references belong to the template-recipe layer; status, send, events, cancel, and kill belong to the async-run layer.

---

## Layer Ownership

Async-run standard owns:

- Detached process lifecycle for one execution instance.
- Run identity, state directory, pid/process-group tracking, logs, status, list, tail, events, send, cancel, and kill.
- Injected lifecycle values such as `{run_id}` and `{state_dir}`.
- Coordinator-scoped observability and script-authored actor messages.

Async-run standard does not own:

- Command-template syntax, placeholders, graph semantics, or branch policy.
- Recipe import resolution, recipe names, or recipe storage format.
- Domain semantics for subagents, swarms, release readiness, media playback, or project policy.
- Scheduling, queue daemons, distributed workers, or workflow DSLs.

## Reading Model

```text
recipe       = saved JSON definition
run          = one execution instance
lifecycle    = state/logs/events/status/send/cancel/kill envelope
state dir    = ordinary files for status/logs/events/result
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
  "name": "music-player",
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

Use `run_id` on async recipe tools or `as: "run:<id>"` on `spawn` when the caller wants a stable id for later inspection or control. Recipe `name` identifies the saved definition; the run id identifies one execution instance of that recipe. Async runs inject `{run_id}` and `{state_dir}` into template values so scripts can write run-local status files or control endpoints.

## State Files

Use ordinary files under the extension temp directory so status tools stay simple and inspectable:

- `run.json`: pid, optional source metadata (`tool`, `recipe`, `recipe_file`), command-template config, cwd, coordinator owner id, values, named `artifacts`, mailbox metadata, created time, and state dir.
- `progress.json`: phase, active command count, completed count, failures, and updated time.
- `events.jsonl`: append-only lifecycle events.
- `outbox.jsonl`: optional script-authored JSONL actor-message events for coordinator inspection, notifications, or follow-up context. Coordinator follow-ups preserve bounded `body` previews plus message metadata for decision points.
- `stdout.log` and `stderr.log`: detached process output.
- `result.json`: final code, killed flag, output selector, and optional full-output path.

For pi-actors, actor run state defaults to:

```text
~/.pi/agent/tmp/pi-actors/runs/
```

State files use this shape:

```text
~/.pi/agent/tmp/pi-actors/runs/<run>/run.json
~/.pi/agent/tmp/pi-actors/runs/<run>/progress.json
~/.pi/agent/tmp/pi-actors/runs/<run>/events.jsonl
~/.pi/agent/tmp/pi-actors/runs/<run>/outbox.jsonl
~/.pi/agent/tmp/pi-actors/runs/<run>/stdout.log
~/.pi/agent/tmp/pi-actors/runs/<run>/stderr.log
~/.pi/agent/tmp/pi-actors/runs/<run>/result.json
```

Terminal status is `done` for result code 0 and `failed` for non-zero result code. A stopped run reports `cancelled` after graceful cancel or `killed` after force kill once the runner is no longer alive. If the runner process exits before writing a result and no stop event was recorded, status is `exited`.

## Reactive Coordinator Loop

Async runs are designed for event-driven coordination, not polling loops. A good coordinator starts long-lived or multi-agent work, lets completion and decision-point events bubble through `outbox.jsonl`, and sends corrective commands only when the run asks for input or the operator changes direction.

The core loop is:

1. Start an async recipe and keep the coordinator free:

   ```json
   { "recipe": "music-player.json", "as": "run:music" }
   ```

2. Let terminal events, `command.done`, and script-authored `followup` messages reach the launching coordinator automatically.

3. Respond with explicit run-local messages when needed:

   ```json
   { "to": "run:music", "type": "player.next", "body": "next" }
   ```

4. Do not inspect just because time passed. Inspect `status`, `tail`, or `events` only when a follow-up asks for inspection, a real decision depends on it, or a suspected stuck run needs diagnosis.

Addressed `message` calls and coordinator follow-ups are the paired control plane: run-to-coordinator actor messages flow upward, while coordinator-to-run actor messages flow downward. Recipe scripts own the message vocabulary (`next`, `pause`, `approve`, `revise`, `continue`, and so on); pi-actors owns the safe run-local transport, ownership checks, and coordinator attention policy.

## Tool Surface

The actor-level surface is:

- `spawn`: start a detached `run:<id>` actor from `file`, `recipe`, or inline `template`.
- `message`: send one typed envelope to `run:<id>`, `branch:<run>/<branch>`, `tool:<name>`, or `coordinator`.
- `inspect`: intentionally read `run:<id>` status, tail, events, artifacts, files, or mailbox metadata; read `session:<id>` or `session:all` run inventory with optional status filtering.

Low-level async actions map into the actor surface instead of forming a second public model:

- start → `spawn`
- send/control → `message`
- status/tail/events/list → `inspect`
- stop/kill → `message` with `control.stop` or `control.kill`, with synchronous results

Compact text is returned by default so async management does not flood agent context; use verbose inspection when the full state object is needed. List output intentionally shares one state root across music, subagents, timers, and other async work; source fields such as `tool` and `recipe` distinguish run purpose when the launcher recorded them. Registered tools are the preferred user-facing surface for reusable recipes.

## Run-Local Messages

`message` is the explicit coordinator-to-actor command channel. Use it when a running recipe exposes a control vocabulary, a branch needs parent-mediated control, a registered tool should be invoked as `tool:<name>`, or the coordinator needs to redirect work without killing or restarting it.

On Unix-like hosts, async runs may expose a control FIFO at:

```text
<state_dir>/control.fifo
```

When present, a caller can send a typed actor message:

```json
{
  "to": "run:music",
  "type": "player.next",
  "body": "next"
}
```

For `run:<id>`, `message` adapts the body to the FIFO command line. For `branch:<run>/<branch>`, it sends the full envelope through the parent run mailbox so the run can dispatch branch-local control. For `tool:<name>`, object bodies become the target tool parameters and primitive bodies are passed as `{ "input": body }`. The generic runtime records send events but does not interpret arbitrary run mailbox content. For example, a music player may accept `play`, `pause`, `next`, and `stop`, while a collaborative agent recipe may accept `continue`, `revise:<note>`, `approve`, or `abort`. Recipes may treat terminal control messages such as `stop` as synchronously handled so the later process exit does not generate a duplicate async follow-up.

Native Windows does not support this Unix FIFO contract. Use WSL/Linux/macOS for FIFO-controlled recipes, or let a Windows-specific recipe expose its own transport such as a Windows named pipe or localhost socket.

## Coordinator Notifications

The launching coordinator should not busy-poll long-running async runs. The extension watches run state directories and delivers terminal `done`/`failed`/unhandled `killed`/`exited` transitions plus script-authored `notify`/`followup` actor messages back to the owning session. This gives the top-level async task a completion signal on the happy path while still letting recipe-local messages bubble up when scripts need finer-grained notifications. Terminal follow-ups include recipe-level named `artifacts` when declared. The generic runner also emits compact `command.done` actor messages for completed leaf commands; recipe authors declare that capability in `mailbox.emits` rather than configuring a separate delivery policy. Failures and in-flight parallel branch completions can bubble as follow-ups, while successful final leaf completions stay diagnostic to avoid flooding long sequential pipelines. Branch-level `command.done` follow-ups omit artifact manifests because the top-level terminal follow-up carries them once. Intentional `control.stop`, `control.kill`, and recipe-local stop commands stay out of follow-up context because the initiating message already returns synchronously. If a follow-up asks for direction, answer with `message` rather than starting a polling loop. Use explicit `inspect` only when a delivered follow-up requests inspection, a real decision depends on state, or a suspected stuck run needs diagnosis — never merely because a timeout elapsed.

Ambient status indicators may refresh while work is active, but coordinator attention is event-driven from state-file changes rather than a coordinator agent loop. This lets the coordinator continue other work after `spawn`; the run signals back through `events.jsonl`, `result.json`, and `outbox.jsonl`. The ambient triangle count represents active async work units: each running async run contributes at least one triangle, and a run with multiple active parallel command/subagent branches contributes the reported active branch count. If a coordinator starts one parent run with four active parallel branches, four triangles are shown; if the same coordinator starts five independent single-branch runs, five triangles are shown.

## Run Actor Messages

A recipe or script may append coordinator-bound actor message records to:

```text
<state_dir>/outbox.jsonl
```

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

Use coordinator-bound messages for completion and decision points, not for every progress tick. Packaged multi-agent branch completion is a completion message and should bubble by default. Follow-up path lists use Markdown hierarchy: a section heading, `- Base: ...`, and `- Files: ...`, so repeated run-state prefixes do not flood agent context.

## Cancellation And Ownership

An async run belongs to the current user, cwd, and launching agent session at start time. Send, cancellation, and force-kill target only the recorded runner pid when command line and cwd still match the recorded owner data. Stale pid reuse must fail closed.

On Unix-like systems, cancel and kill signal the runner process group when available, then fall back to the runner pid. The runner starts command-template children in that process group, so long-running descendants such as audio players stop with the run instead of becoming orphaned background processes. After the process exits, status reflects the operator action as `cancelled` or `killed` instead of a generic `exited`.

State is append-only where practical. Final result writes should be atomic. Recipe-local control endpoints and actor-message logs may live in the state dir. pi-actors core owns only the generic Unix FIFO write action and runtime attention policy; command and message vocabularies belong to the recipe/script.

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

## Ambient Observability

Interactive sessions expose compact activity with minimal screen cost:

- Footer status is shown only while async runs launched by the current coordinator session are active.
- Each running async run contributes at least one `▷`; if the run reports multiple active command/sub-agent branches, those branches contribute additional triangles.
- One `▶` moves across the triangles as a small wave.
- With one active command, the triangle blinks between `▶` and `▷`.
- Triangles disappear as concrete commands exit.
- No prompt-area widget is shown by default.
- Terminal `done`/`failed`/unhandled `killed`/`exited` transitions trigger compact follow-up context only in the launching coordinator session; intentional `cancel`, `kill`, and `stop` actions stay out of agent context because the action already reports synchronously.
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
  "name": "collab-{run}",
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
- Use `inspect target=run:<id> view=status` or `view=tail` after terminal events.
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
