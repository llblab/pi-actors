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

Most atoms expose policy knobs such as `model`, `thinking`, `tools`, `output_format`, `evidence_policy`, `risk_policy`, source policy, continuity policy, handoff format, or model pools. Packaged recipes intentionally do not ship concrete model-version defaults: callers must pass current model policy at launch, which keeps reusable recipe components from aging around old provider aliases. The generic prompt launchers, including `subagent-tools` and `subagents-prompts`, expose the same core model/thinking/tool/output knobs so callers do not need separate recipe families for policy tuning. Interactive async atoms also declare mailbox metadata for their basic control, completion, and domain-result message surface. Higher-level recipes pass these knobs through instead of hard-coding local policy.

For one-off packaged subagent reviews, launch the recipe directly with `spawn file="subagent-review" values={...}` or `spawn file="pipeline-review-readiness" values={...}`. Do not copy the underlying `pi -p` command or wrap the recipe unless you are creating a durable operator tool with a narrower interface.

For build-oriented swarms, prefer a consensus-first shape over parallel writers: proposer roles coordinate in a room with message/inspect tools, a named implementer owns the first artifact write, a QA reviewer inspects the result, and a finalizer applies review-grounded fixes before `run.done`. This pattern keeps creative/lens diversity while preserving one coherent artifact and gives recipes concrete artifact assertions instead of treating room discussion as success.

Register one atom:

```text
register_tool name=subagent_prompt \
  description="Start an async no-tools pi subagent" \
  template="subagent-prompt.json"
```

Start it:

```text
subagent_prompt prompt="Review docs/async-runs.md for unclear wording." run_id=docs_review
inspect target=run:docs_review view=status
inspect target=run:docs_review view=tail
```

## Composed Pipelines

Pipeline recipes demonstrate second-order composition:

- `recipes/coordinator-locker.json`: Long-lived coordinator cell with queue, acquire/renew/release lease locks, journal, actor messages for worker coordination, and platform-adapted control metadata.
- `recipes/subagent-review-coordinator.json`: Lens reviewers → verifier → merger → judge → normalizer.
- `recipes/pipeline-release-readiness.json`: Task-first release cell: changelog section → package summary → packaged skill summary → validation → release review → artifact report.
- `recipes/pipeline-release-summary.json`: Evidence-only release summary cell: changelog section → package summary → packaged skill summary → validation → release summary / risks / PR body draft artifact. It does not commit, open a PR, merge, tag, publish, or perform external release side effects.
- `recipes/pipeline-repo-health.json`: Task-first repository-health cell: git status/log → docs index → validation → normalized artifact report.
- `recipes/pipeline-async-run-ops.json`: Task-first async-run operations cell: run summary → actor-message tail → normalized operations report → artifact report.
- `recipes/pipeline-review-readiness.json`: Release/readiness gate over selected lenses.
- `recipes/pipeline-quorum-review.json`: Quorum vote shape → merge → judge → normalize.
- `recipes/pipeline-architect-coordinator.json`: Architecture lens fanout → critique → verification → synthesis → next slice.
- `recipes/pipeline-research-synthesis.json`: Plan → evidence map → contradiction map → verification → synthesis.
- `recipes/pipeline-checkpoint-continuation.json`: Checkpoint → follow-up → normalized handoff.
- `recipes/pipeline-development-tasking.json`: Plan → task card → critique → integrator handoff.
- `recipes/pipeline-docs-maintenance.json`: Docs index → documentation review → maintenance plan → artifact report.
- `recipes/pipeline-media-library.json`: Playlist build → media-library artifact report.
- `recipes/pipeline-room-swarm.json`: Room participants join `room:<run>`, coordinate over repeated room-visible rounds, leave cleanly, and synthesize the room transcript into a caller-provided artifact path. Supported coordinator modes are `consensus`, `pipeline`, `fanout`, and `pool`; unknown modes fail closed instead of silently running consensus. Keep model/thinking/mission policy caller-owned. Custom roles can be supplied with `roles_path` as a JSON array of `{ "name", "persona" }` objects; `name` stays ASCII-safe for `branch:<run>/<name>` addresses and debugger output remains plain and name-driven. The packaged swarm uses contacts for peer awareness but does not rely on direct branch delivery unless a caller-specific worker protocol consumes branch envelopes. Set `subagent_ttl_ms` to a positive millisecond budget when participant `pi -p` processes must be killed instead of awaited indefinitely. Set `locker=true` to compose a local `coordinator-locker` cell under `{state_dir}/locker` for artifact ownership, resource lease locks, and a decision journal without merging locker policy into the room-participant script.
- `recipes/pipeline-artifact-report.json`: Normalize → artifact-shaped output → actor-message-shaped record. This pipeline prepares a candidate artifact and emits `artifact.prepared`/`artifact.blocked`; the `artifact_path` is a target path, not a guarantee that the file was written.
- `recipes/pipeline-artifact-write.json`: Normalize → artifact-shaped output → deterministic artifact write → actor-message-shaped record. Use only when the caller explicitly wants filesystem writes; `write_mode` is `create`, `overwrite`, or `append`.
- `recipes/pipeline-artifact-bundle.json`: Optional validation → deterministic artifact write → machine-readable manifest generation → deterministic manifest write → actor-message-shaped record. Use when the caller explicitly wants a filesystem handoff bundle with both artifact and manifest paths.

