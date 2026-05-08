# pi-auto-tools Job Adapter

## Goal

Describe how pi-auto-tools implements the [Template Job Standard](./template-jobs.md) without turning it into a workflow engine.

## Reading model

A template job is not another execution language. It is the detached runtime envelope around one command template.

```text
command template = what to run
template job     = where it is running, what happened, how to inspect or stop it
```

This is the core promise: keep execution declarative and small, but make long-running work observable after the initial tool call returns.

## Jobs, Tasks, and Templates

These words are intentionally separate:

- `Task`: The user's unit of work or intent, such as review a spec or generate eight shader pages.
- `Command template`: The execution graph that describes commands, sequences, and `mode: "parallel"` fanout.
- `Template job`: One detached runtime execution of a command template, with id, pid, state files, logs, status, tail, cancel, and terminal result.

A task may start zero, one, or many jobs. A job may run one command, a sequence, or a parallel fanout. A template can run in the foreground, but it has no durable lifecycle until it is wrapped in a job.

Use this rule of thumb:

```text
short call or sequence pipeline → template/tool
long-running, parallel, or agentic work → job(template)
reusable async scenario → tool → template → job → template
```

## Boundary

The portable synchronous command-template standard lives in [command-templates.md](./command-templates.md). The async template-job extension lives in [template-jobs.md](./template-jobs.md). This file is the pi-auto-tools adapter note: tool names, state-file paths, and Swarm mapping.

## Non-goals

- No general DAG language beyond `template` plus `mode`.
- No scheduler, queue, retry policy service, or distributed worker model.
- No hidden model policy in pi-auto-tools. Model choices stay in registered tool config.

## Current boundary

`mode: "parallel"` covers synchronous fanout. It is enough for compact Swarm-style reviewer fanout when the caller can wait for completion.

Async jobs need durable state because the first tool call returns before execution ends. That state cannot be represented by stdout piping alone.

## Minimal job shape

A job primitive should be a thin execution envelope around an existing command-template tree. The envelope fields name and locate the job; `template` remains the execution body:

```json
{
  "job": "{job}",
  "template": "review {scope}"
}
```

State location is optional. By default, pi-auto-tools writes state under `~/.pi/agent/tmp/pi-auto-tools/jobs/{job}`. Use `state_dir` only when overriding that default.

For parallel fanout, put command-template flags at the job top level instead of adding an unnecessary sequence wrapper:

```json
{
  "job": "{job}",
  "mode": "parallel",
  "template": ["review-a {scope}", "review-b {scope}"]
}
```

`template` remains last. Job fields are envelope flags; command-template flags keep their normal meaning.

Read the shape as: start this command-template tree, give the run a stable id, and write its state to the default or overridden inspectable location.

A job recipe must define `template` directly. It must not reference a registered auto-tool: a job is the async container for a template, not a tool-to-tool indirection layer.

A registered auto-tool can point at a job recipe by storing the recipe path/name in `template`. This is the preferred shape for heavyweight agent fanout when the recipe should live in the job library: keep the parallel template in the job file and expose only a small launch tool.

```json
{
  "shader_ring_job": {
    "description": "Start the shader ring job",
    "args": ["theme", "out_dir"],
    "template": "shader-ring-8-parallel.json"
  }
}
```

Calling this tool starts `~/.pi/agent/jobs/shader-ring-8-parallel.json` asynchronously and returns job metadata. The tool is the button, the job file is the source of truth, and the job's `template` is the execution graph.

A registered auto-tool may also co-locate the job envelope directly in `auto-tools.json`:

```json
{
  "review_docs": {
    "description": "Start an async docs review",
    "job": "review-docs",
    "template": "review {scope}"
  }
}
```

This is a storage variant of the same `tool → template → job → template` chain. The co-located entry must still own `template` directly and must not define `tool`.

## Template Job Library

Reusable template jobs can live in:

```text
~/.pi/agent/jobs/*.json
```

`template_job action=start` accepts `file`. Bare names resolve under that directory, so `file: "review-docs"` loads:

```text
~/.pi/agent/jobs/review-docs.json
```

Call-time params override file params. `values` are merged, with call-time values winning. If `job` is omitted, the file basename becomes the job id.

Keep reusable examples in docs or copy local recipes directly into `~/.pi/agent/jobs`. The release package does not ship root-level job files because local model names and tool names are operator-specific.

## State files

Use ordinary files under the extension temp directory so status tools stay simple and inspectable:

