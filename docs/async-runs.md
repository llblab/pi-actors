# Async Run Standard

Async runs are detached executions of a template recipe or inline command template.

**Meta-contract:** the command template is still the execution graph; the async run is only a lifecycle envelope with state, logs, script-authored events, status, cancellation, and coordinator-scoped observability.

**Scope:** run id, state path, runner pid, process-group cancellation, logs, status, tail, list, script-authored event outbox, line-message send to a run-local Unix FIFO, cancel, force-kill, terminal result state, ambient activity indicators, and extension-owned temp storage. No scheduler, queue daemon, workflow DSL, distributed worker, or second execution language.

Layer boundary: async-run configuration may inject lifecycle values such as `{run_id}` and `{state_dir}` and may choose detached execution through `async: true`, but it does not add command-template graph syntax. Recipe imports and recipe-local references belong to the template-recipe layer; status, send, events, cancel, and kill belong to the async-run layer.

---

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
long or background work → async recipe or async_run start
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

A caller can also start any recipe or inline template explicitly through `async_run`:

```json
{
  "action": "start",
  "file": "music-player",
  "run_id": "music",
  "values": {
    "source": "~/Music"
  }
}
```

`async_run action=start` always starts a detached run. Registered recipe tools follow the recipe's `async` flag.

Use `run_id` on async recipe tools or the `async_run` action API when the caller wants a stable id for later status or cancellation. Recipe `name` identifies the saved definition; `run_id` identifies one execution instance of that recipe. Async runs inject `{run_id}` and `{state_dir}` into template values so scripts can write run-local status files or control endpoints.

## State Files

Use ordinary files under the extension temp directory so status tools stay simple and inspectable:

- `run.json`: pid, optional source metadata (`tool`, `recipe`, `recipe_file`), command-template config, cwd, coordinator owner id, values, created time, and state dir.
- `progress.json`: phase, active command count, completed count, failures, and updated time.
- `events.jsonl`: append-only lifecycle events.
- `outbox.jsonl`: optional script-authored JSONL events for coordinator inspection, notifications, or follow-up context.
- `stdout.log` and `stderr.log`: detached process output.
- `result.json`: final code, killed flag, output selector, and optional full-output path.

For pi-auto-tools, async run state defaults to:

```text
~/.pi/agent/tmp/pi-auto-tools/runs/
```

State files use this shape:

```text
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/run.json
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/progress.json
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/events.jsonl
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/outbox.jsonl
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/stdout.log
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/stderr.log
~/.pi/agent/tmp/pi-auto-tools/runs/<run>/result.json
```

Terminal status is `done` for result code 0 and `failed` for non-zero result code. A stopped run reports `cancelled` after graceful cancel or `killed` after force kill once the runner is no longer alive. If the runner process exits before writing a result and no stop event was recorded, status is `exited`.

## Tool Surface

The public async adapter remains one action tool:

- `async_run action=start`: start a detached run from `file` or inline `template`.
- `async_run action=status`: read compact run state; add `verbose: true` for full JSON.
- `async_run action=tail`: read recent lifecycle events or logs.
- `async_run action=list`: list known runs compactly; add `status: "running"`, `status: "terminal"`, or a concrete terminal status to filter; add `verbose: true` for full JSON.
- `async_run action=events`: read recent script-authored events from `<state_dir>/outbox.jsonl`.
- `async_run action=send`: write one newline-delimited `message` to a running recipe's Unix FIFO at `<state_dir>/control.fifo`.
- `async_run action=cancel`: send graceful termination to an owned run.
- `async_run action=kill`: force-kill a stuck owned run after the same ownership checks.

This mirrors `register_tool`: one management surface, explicit actions, and small prompt footprint. `start`, `status`, `list`, `events`, `send`, `cancel`, and `kill` return compact text by default so async management does not flood agent context; use `verbose: true` when the full state object is needed. List output intentionally shares one state root across music, subagents, timers, and other async work; source fields such as `tool` and `recipe` distinguish run purpose when the launcher recorded them. Registered tools are the preferred user-facing surface for reusable recipes.

## Run-Local Messages

On Unix-like hosts, async runs may expose a control FIFO at:

```text
<state_dir>/control.fifo
```

When present, a caller can send a script-owned command line:

```json
{
  "action": "send",
  "run_id": "music",
  "message": "next"
}
```

`async_run action=send` opens the FIFO in non-blocking mode, writes `message`, and appends a trailing newline when omitted. The generic runtime does not interpret the message. For example, a music player may accept `play`, `pause`, `next`, and `stop`, while a different recipe may define a different vocabulary or no vocabulary at all.

Native Windows does not support this Unix FIFO contract. Use WSL/Linux/macOS for FIFO-controlled recipes, or let a Windows-specific recipe expose its own transport such as a Windows named pipe or localhost socket.

## Run Outbox Events

