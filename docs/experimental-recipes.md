# Experimental Recipes

Experimental recipes are shipped examples, not standards. They demonstrate how to package local long-running workflows as template recipes and registered tools.

Copy recipes into `~/.pi/agent/recipes/`, adjust local paths if needed, then register compact tools that point their `template` at the recipe files.

## Async Subagent

Files:

- `examples/recipes/subagent-prompt.json`
- `examples/recipes/subagent-tools.json`
- `examples/recipes/subagents-prompts.json` — async parent recipe composed from `subagent-prompt.json` imports.

Purpose: start a non-interactive pi subagent as an async run so the coordinator can continue working while the subagent runs in the background. The prompts fanout example shows the cherry-on-top composition pattern: one parent async recipe imports a reusable subagent recipe and runs one imported recipe node per supplied prompt in parallel as one run.

Requirements: the `pi` CLI must be available on `PATH`, and the chosen model must be configured for the local pi installation. `subagent-prompt.json` uses `--no-tools` by default to keep the minimal example safe and avoid recursive tool access. Use `subagent-tools.json` when the coordinator intentionally wants to pass a bounded tool allowlist.

Install locally:

```bash
mkdir -p ~/.pi/agent/recipes
cp <repo>/examples/recipes/subagent-prompt.json ~/.pi/agent/recipes/subagent-prompt.json
cp <repo>/examples/recipes/subagent-tools.json ~/.pi/agent/recipes/subagent-tools.json
cp <repo>/examples/recipes/subagents-prompts.json ~/.pi/agent/recipes/subagents-prompts.json
```

Register the no-tools variant:

```text
register_tool name=subagent_prompt \
  description="Start an async no-tools pi subagent" \
  template="subagent-prompt.json"
```

Register the explicit-tool variant:

```text
register_tool name=subagent_tools \
  description="Start an async pi subagent with an explicit tool allowlist" \
  template="subagent-tools.json"
```

Start a subagent with a stable run id:

```text
subagent_prompt prompt="Review docs/async-runs.md for unclear wording." run_id=docs-review
subagent_tools prompt="Inspect package metadata and report risks." tools="read,bash" run_id=package-review
```

Register and start the composed async parent recipe:

```text
register_tool name=subagents_prompts \
  description="Start parallel no-tools subagents from a prompt array as one async run" \
  template="subagents-prompts.json"

subagents_prompts \
  prompts='["Review README.md for unclear release-onboarding wording. Return concise findings.","Review docs/template-recipes.md for unclear recipe-import wording. Return concise findings."]' \
  run_id=review-prompts
```

`subagents-prompts.json` imports `subagent-prompt.json` as `subagent`, then repeats one `{ "name": "subagent" }` node once per prompt inside a parallel template. The imported recipe contributes command-template graph, args, defaults, and values; the parent recipe owns `async: true`, so the call creates one async run rather than nested runs. The concrete prompts are supplied as the public `prompts:array` tool input, `repeat` is derived from `{prompts.length}`, and each branch selects `{prompts[index]}` so agents parameterize subagent work at call time.

Inspect it later:

```text
async_run action=status run_id=docs-review
async_run action=tail run_id=docs-review
```

The no-tools recipe is intentionally small:

```json
{
  "name": "subagent-prompt",
  "async": true,
  "args": ["prompt:string", "model:string"],
  "defaults": { "model": "openai-codex/gpt-5.5" },
  "template": "pi -p --model {model} --no-tools {prompt}"
}
```

The explicit-tool variant makes the allowlist required instead of defaulting to broad access:

```json
{
  "name": "subagent-tools",
  "async": true,
  "args": ["prompt:string", "tools:string", "model:string"],
  "defaults": { "model": "openai-codex/gpt-5.5" },
  "template": "pi -p --model {model} --tools {tools} {prompt}"
}
```

The composed parent recipe is intentionally small:

```json
{
  "name": "subagents-prompts",
  "async": true,
  "imports": { "subagent": "subagent-prompt.json" },
  "args": ["prompts:array"],
  "repeat": "{prompts.length}",
  "mode": "parallel",
  "failure": "branch",
  "template": {
    "name": "subagent",
    "values": { "prompt": "{prompts[index]}" }
  }
}
```

Clone or edit these recipes when a project needs a different default model, tool allowlist, prompt source policy, or imported-recipe fanout shape.

## Music Player

Files:

- `examples/recipes/music-player-sh.json` — shell wrapper recipe.
- `examples/recipes/music-player-mjs.json` — Node.js wrapper recipe.
- `examples/scripts/music-player.sh`
- `examples/scripts/music-player.mjs`

