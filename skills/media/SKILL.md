---
name: media
description: Use for local media discovery, filtering, library summaries, playlist construction, or controllable playback.
---

# Media

Use this Skill for caller-selected local media. For generic Recipe execution, persistent-tool setup, Run lifecycle, or diagnosis, follow `actors`; this Skill only selects media behavior.

## Choose the operation

| Intent | Recipe | Use when |
| --- | --- | --- |
| Start or control playback | `media/player` | A local file, directory, or playlist should become a controlled service |
| Build a library summary | `media/library` | A filtered playlist should feed bounded report content |
| Build a filtered playlist | `media/playlist-build` | Extension filtering and `paths`, `m3u`, or `inline` output are required |
| Scan a directory for raw file paths | `media/playlist-scan` | A shallow unfiltered inventory is intentionally sufficient |

Use `playlist-build` rather than `playlist-scan` for normal media selection. `library` composes playlist output into report content; its `artifact_path` identifies the intended report target but does not by itself prove a durable write.

## Controlled playback

`media/player` is an async controlled service. Start one owned Run, then use only its declared actions: `play`, `pause`, `resume`, `toggle`, `next`, `previous`, `stop`, and `status`.

```text
spawn recipe=media/player as=run:music values={"source":"~/Music","player":"auto"}
message target=run:music action=pause
inspect target=run:music view=control
```

For recurring playback as a persistent callable tool, use the persistent-capability workflow in `actors` with `from=media/player`; do not copy the player contract.

## Paths and selection

- `source` for playback must name caller-approved local media; do not broaden it to unrelated directories.
- `source_dir` must be an intended readable directory. `~` is accepted by maintained media helpers.
- Keep `max_depth` bounded. Use explicit comma-separated extensions for `playlist-build` and `library`.
- Choose `output_mode=m3u` only when playlist text is wanted; it does not create a playlist file.
- Choose an explicit `artifact_path` and model for `library` report generation.
- `player=auto` selects an available supported backend; do not install or substitute a player silently.

## Stop rules

Stop if the source is missing, unreadable, contains no selected media, or no supported player is available. Do not claim playback from process start alone; confirm through Run evidence or `status`. Prefer the declared `stop` action for a responsive player. If the service is unresponsive, return to `actors` for bounded Run recovery rather than shell process control.
