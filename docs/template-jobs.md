# Template Job Standard

Template jobs are the portable async extension around the synchronous [Command Template Standard](./command-templates.md).

**Meta-contract:** command templates remain the execution language; template jobs add only lifecycle, state, and inspection.

**Scope:** detached command-template execution envelope — job id, state path, pid metadata, logs, status, tail, list, cancel, result state, and extension-owned temp storage. No scheduler, queue, daemon, workflow DSL, distributed worker, or second execution language.

---

## Relationship to Command Templates

```text
command template = what to run synchronously
 template job    = run it detached, remember it, inspect it later
```

A template job wraps one command-template tree. The wrapped `template` remains a normal command template: argv, placeholders, sequence, `mode: "parallel"`, delay, retry, critical steps, and output selection all come from the command-template standard.

The job owns only lifecycle:

- Start a detached execution
- Name and locate the run
- Record pid and owner metadata
- Store progress, events, stdout, stderr, and final result
- Report status, tail logs, list jobs, and cancel safely

## Minimal Shape

```json
{
  "job": "review-docs",
  "template": "review docs/spec.md"
}
```

`job` names the run. `template` is the command-template tree. State location is optional; adapters should default to their extension temp tree, for example `~/.pi/agent/tmp/pi-auto-tools/jobs/{job}`.

Top-level command-template node flags may sit beside `job` so a job file can be a command-template object with an async envelope:

```json
{
  "job": "review-docs",
  "mode": "parallel",
  "template": [
    "review-a docs/spec.md",
    "review-b docs/spec.md"
  ]
}
```

Use explicit `state_dir` only to override the default state location:

```json
{
  "job": "review-docs",
  "state_dir": "/custom/state/review-docs",
  "template": "review docs/spec.md"
}
```

`template` remains last. Job fields are envelope flags; command-template flags (`mode`, `timeout`, `retry`, `critical`, `delay`, `args`, `defaults`, etc.) keep their normal meaning.

Read the shape as: start this command-template tree, give the run a stable id, and write its state to the default or overridden inspectable location.

## Valid Graph

The valid chain is:

```text
tool → template → job → template
```

A job recipe must define `template` directly. A job must not reference a registered local tool: the job is the async container for the command-template tree, not a tool indirection layer.

The job may live in a recipe file or be co-located inside a registered tool entry with metadata such as `description` and `args`, as long as the job still owns `template` directly.

## Recipe Files

Reusable template job files may live under the agent directory:

```text
~/.pi/agent/jobs/*.json
```

A local `file` adapter can load one of these JSON objects and let call-time params override file params. `file` is an adapter convenience, not a replacement for the command-template contract.

## State Files

Use ordinary files under the extension temp directory so status tools stay simple and inspectable:

- `job.json` stores pid, command-template config, cwd, values, created time, and state dir.
- `progress.json` stores phase, active node path, completed node count, failures, and updated time.
- `events.jsonl` stores append-only lifecycle events.
- `stdout.log` and `stderr.log` store detached process output.
- `result.json` stores final code, killed flag, output selector, and optional full-output path.

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

Generic shape:

```text
~/.pi/agent/tmp/<extension-name>/<runtime-domain>/<artifact>
```

Template-job state should live under this temp tree. Local adapters define their own subpaths.

## Ownership and Safety

A job belongs to the current user and cwd at start time. Cancellation should only target the recorded pid when command line and cwd still match the recorded owner data. Stale pid reuse must fail closed.

Job state is append-only where practical. Final result writes should be atomic.

## Compatibility

Template jobs are an async extension. Consumers that only implement command templates should not need job support to remain compatible with the synchronous command-template standard.
