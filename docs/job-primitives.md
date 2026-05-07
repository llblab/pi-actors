# pi-auto-tools Job Adapter

## Goal

Describe how pi-auto-tools implements the [template job envelope](./command-templates.md#template-job-envelope) without turning it into a workflow engine.

## Reading model

A template job is not another execution language. It is the detached runtime envelope around one command template.

```text
command template = what to run
template job     = where it is running, what happened, how to inspect or stop it
```

This is the core promise: keep execution declarative and small, but make long-running work observable after the initial tool call returns.

## Boundary

The portable standard lives in [command-templates.md](./command-templates.md). This file is the pi-auto-tools adapter note: tool names, state-file paths, and Swarm mapping.

## Non-goals

- No general DAG language beyond `template` plus `mode`.
- No scheduler, queue, retry policy service, or distributed worker model.
- No hidden model policy in pi-auto-tools. Model choices stay in registered tool config.

## Current boundary

`mode: "parallel"` covers synchronous fanout. It is enough for compact Swarm-style reviewer fanout when the caller can wait for completion.

Async jobs need durable state because the first tool call returns before execution ends. That state cannot be represented by stdout piping alone.

## Minimal job shape

A job primitive should be a thin execution envelope around an existing command-template tree or registered tool. The envelope fields name and locate the job; `template` remains the execution body:

```json
{
  "job": "{job}",
  "state_dir": "~/.pi/agent/tmp/pi-auto-tools/jobs/{job}",
  "template": [
    "prepare {scope}",
    {
      "mode": "parallel",
      "template": ["review-a {scope}", "review-b {scope}"]
    },
    "merge {scope}"
  ]
}
```

`template` remains last. Job fields are envelope flags.

Read the shape as: start this command-template tree, give the run a stable id, and write its state somewhere inspectable.

A job can also reference a registered auto-tool instead of repeating its template:

```json
{
  "job": "review-docs",
  "tool": "swarm_compose_review",
  "values": {
    "prompt": "Review risks and contradictions.",
    "scope": "docs/spec.md"
  }
}
```

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

Template job state follows the [extension temp directory](./command-templates.md#extension-temp-directory) rule from the command-template standard.

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

- `template_job action=start` starts a detached template job from `file`, `template`, or `tool`.
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

If implementing job primitives requires a scheduler, queue daemon, or custom DAG syntax, stop. The standard should remain command-template execution with a small template job envelope.
