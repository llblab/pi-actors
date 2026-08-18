---
name: music-player
description: Use for starting, resuming, inspecting, and controlling one persistent local music playback actor from caller-approved files, directories, URLs, or playlists.
---

# Music Player

Use this Skill for one local music playback service. For generic Recipe execution, singleton Run lifecycle, persistent-tool setup, or diagnosis, follow `actors`; this Skill owns only playback-specific selection and controls.

## Playback

`music-player/playback` is a singleton async controlled service with the canonical address `run:music-player`. The Recipe is the sole lifecycle owner: it starts the service, supervises it, and stops playback when the Run closes. The service owns queue, backend, checkpoint, and playback state. `playback-client.mjs` is a pure actor-neutral RPC client; it never starts, adopts, supervises, or signals a service. The executable also supports explicit foreground `serve` for development or a caller-owned standalone host, but Actor and standalone ownership of one state directory are mutually exclusive.

```text
spawn recipe=music-player/playback values={"source":"~/Music","player":"auto"}
message target=run:music-player action=pause
message target=run:music-player action=next
inspect target=run:music-player view=control
```

A repeated compatible spawn returns the healthy active singleton instead of launching a second player. A terminal or dead singleton restarts under the same Run id with a fresh fenced generation and restores its validated playback checkpoint when the source and configuration still match.

## Controls

Use only declared actions: `play`, `pause`, `resume`, `toggle`, `next`, `previous`, `seek`, `volume`, `stop`, and `status`.

- `play` and `resume` continue the current checkpointed track selection.
- `next` and `previous` update the checkpoint before the next backend launch.
- `seek` accepts Control input `{ "percent": 0..100 }`, resolves the current track duration, and restarts a supported backend at that percentage while preserving track identity and paused/playing intent. It fails when duration or backend seeking is unavailable.
- `volume` accepts Control input `{ "percent": 0..100 }` and sets any integer percentage. On Linux with WirePlumber, the helper resolves the exact current playback stream by process identity and changes its volume in place so the track continues; when no safe in-place control exists, it restarts the current track under the new volume while preserving paused/playing intent. UI adapters may expose coarse relative steps but must send the resolved absolute percentage.
- `status` is read-only and exposes bounded machine-readable player state, including the current absolute volume and a duration-derived progress percentage projected at read time.
- `stop` ends the live process without silently deleting the saved queue.

External local views use the actor-neutral playback client against the canonical service state directory. They must not read or edit Run files, signal playback processes, construct Actor Control records, or import pi-actors internals. The client validates bounded commands, exact service generation, structured responses, and active endpoint ownership before returning success.

## Optional Telegram View

> [!NOTE]
> If a Generative App runtime is installed, this Skill includes a ready Music Player app at `genapps/music-player.mjs`. Use `telegram_bind` to copy and install it as app `music-player`; hot replacement keeps the same app name with `replace: true`.

Bind with absolute `control`, `stateDir`, and `node` arguments. The adapter reports whether the Actor control surface is actually available. Every mutating button queues a canonical Actor Control through `playback.mjs` and waits for that exact record to become handled or failed, so terminal evidence remains visible in the Run inspector and failures reach Telegram; bounded status projection is read-only. The adapter neither imports extension internals nor starts playback. Its stopped-state Start button returns to Pi so the composition root can spawn `music-player/playback`, while active controls remain deterministic Generative App actions that bypass the model. `pi-telegram` owns only the generic Generative App runtime.

## Sources And Backends

- `source` must name caller-approved local music, a readable directory, a playlist file, a URL, or an explicit `|`-separated list. Do not broaden it to unrelated directories.
- Directory and playlist resolution is owned by the playback helper; there is no separate public playlist Recipe.
- `player=auto` selects an available supported backend. Do not install or substitute a player silently.
- The checkpoint preserves source, resolved queue, current index/track, loop, volume, backend, and playback state. It does not promise within-track position restoration unless the selected backend can prove it.
- A changed source rebuilds the queue. Missing or corrupt checkpoint data fails visibly or rebuilds only under the helper's explicit recovery contract; never claim continuity without evidence.

## Stop Rules

Stop if the source is missing, unreadable, contains no playable audio, or no supported backend is available. Do not claim playback from process start alone; confirm through Run evidence or `status`. Prefer the declared `stop` action for a responsive player. If the service is unresponsive, return to `actors` for bounded Run recovery rather than shell process control.
