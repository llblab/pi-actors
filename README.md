# pi-actors

![pi-actors banner](https://raw.githubusercontent.com/llblab/pi-actors/main/banner.jpg)

Local Run kernel and persistent tool registry for [Pi](https://github.com/earendil-works/pi).

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

The package contributes the extension and six capability-owning Skills for actors, artifacts, media, project work, Recipe memory, and swarm orchestration.

## Public Tools

### `spawn`

Create a Run from an active-Skill Recipe, an explicit Recipe file, or an inline command template:

```text
spawn template="sleep 30" as=run:demo
spawn recipe=project-work/repo-health values={"repo":"/work/project","model":"provider/model"}
spawn recipe=media/player values={"source":"/music"} as=run:player
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

- named typed args, inline fallbacks, configuration `defaults`, and composition `values`;
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
  "template": "{skill_dir}/scripts/player.mjs --state-dir {state_dir}"
}
```

Ordinary one-shot Recipes should omit `control`. Recipe imports compose definitions inside one Run; they do not create peer actors.

```json
{
  "imports": {
    "report": "artifacts/report",
    "review": "swarm/quorum-review"
  },
  "template": [{ "name": "report" }, { "name": "review" }]
}
```

Skill Recipe identity is `<active Skill name>/<Recipe filename stem>`. Recipe files have no top-level `name`; the filename is identity. `SKILL.md` `name` remains Pi host metadata and matches the Skill directory—pi-actors adds no second Skill identity field.

References have two classes: exact active-Skill identities such as `project-work/repo-health`, and explicit `.json` / `.md` paths. Entry file paths resolve from invocation `cwd`; relative imports resolve from the importing Recipe's directory; absolute paths remain exact. File-backed Recipes receive immutable `{recipe_dir}` and Skill Recipes also receive `{skill_dir}`. Skill components never become tools automatically.

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

Trace fields are exact: `id`, `ts`, `kind`, and optional `summary`, `data`, `level`, `attention`. Address, sender, recipient, reply, and routing fields fail validation. Trace is a bounded retained suffix, not an audit archive: the canonical authority appends within 2,048 events and 4 MiB or atomically keeps the newest suffix plus one warning-only `runtime.trace_compacted` marker. That marker means older history was discarded; `result.json`, `execution.json`, terminal state, and declared artifacts retain their own authority. `inspect view=trace` reports whether retained history is complete. Reads are newline-safe and deterministic; first-party scripts never write this file directly.

Attention is a live wake hint, not a durable queue: persist recovery state or an artifact first. Use `attention: "notify"` for visible status and `attention: "followup"` only when the coordinator needs semantic follow-up context; compaction may discard older hints. Store large evidence in artifacts or bounded execution captures.

## Control

Controls persist to `controls.jsonl` before transport. One token-owned lock rejects a 65th pending Control or 1 MiB rewrite before admission, fails closed on malformed or stale-generation evidence, and atomically admits one record. Canonical transitions retain a 128-terminal tail, expected-state fencing, and 4 KiB errors. Admitted nonterminal Controls never expire automatically. Every record carries immutable `run_instance_id`. `inspect view=control` reports pending capacity, saturation, stale work, journal bytes, and bounded diagnostics. If a stuck Run is saturated, use runtime-owned `kill`; it bypasses actor-local capacity and creates no synthetic Control.

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

The runtime preserves owner filtering, process-identity verification, lifecycle locking, shutdown kill independent of actor-local Control capacity, terminal reconciliation, bounded captures, owned Pi sessions, path containment, and redaction. Trace/Control quotas do not constrain user-declared artifacts, repositories, media sources, complete captures, or actor-owned workload state. Restart clears generation-local Trace, Control, endpoint, execution, and terminal evidence; archive preserves the bounded tree, while prune preserves only requested artifacts.

## Actor Inspector

Open the owner-filtered TUI:

```text
/actor-inspector
```

It presents actor instances through Recipe, Trace, and Control tabs, with source filtering, detail navigation, refresh, and generation-fenced Run kill.

## Skill Recipes

Useful entry points include:

- `project-work/repo-health`
- `project-work/release-readiness`
- `swarm/quorum-review`
- `artifacts/bundle`
- `media/player` — controlled playback service
- `actors/resource-locker` — optional controlled resource-lock service

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

See the [documentation index](./docs/README.md), [Run lifecycle](./docs/async-runs.md), and [Recipe library](./docs/recipe-library.md).

Project context: [AGENTS.md](./AGENTS.md) · [BACKLOG.md](./BACKLOG.md) · [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