These are examples of library composition, not a workflow DSL. Pipeline recipes declare mailbox metadata for their high-level completion, artifact, and control message surface. The recipe layer owns imports and saved defaults; command templates own execution shape; async runs own lifecycle.

## Utility Recipes

Utility recipes cover local operator workflows that do not need subagents:

- `recipes/utility-markdown-index.json`: List Markdown files in a directory as input for README/docs index maintenance.
- `recipes/utility-jsonl-tail.json`: Tail a JSONL message/log file with a configurable line count.
- `recipes/utility-validation-wrapper.json`: Run a caller-supplied validation command in a scoped directory with a bounded timeout. This intentionally crosses a trusted shell boundary; discovery surfaces it as a diagnostic, and callers should pass explicit validation commands only.
- `recipes/utility-git-status.json`: Read concise branch/worktree state for a repo.
- `recipes/utility-git-log.json`: Read recent decorated commit history for a repo.
- `recipes/utility-run-state-files.json`: List run-state files such as `run.json` under an async run state root.
- `recipes/utility-coordinator-lock-snapshot.json`: Summarize a coordinator-locker actor state directory with queue depth, locks, and recent journal entries.
- `recipes/utility-changelog-head.json`: Read the top slice of a changelog for release summary prep.
- `recipes/utility-playlist-scan.json`: List local media files as playlist-building input.
- `recipes/utility-run-summary.json`: Use `scripts/recipe-utils.mjs` to summarize async run state files as JSON.
- `recipes/utility-run-ops-snapshot.json`: Combine async run summaries, recent actor messages for a selected `run_id`, and stale/terminal recommendations into one structured operations snapshot.
- `recipes/utility-playlist-build.json`: Use `scripts/recipe-utils.mjs` to build a filtered playlist listing as newline paths, M3U, or inline `|`-separated source.
- `recipes/utility-changelog-section.json`: Use `scripts/recipe-utils.mjs` to extract one changelog release section.
- `recipes/utility-artifact-manifest.json`: Use `scripts/recipe-utils.mjs` to emit a machine-readable JSON manifest for an artifact path.
- `recipes/utility-artifact-write.json`: Deterministically write prepared artifact content from stdin to `artifact_path` with explicit `create`, `overwrite`, or `append` mode.
- `recipes/utility-actor-message.json`: Deterministically wrap stdin as a validated addressed actor-message envelope with the same public names as the envelope: `to`, `from`, `type`, `summary`, `body`, optional `correlation_id`/`reply_to`, and `metadata`.
- `recipes/utility-package-summary.json`: Use `scripts/recipe-utils.mjs` to emit bounded package metadata such as name, version, files, scripts, and dependency counts.
- `recipes/utility-skill-summary.json`: Use `scripts/recipe-utils.mjs` to summarize packaged skill frontmatter, body shape, formatter-safe scalar lines, and package-version alignment.
- `recipes/utility-validate-recipe.json`: Use `scripts/validate-recipe.mjs` to validate one template recipe file, or all packaged recipes in a directory with `all: true`.

Packaged QA is available through the `recipes:qa` npm script. It reports description warnings and fails exact diagnostics for async mailbox contracts, termination vocabulary, artifact paths, platform scope, helper script paths, and missing helper scripts.

