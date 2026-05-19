# Recipe Library

The root `recipes/` directory is the packaged standard actor recipe library for pi-actors. These recipes are reusable building blocks, not automatically installed operator policy. Copy or reference them from local tool registrations when the operator wants a durable callable tool.

Helper scripts that belong to library recipes live in root `scripts/`. The music player standard uses the executable Node.js wrapper only: `scripts/music-player.mjs`.

## Layout

- `recipes/subagent-*.json`: Atomic subagent components such as prompt launchers, reviewers, critics, planners, verifiers, mergers, checkpoints, follow-ups, judges, and normalizers.
- `recipes/pipeline-*.json`: Higher-level composed recipes built from component imports.
- `recipes/music-player.json`: Async local music player recipe backed by `scripts/music-player.mjs`.
- `recipes/utility-*.json`: Small operator utility recipes that are not subagent coordinators.

## Install Locally

Recipes can be copied into the user recipe root:

```bash
mkdir -p ~/.pi/agent/recipes
cp <repo>/recipes/*.json ~/.pi/agent/recipes/
```

Or a registered tool can point directly at a recipe path when that is more convenient.

## Async Subagent Components

Core subagent recipes:

- `recipes/subagent-prompt.json`: Start one prompt-driven subagent.
- `recipes/subagent-tools.json`: Start a subagent with an explicit tool allowlist.
- `recipes/subagents-prompts.json`: Run prompt fanout with one imported subagent component.
- `recipes/subagent-review.json`: Evidence-grounded review lens.
- `recipes/subagent-critic.json`: Assumption and failure-mode critique.
- `recipes/subagent-plan.json`: Bounded plan slices and validation gates.
- `recipes/subagent-evidence-map.json`: Evidence and confidence map.
- `recipes/subagent-contradiction-map.json`: Contradiction and missing-evidence map.
- `recipes/subagent-verify.json`: Claim verification.
- `recipes/subagent-merge.json`: Consensus/risk-first synthesis.
- `recipes/subagent-normalize.json`: Stable output shaping.
- `recipes/subagent-artifact.json`: Durable artifact-shaped output for a target path. It prepares content and write guidance; it does not write files unless the caller deliberately grants write tools or uses a deterministic writer.
- `recipes/subagent-message.json`: Prompted actor-message-envelope-shaped coordinator message record with envelope-aligned args.
- `recipes/subagent-quorum.json`: Same prompt across a model pool.
- `recipes/subagent-task-card.json`: Bounded implementation task card.
- `recipes/subagent-conflict-report.json`: Integrator-oriented conflict report.
- `recipes/subagent-checkpoint.json`: Coordinator checkpoint artifact.
- `recipes/subagent-followup.json`: Same-context or degraded continuation.
- `recipes/subagent-judge.json`: Post-merge/report quality judge.

Most atoms expose policy knobs such as `model`, `thinking`, `tools`, `output_format`, `evidence_policy`, `risk_policy`, source policy, continuity policy, handoff format, or model pools. Interactive async atoms also declare mailbox metadata for their basic control, completion, and domain-result message surface. Higher-level recipes pass these knobs through instead of hard-coding local policy.

Register one atom:

```text
register_tool name=subagent_prompt \
  description="Start an async no-tools pi subagent" \
  template="subagent-prompt.json"
```

Start it:

```text
subagent_prompt prompt="Review docs/async-runs.md for unclear wording." run_id=docs-review
inspect target=run:docs-review view=status
inspect target=run:docs-review view=tail
```

## Composed Pipelines

Pipeline recipes demonstrate second-order composition:

- `recipes/subagent-review-coordinator.json`: Lens reviewers → verifier → merger → judge → normalizer.
- `recipes/pipeline-release-readiness.json`: Task-first release cell: changelog section → validation → release review → artifact report.
- `recipes/pipeline-repo-health.json`: Task-first repository-health cell: git status/log → docs index → validation → normalized artifact report.
- `recipes/pipeline-async-run-ops.json`: Task-first async-run operations cell: run summary → event tail → normalized operations report → artifact report.
- `recipes/pipeline-review-readiness.json`: Release/readiness gate over selected lenses.
- `recipes/pipeline-quorum-review.json`: Quorum vote shape → merge → judge → normalize.
- `recipes/pipeline-architect-coordinator.json`: Architecture lens fanout → critique → verification → synthesis → next slice.
- `recipes/pipeline-research-synthesis.json`: Plan → evidence map → contradiction map → verification → synthesis.
- `recipes/pipeline-checkpoint-continuation.json`: Checkpoint → follow-up → normalized handoff.
- `recipes/pipeline-development-tasking.json`: Plan → task card → critique → integrator handoff.
- `recipes/pipeline-docs-maintenance.json`: Docs index → documentation review → maintenance plan → artifact report.
- `recipes/pipeline-media-library.json`: Playlist build → media-library artifact report.
- `recipes/pipeline-artifact-report.json`: Normalize → artifact-shaped output → actor-message-shaped record. This pipeline prepares a candidate artifact and emits `artifact.prepared`/`artifact.blocked`; the `artifact_path` is a target path, not a guarantee that the file was written.
- `recipes/pipeline-artifact-write.json`: Normalize → artifact-shaped output → deterministic artifact write → actor-message-shaped record. Use only when the caller explicitly wants filesystem writes; `write_mode` is `create`, `overwrite`, or `append`.
- `recipes/pipeline-artifact-bundle.json`: Optional validation → deterministic artifact write → machine-readable manifest generation → deterministic manifest write → actor-message-shaped record. Use when the caller explicitly wants a filesystem handoff bundle with both artifact and manifest paths.

