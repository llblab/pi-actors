---
name: media
description: Local media discovery, playlist construction, and controllable playback capabilities.
---

# Media

Own reusable local media workflows and services.

## Scope

- Scan caller-selected media sources and build bounded playlists.
- Run controllable playback when the local player implements declared actions.
- Emit canonical Trace and consume canonical Control without inventing media-specific runtime nouns.

This Skill does not own the Run kernel, user media, transport delivery, or general artifact policy. Its Recipe identity is `media/<filename stem>`; Recipe files have no top-level `name`. Helper-backed Recipes locate only co-located scripts through `{skill_dir}`, and cross-capability composition uses exact `<skill>/<recipe>` references.