These recipes are intentionally small. Register them only for trusted local commands and prefer narrow scopes. Discovery diagnostics flag obvious trust-boundary shapes such as shell/eval/destructive commands; those warnings are operator review aids, not a sandbox. The helper-backed utilities share `scripts/recipe-utils.mjs` so repeated parsing/listing logic stays out of recipe strings.

## Actor OS Smoke Matrix

The repeatable smoke surface is the normal validation suite:

```text
npm test
```

The scenario coverage is intentionally local-first and bounded: shared room coordination and roster snapshots (`rooms` / `tools` tests), direct branch delivery and claim/handle transitions (`tools` and coordinator tests), inspector navigation (`inspector` tests), recipe context injection (`recipes-context` / async-runs tests), recipe persistence suggestions (`observability` tests), and opt-in retirement candidate/execution smoke (`observability` / async-runs tests). These scenarios exercise public `spawn` / `message` / `inspect` behavior or the packaged script surfaces rather than relying on manual swarm demos.

## Music Player

Files:

- `recipes/music-player.json`
- `scripts/music-player.mjs`

Purpose: start a local or URL audio source as an async run so the agent can continue working while playback runs in the background. The running script exposes a run-local mailbox, so addressed `message` calls can control playback without a second recipe.

Requirements: Node.js and one playback backend. Supported backends are `mpv`, macOS `afplay`, `ffplay`, `cvlc`, SoX `play`, or `wmp` on native Windows through the legacy Windows Media Player COM control exposed by `powershell.exe`. The `wmp` backend validates `wmplayer.exe` under `Program Files/Windows Media Player` or `Program Files (x86)/Windows Media Player`; it does not target the newer UWP/Store Media Player. Playback format support depends on the selected player; the actor control path itself uses the portable mailbox/wake runtime layer.

The required `source` arg accepts:

- A single local file or URL.
- A directory containing audio files; the wrapper scans `.aac`, `.aif`, `.aiff`, `.flac`, `.m4a`, `.mp3`, `.ogg`, and `.wav` files.
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
  args="source:string,loop:bool=true,volume:int=70,player:enum(auto,mpv,afplay,ffplay,cvlc,play,wmp)=auto"
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

Use `inspect target=run:music view=status` only when an actor message or operator decision requires inspection.

The wrapper also accepts control commands directly when a caller already has the run state dir:

```text
scripts/music-player.mjs next ~/.pi/agent/tmp/pi-actors/runs/music
```

Message body is queued in the recipe's run-local mailbox and reconciled by the player loop. The loop treats `wake.jsonl` and `fs.watch` as advisory signals, then verifies the durable inbox signature before taking the inbox lock so unchanged mailboxes are not reread on every tick. Backend players stay inside the async run process group so `control.kill` terminates active playback with the run instead of leaving detached player children alive; player-local pause/resume/next/stop controls still signal the current backend pid or process group when available. The script writes `status.txt`, `player.json`, and track-change actor messages in the same state dir. Track-change messages stay diagnostic by default; interactive recipes should define a small command vocabulary for addressed messages, emit semantic actor messages for decision points, and let the coordinator react to messages rather than sleep-polling state.

Cross-platform smoke checklist:

- Linux: install one backend such as `mpv` or `ffplay`; start `music_player source="~/Music" run_id=music`, send `pause`, `play`, `next`, and `stop`, then inspect `run:music` status/mailbox.
- macOS: verify `player=auto` selects `afplay` when no preferred CLI backend is installed, then run the same addressed message controls.
- Native Windows: verify `player=wmp` detects `wmplayer.exe`, starts playback through Windows Media Player COM, handles `pause`/`play`/`next`/`previous`/`stop`, and leaves handled mailbox records visible through `inspect target=run:music view=mailbox`.
- All hosts: confirm missed wake resilience by checking that queued mailbox commands are eventually claimed without relying on a transport-specific endpoint.

## Safety Notes

- Only play trusted local files or URLs.
- Volume is clamped to `0..100` by the wrapper.
- Prefer a stable `run_id` such as `music` when the operator expects to control the run by name.
- Use `message type=control.kill` for runtime termination; `control.stop` is a player-domain pause/stop command, not a generic run-kill alias.