- `job.json` stores pid, command-template config, cwd, args, created time, and state dir.
- `progress.json` stores phase, active node path, completed node count, failures, and updated time.
- `events.jsonl` stores append-only lifecycle events.
- `stdout.log` and `stderr.log` store detached process output.
- `result.json` stores final code, killed flag, output selector, and optional full-output path.

## Temporary directory

Template job state follows the [extension temp directory](./template-jobs.md#extension-temp-directory) rule from the template-job standard.

For pi-auto-tools, template job state defaults to:

```text
~/.pi/agent/tmp/pi-auto-tools/jobs/
```

Job files use this shape:

```text
~/.pi/agent/tmp/pi-auto-tools/jobs/<job>/job.json
~/.pi/agent/tmp/pi-auto-tools/jobs/<job>/progress.json
~/.pi/agent/tmp/pi-auto-tools/jobs/<job>/events.jsonl
~/.pi/agent/tmp/pi-auto-tools/jobs/<job>/stdout.log
~/.pi/agent/tmp/pi-auto-tools/jobs/<job>/stderr.log
~/.pi/agent/tmp/pi-auto-tools/jobs/<job>/result.json
```

The extension prepares this directory on session start and removes stale entries according to the temp cleanup policy.

## Tool surface

The public adapter set is intentionally one tool. This mirrors `register_tool`: one management surface, explicit actions, small prompt footprint.

- `template_job action=start` starts a detached template job from `file` or inline `template`.
- A registered runtime tool may set `template` to a job recipe JSON path/name; calling it starts that job file and returns job metadata.
- A registered runtime tool may co-locate job envelope fields (`job`, optional `state_dir`, optional `values`) beside metadata when it also defines `template`; `job.tool` and job-only bindings remain invalid.
- `template_job action=status` reads structured state.
- `template_job action=tail` reads events or logs.
- `template_job action=list` lists known jobs.
- `template_job action=cancel` sends termination to the owned pid.

These are generic pi-auto-tools capabilities. Swarm can register local adapters that call them. The public surface stays small: one management tool with five actions.

## Ownership and safety

A job belongs to the current user and cwd at start time. Cancellation should only target the recorded pid when the command line and cwd still match the recorded owner data. Stale pid reuse must fail closed.

Job state is append-only where practical. Final result writes should be atomic.

## Usage sketch

```json
{
  "job": "review-docs",
  "template": [
    "prepare docs/spec.md",
    {
      "mode": "parallel",
      "template": ["review-a docs/spec.md", "review-b docs/spec.md"]
    },
    "merge docs/spec.md"
  ]
}
```

`template_job action=status` can then read `progress.json` and `result.json`, while `template_job action=tail` reads `events.jsonl` first and falls back to logs.

## Ambient observability

Interactive sessions expose compact sub-agent activity with minimal screen cost:

- Footer status is shown only while sub-agents are running.
- One `▷` is shown per active sub-agent.
- Triangles are separated by a single compact space for legibility.
- One `▶` moves across the triangles as a small wave.
- With one active sub-agent, the triangle blinks between `▶` and `▷`.
- The wave refreshes frequently enough to be visible during long sub-agent runs.
- Triangles disappear as concrete sub-agent processes exit.
- The status uses dim footer coloring, matching the quieter model/status tone.
- The status key sorts late among extension statuses; exact right alignment is controlled by pi core footer rendering.
- No prompt-area widget is shown by default.
- Terminal job transitions trigger a compact follow-up context event.
- Full logs remain in job state files and are still accessed through `template_job action=tail`.

This keeps long-running swarms visible without occupying the prompt area. Only terminal job events enter context, so the agent can inspect or react after completion without being flooded by routine progress updates.

## Swarm mapping

Swarm coordinator responsibilities split like this:

- Generic: start, pid tracking, status, tail, list, cancellation, stdout/stderr logs.
- Swarm-specific: lock semantics, quorum manifest shape, raw review retention, merger and post-merge semantics.
- Adapter config: model pool, default merger, default reviewer, prompt lens, tool allowlist, timeout.

This means pi-auto-tools can absorb generic job primitives, but Swarm should keep domain-specific quorum semantics unless they become reusable across multiple domains.

## Crystallization questions

Before adding a job feature, ask:

- Is this generic for any long-running command template?
- Can it be represented as state files instead of a daemon?
- Does it preserve `template` plus `mode` as the only execution language?
- Does failure degrade into observable metadata instead of hidden retries?
- Can a registered tool own the policy instead of the job runtime?

## Stop line

If implementing job primitives requires a scheduler, queue daemon, or custom DAG syntax, stop. The async extension should remain command-template execution with a small template job envelope.