Purpose: start a local or URL audio source as an async run so the agent can continue working while playback runs in the background. On Unix-like hosts, the running script exposes one run-local FIFO, so the generic `async_run action=send` tool can control playback without a second recipe. The two recipes are intentionally side by side and differ only in the executable wrapper they call, showing that recipes can point directly at either shell scripts or executable JavaScript scripts without adding an interpreter prefix.

Requirements: Linux, macOS, or WSL with `mkfifo` and one of `mpv`, `ffplay`, `cvlc`, or SoX `play` on the host. The default shell wrapper also requires `bash`; the `music-player.mjs` alternative requires Node.js. The wrapper auto-selects the first available player unless `player` is set explicitly. Native Windows is not supported by this example because it uses a Unix FIFO and Unix signals.

The required `source` arg is intentionally broad. It accepts:

- A single local file or URL.
- A directory containing audio files; the wrapper scans it for `.mp3`, `.ogg`, `.wav`, `.flac`, and `.m4a` files.
- An `.m3u`, `.m3u8`, or `.txt` playlist file.
- A `|`-separated inline list of local files or URLs.

You do not need to create a playlist file first. Passing `source="~/Music"` is enough for directory playback.

Install locally:

```bash
mkdir -p ~/.pi/agent/recipes
cp <repo>/examples/recipes/music-player-sh.json ~/.pi/agent/recipes/music-player-sh.json
cp <repo>/examples/recipes/music-player-mjs.json ~/.pi/agent/recipes/music-player-mjs.json
```

Both recipes declare `command:enum(play,pause,resume,toggle,next,previous,stop,status)` and `event_delivery:enum(log,notify,followup)`, with defaults of `play` and `log`. The recommended registered tools below intentionally expose only the playback inputs; controls should go through `async_run action=send` or direct wrapper commands.

Register either or both tools:

```text
register_tool name=music_player_sh \
  description="Start async music player playback through the shell wrapper" \
  template="music-player-sh.json" \
  args="source:string,loop:bool=true,volume:int=70,player:enum(auto,mpv,ffplay,cvlc,play)=auto"

register_tool name=music_player_mjs \
  description="Start async music player playback through the Node.js wrapper" \
  template="music-player-mjs.json" \
  args="source:string,loop:bool=true,volume:int=70,player:enum(auto,mpv,ffplay,cvlc,play)=auto"
```

Start playback with a stable run id:

```text
music_player_sh source="~/Music" volume=55 run_id=music
```

Control it through the generic async-run message action:

```text
async_run action=send run_id=music message=pause
async_run action=send run_id=music message=play
async_run action=send run_id=music message=next
async_run action=send run_id=music message=previous
async_run action=status run_id=music
async_run action=send run_id=music message=stop
```

The wrappers also accept control commands directly when a caller already has the run state dir:

```text
music-player.sh pause ~/.pi/agent/tmp/pi-auto-tools/runs/music
music-player.mjs next ~/.pi/agent/tmp/pi-auto-tools/runs/music
music-player.sh resume ~/.pi/agent/tmp/pi-auto-tools/runs/music
```

Message format is intentionally simple: one newline-delimited command is written to the Unix FIFO at `<run state dir>/control.fifo`. `async_run action=send` adds the trailing newline when the caller omits it. The script also writes `status.txt`, `player.json`, and track-change events in `outbox.jsonl` in the same state dir for status inspection.

Supported FIFO messages are `play`, `pause`, `toggle`, `next`, `previous`, and `stop`. At the wrapper CLI level, `play` starts playback and `resume` sends the FIFO `play` message to avoid ambiguity. Use `async_run action=status` for run lifecycle status, and inspect `status.txt` or `player.json` in the run state dir for player-local state. The command vocabulary belongs to the music-player wrapper script; pi-auto-tools core only writes the caller's line to the run-local FIFO.

The recipe relies on the command-template default of no timeout because playback is intentionally open-ended. `message=stop` asks the player to exit cleanly; `async_run action=cancel run_id=music` remains the generic process-group stop for any async run. Track-change events default to `delivery: "log"`; set `event_delivery` to `notify` or `followup` only when the coordinator should receive live player events.

While the run is active, the launching coordinator session shows the ambient triangle indicator. With one background player it blinks between `▶` and `▷`; it disappears when playback exits or is cancelled.

## Safety Notes

- Only play trusted local files or URLs.
- Volume is clamped to `0..100` by the wrapper.
- Prefer a stable `run_id` such as `music` when the operator expects to control the run by name.
- Use `async_run action=kill` only when graceful cancellation fails.