A recipe or script may append JSONL events to:

```text
<state_dir>/outbox.jsonl
```

Shape:

```json
{
  "event": "player.track",
  "summary": "Now playing: track.flac",
  "level": "info",
  "delivery": "log",
  "ts": "2026-05-19T00:00:00.000Z",
  "data": { "track": "/Music/track.flac", "index": 3, "count": 42 }
}
```

`level` is `info`, `warning`, or `error`. `delivery` is `log`, `notify`, or `followup`:

- `log`: stored only; read explicitly with `async_run action=events`.
- `notify`: shown as a UI notification to the launching coordinator session.
- `followup`: notification plus compact follow-up context to the launching coordinator session.

Use `followup` sparingly. It is intended for events that should interrupt the coordinator's context, not for every progress tick.

## Cancellation And Ownership

An async run belongs to the current user, cwd, and launching agent session at start time. Send, cancellation, and force-kill target only the recorded runner pid when command line and cwd still match the recorded owner data. Stale pid reuse must fail closed.

On Unix-like systems, cancel and kill signal the runner process group when available, then fall back to the runner pid. The runner starts command-template children in that process group, so long-running descendants such as audio players stop with the run instead of becoming orphaned background processes. After the process exits, status reflects the operator action as `cancelled` or `killed` instead of a generic `exited`.

State is append-only where practical. Final result writes should be atomic. Recipe-local control endpoints and outbox events may live in the state dir. pi-auto-tools core owns only the generic Unix FIFO write action and the JSONL outbox delivery policy; command and event vocabularies belong to the recipe/script.

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
- State that must survive restarts belongs in the agent root, not in `tmp`.

## Ambient Observability

Interactive sessions expose compact activity with minimal screen cost:

- Footer status is shown only while async runs launched by the current coordinator session are active.
- Each running async run contributes at least one `▷`; if the run reports multiple active command/sub-agent branches, those branches contribute additional triangles.
- One `▶` moves across the triangles as a small wave.
- With one active command, the triangle blinks between `▶` and `▷`.
- Triangles disappear as concrete commands exit.
- No prompt-area widget is shown by default.
- Terminal run transitions trigger compact follow-up context only in the launching coordinator session when attention is needed; successful `done` and intentional `cancelled` transitions stay out of agent context.
- Full logs remain in state files and are accessed through `async_run action=tail`.

This keeps background work visible without blocking the agent, occupying the prompt area, or leaking async context into unrelated sessions.

## Swarm Mapping

Swarm coordinator responsibilities split like this:

- Generic async runtime: start, pid tracking, status, tail, list, cancellation, stdout, stderr, logs.
- Swarm semantics: lock rules, quorum manifest shape, raw review retention, merger, post-merge review, conflict policy.
- Adapter config: model pool, default merger, default reviewer, prompt lens, tool allowlist, timeout.

pi-auto-tools owns generic recipes and async run primitives. Swarm should keep domain-specific quorum and implementation-team semantics unless they become reusable across multiple domains.

## Collaborative Subagent Branch Adapter

A collaborative implementation swarm can use pi-auto-tools as the async runtime without making pi-auto-tools own swarm semantics. The coordinator prepares scope files and chooses branch names. A trusted local runner owns one branch lifecycle. The async run owns fanout, state, logs, status, tail, cancel, and terminal result metadata.

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
~/.pi/agent/tmp/pi-auto-tools/collab-runs/<run>/scopes/agent-01.md
```

Example recipe:

```json
{
  "name": "collab-{run}",
  "async": true,
  "mode": "parallel",
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

The runner is intentionally outside pi-auto-tools. It is a trusted local executable, like any other command-template target. Its minimum contract is clone or worktree, checkout branch, run subagent with bounded tools, verify expected branch, verify a commit exists, push branch, and emit a structured result. If one runner fails, `failure: "branch"` preserves sibling results as a degraded run.

Coordinator responsibilities stay outside the async runtime:

- Partition backlog tasks by stable task IDs and non-overlapping mutation zones.
- Write scope files before starting the run.
- Pass scope paths and branch names as values.
- Inspect `async_run action=status` and `async_run action=tail` after terminal events.
- Treat pushed branches as artifacts for review, not as automatic merges.
- Record failed scopes back into the backlog.

Do not encode backlog parsing, task assignment, pull-request policy, merge policy, or model selection into pi-auto-tools core. Those are swarm, project, or operator policy.

## Crystallization Questions

Before adding an async feature, ask:

- Is this generic for any long-running command template?
- Can it be represented as state files instead of a daemon?
- Does it preserve `template` plus `mode` as the only execution language?
- Does failure degrade into observable metadata instead of hidden retries?
- Can a registered tool own the policy instead of the runtime?

If implementing async primitives requires a scheduler, queue daemon, or custom DAG syntax, stop. The async extension should remain command-template execution with a small detached run envelope.
