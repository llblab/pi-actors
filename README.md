# pi-actors

Local Run kernel and persistent tool registry for [Pi](https://github.com/badlogic/pi-mono).

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

An **actor** is any runnable local capability: a script, tool, service, pipeline, or subagent. A **Recipe** is its reusable executable definition. `spawn` creates a **Run**—one concrete actor instance—which captures its Recipe, appends observable **Trace**, and may consume actor-local **Control**.

## Install

```bash
pi install npm:@llblab/pi-actors
```

For local development:

```bash
pi install /path/to/pi-actors
```

The package contributes the extension, packaged Recipes, and the `actors` and `swarm` skills.

## Public Tools

### `spawn`

Create a Run from a packaged/local Recipe or an inline command template:

```text
spawn template="sleep 30" as=run:demo
spawn recipe=pipeline-repo-health values={"repo":"/work/project","model":"provider/model"}
spawn template="make test" as=run:test
```

Use a Run when work may outlive the current turn, needs steering, fans out, produces artifacts, or must remain inspectable. Short foreground commands can remain ordinary tools.

### `message`

Send one exact Control:

```json
{
  "target": "run:player",
  "action": "pause",
  "input": { "reason": "operator" },
  "verbose": false
}
```

Run targets accept only actions declared by the captured Recipe. Runtime targets accept only reserved review actions:

```text
message target=runtime action=review.retry input={"scope":"draft"}
message target=runtime action=review.retry input={"scope":"tool"}
message target=runtime action=review.reset input={"scope":"draft"}
message target=runtime action=review.reset input={"scope":"tool"}
```

Lifecycle `kill` remains runtime-owned rather than Recipe-declared.

### `inspect`

Inspect one exact management target:

```text
inspect target=run:test view=recipe
inspect target=run:test view=trace source=lifecycle lines=40
inspect target=run:test view=control
inspect target=runtime view=status
inspect target=recipes view=status
inspect target=tool:my_tool view=status
```

A Run exposes exactly `recipe`, `trace`, and `control` views.

### `register_tool`

Persist a trusted command template or Recipe-backed capability under `~/.pi/agent/recipes`. Registration remains separate from running Control.

## Recipe

Recipes can declare:

- args and typed defaults;
- imports and command-template composition;
- retry, failure, recovery, repeat, concurrency, and timeout policy;
- artifact paths;
- `control: ["action"]` only for inputs a service actually consumes.

Example controlled Recipe:

```json
{
  "async": true,
  "control": ["pause", "resume", "stop"],
  "artifacts": { "state": "{state_dir}/player-state.json" },
  "template": "{repo}/scripts/player.mjs --state-dir {state_dir}"
}
```

Ordinary one-shot Recipes should omit `control`. Recipe imports compose definitions inside one Run; they do not create peer actors.

String command-template leaves execute directly without shell interpretation. Use template arrays for sequencing or an explicit trusted shell/script when shell semantics matter.

## Trace

`trace.jsonl` contains bounded structured observations:

```json
{
  "id": "cfd0…",
  "ts": "2026-01-01T00:00:00.000Z",
  "kind": "progress.update",
  "summary": "Indexed 40 files",
  "data": { "files": 40 },
  "level": "info",
  "attention": "notify"
}
```

Trace fields are exact: `id`, `ts`, `kind`, and optional `summary`, `data`, `level`, `attention`. Address, sender, recipient, reply, and routing fields fail validation. The canonical append authority validates and size-checks under a cross-process mutation lock before one append-only JSONL write; first-party scripts never append this file directly.

Use `attention: "notify"` for visible status and `attention: "followup"` only when the coordinator needs semantic follow-up context. Store large evidence in artifacts or bounded execution captures.

## Control

Controls persist to `controls.jsonl` before transport. Token-owned dead-process-reclaiming locks serialize atomic journal replacements. Every record carries the immutable `run_instance_id`; expected-status fencing advances outcomes monotonically through queued/delivered/claimed/handled/failed evidence, while a fast consumer may claim or handle before the sender adds independent delivery-time evidence.

Long-lived services publish `control-endpoint.json` only when ready:

```json
{
  "path": "/path/to/control.fifo",
  "type": "fifo",
  "ready_at": "2026-01-01T00:00:00.000Z",
  "run_instance_id": "generation-id"
}
```

Supported transports are Unix FIFO and Windows named pipe. Every actor-local Control uses the same portable envelope: action is at most 64 lowercase ASCII characters, serialized JSON input is at most 380 bytes, and the newline-terminated wire record is at most 512 bytes. Put larger data in a declared artifact/path and send only its bounded reference or instruction through Control. Delivery revalidates owner, generation, state, and process identity under the canonical lifecycle lock.

## Run State

Owned state lives under:

```text
~/.pi/agent/tmp/pi-actors/runs/<run>/
```

Core files:

- `run.json` — identity, owner, generation, captured Recipe, policy, process identity;
- `trace.jsonl` — structured observations;
- `controls.jsonl` — durable Controls and outcomes;
- `control-endpoint.json` — generation-fenced service readiness;
- `execution.json` — command/session provenance and complete-capture references;
- `result.json`, command logs, progress, and declared artifacts.

The runtime preserves owner filtering, process-identity verification, lifecycle locking, shutdown kill, terminal reconciliation, bounded captures, owned Pi sessions, path containment, and redaction.

## Actor Inspector

Open the owner-filtered TUI:

```text
/actor-inspector
```

It presents actor instances through Recipe, Trace, and Control tabs, with source filtering, detail navigation, refresh, and generation-fenced Run kill.

## Packaged Recipes

Useful entry points include:

- `pipeline-repo-health`
- `pipeline-quorum-review`
- `pipeline-artifact-bundle`
- `music-player` — controlled playback service
- `resource-locker` — optional controlled resource-lock service

Validate Recipes with:

```bash
npm run recipes:qa
```

## Development

```bash
npm install
npm run build
npm test
npm run validate
npm run test:preservation
```

See the [documentation index](./docs/README.md), [Run lifecycle](./docs/async-runs.md), [Recipe library](./docs/recipe-library.md), and [0.43 baseline](./docs/0.43-baseline.md).

Project context: [AGENTS.md](./AGENTS.md) · [BACKLOG.md](./BACKLOG.md) · [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