These are examples of library composition, not a workflow DSL. Pipeline recipes declare mailbox metadata for their high-level completion, artifact, and control message surface. The recipe layer owns imports and saved defaults; command templates own execution shape; async runs own lifecycle.

## Utility Recipes

Utility recipes cover local operator workflows that do not need subagents:

- `recipes/utility-markdown-index.json`: List Markdown files in a directory as input for README/docs index maintenance.
- `recipes/utility-jsonl-tail.json`: Tail a JSONL/event log with a configurable line count.
- `recipes/utility-validation-wrapper.json`: Run a caller-supplied validation command in a scoped directory with a bounded timeout.
- `recipes/utility-git-status.json`: Read concise branch/worktree state for a repo.
- `recipes/utility-git-log.json`: Read recent decorated commit history for a repo.
- `recipes/utility-run-state-files.json`: List run-state files such as `run.json` under an async run state root.
- `recipes/utility-changelog-head.json`: Read the top slice of a changelog for release summary prep.
- `recipes/utility-playlist-scan.json`: List local media files as playlist-building input.
- `recipes/utility-run-summary.json`: Use `scripts/recipe-utils.mjs` to summarize async run state files as JSON.
- `recipes/utility-playlist-build.json`: Use `scripts/recipe-utils.mjs` to build a filtered playlist listing as newline paths, M3U, or inline `|`-separated source.
- `recipes/utility-changelog-section.json`: Use `scripts/recipe-utils.mjs` to extract one changelog release section.
- `recipes/utility-artifact-manifest.json`: Use `scripts/recipe-utils.mjs` to emit a machine-readable JSON manifest for an artifact path.
- `recipes/utility-artifact-write.json`: Deterministically write prepared artifact content from stdin to `artifact_path` with explicit `create`, `overwrite`, or `append` mode.
- `recipes/utility-actor-message.json`: Deterministically wrap stdin as a validated addressed actor-message envelope with the same public names as the envelope: `to`, `from`, `type`, `summary`, `body`, optional `correlation_id`/`reply_to`, and `metadata`.
- `recipes/utility-package-summary.json`: Use `scripts/recipe-utils.mjs` to emit bounded package metadata such as name, version, files, scripts, and dependency counts.
- `recipes/utility-validate-recipe.json`: Use `scripts/validate-recipe.mjs` to validate one template recipe file, or all packaged recipes in a directory with `all: true`.

These recipes are intentionally small. Register them only for trusted local commands and prefer narrow scopes. The helper-backed utilities share `scripts/recipe-utils.mjs` so repeated parsing/listing logic stays out of recipe strings.

## Music Player

Files:

- `recipes/music-player.json`
- `scripts/music-player.mjs`

Purpose: start a local or URL audio source as an async run so the agent can continue working while playback runs in the background. The running script exposes one run-local mailbox/FIFO, so addressed `message` calls can control playback without a second recipe.

Requirements: Linux, macOS, or WSL with `mkfifo`, Node.js, and one of `mpv`, `ffplay`, `cvlc`, or SoX `play`. Native Windows is not supported because the wrapper uses a Unix FIFO and Unix signals.

The required `source` arg accepts:

- A single local file or URL.
- A directory containing audio files; the wrapper scans `.mp3`, `.ogg`, `.wav`, `.flac`, and `.m4a` files.
- An `.m3u`, `.m3u8`, or `.txt` playlist file.
- A `|`-separated inline list of local files or URLs.

Install locally:

```bash
mkdir -p ~/.pi/agent/recipes
cp <repo>/recipes/music-player.json ~/.pi/agent/recipes/music-player.json
```

Register playback:

```text
register_tool name=music_player \
  description="Start async music player playback through the Node.js wrapper" \
  template="music-player.json" \
  args="source:string,loop:bool=true,volume:int=70,player:enum(auto,mpv,ffplay,cvlc,play)=auto"
```

Start playback:

```text
music_player source="~/Music" volume=55 run_id=music
```

Control it through addressed actor messages. This is the canonical reactive pattern for long-lived recipes: the run emits actor messages upward, and the coordinator sends explicit commands downward instead of polling on a timer.

```text
message to=run:music type=player.pause body=pause
message to=run:music type=player.play body=play
message to=run:music type=player.next body=next
message to=run:music type=player.previous body=previous
message to=run:music type=player.stop body=stop
```

Use `inspect target=run:music view=status` only when an event or operator decision requires inspection.

The wrapper also accepts control commands directly when a caller already has the run state dir:

```text
scripts/music-player.mjs next ~/.pi/agent/tmp/pi-actors/runs/music
```

Message body is currently adapted to one newline-delimited command written to `<run state dir>/control.fifo`. The script writes `status.txt`, `player.json`, and track-change actor messages in `outbox.jsonl` in the same state dir. Track-change messages stay diagnostic by default; interactive recipes should define a small command vocabulary for addressed messages, emit semantic actor messages for decision points, and let the coordinator react to messages rather than sleep-polling state.

## Safety Notes

- Only play trusted local files or URLs.
- Volume is clamped to `0..100` by the wrapper.
- Prefer a stable `run_id` such as `music` when the operator expects to control the run by name.
- Use `message type=control.kill` only when graceful `control.stop` cancellation fails.
