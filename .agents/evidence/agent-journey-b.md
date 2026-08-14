# Fresh-Agent Journey B Evidence

## Setup

- Loaded only the release-candidate `dist` extension and packaged `dist/skills` into an isolated temporary agent directory and an empty temporary working directory.
- Disabled context-file and ambient extension discovery; used an ephemeral no-session print run.
- Prompt intent: persist `media/player` as `music_player` with default source `~/Music/1MIX`, then use the actual tool with `command=status` without playing audio.
- Explicitly prohibited README, docs, repository source, lib, scripts, and helper-source reads.
- Model policy: `openai-codex/gpt-5.6-sol`, low thinking.

## Observed route

1. The fresh agent read only the packaged `actors` and `media` Skill bodies.
2. It called `register_tool` with:
   - `name=music_player`
   - `from=media/player`
   - `defaults.source=~/Music/1MIX`
3. Registration reported `resolved=true`, `validated=true`, `persisted=true`, `registry_active=true`, `host_registered=true`, `active_tool=true`, and `callable_now=true`.
4. The next tool call was the generated `music_player` tool with `command=status`.
5. Tool evidence reported `launch_kind=tool`; the resulting controlled Run reached terminal `done`.
6. The final agent answer named Skills `actors` and `media`, `callable_now=true`, actual tool `music_player`, and `launch_kind=tool`.

## Forbidden-path review

The captured session contained no README/docs read, repository `lib` read, helper/script source read, `bash -lc`, direct helper execution, copied Recipe contract, or `spawn` substituted for registered-tool invocation. The runtime execution result naturally identified its packaged helper in structured internal execution details; the agent did not inspect or invoke that helper directly.

## Final release-tree rerun

After the `0.47.0` version/changelog/backlog tree passed release validation and was rebuilt, the isolated fresh-agent run was repeated. Filtered public evidence again showed `register_tool` with `callable_now=true` and `source=media/player`, an actual `music_player` call with `launch_kind=tool`, final Skills `actors` and `media`, and terminal Run status `done`.

## Verdict

**Accepted.** A fresh agent with no repository context completed Journey B through packaged Skill guidance and public tools only on the final release tree.
