# Project Backlog

- [ ] `0.50.0 hardening`: Close the confirmed authorization, bounded-inspection, and operator-truth gaps from the v0.49.1 production-readiness review.
  - [ ] `Run boundary checkpoint`: Public Run operations remain owner-safe and bounded under missing identity and adversarial evidence sizes.
    - [ ] Make Run-specific `inspect` and `message` operations fail closed when the caller session identity is unavailable, keep runtime inventory owner-filtered, and add missing-context plus cross-owner regressions.
    - [ ] Bound session-evidence and artifact-manifest inspection before full-file materialization; use capped/streaming reads or hashing as appropriate and add adversarial-size regressions.
  - [ ] `Operator truth checkpoint`: Public status and recovery guidance exactly match supported runtime behavior.
    - [ ] Route automatic-review status through the canonical policy parser so `0`, `false`, and `off` are reported consistently without case sensitivity.
    - [ ] Replace the removed `session:<id>` and `session:all` recovery hints with supported inspection guidance.
    - [ ] Document exact `message target=run:<id>` examples for runtime-owned `kill`, `archive`, and `prune`, including their state and artifact-preservation constraints.
  - [ ] Pass focused boundary and operator-contract regressions plus full package validation before release.

- [ ] `Future minor — Linux MPRIS media integration`: Expose the active `music-player/playback` singleton as one optional generation-fenced MPRIS2 player so GNOME and compatible desktop shells can show current media and native controls without making D-Bus a second playback authority; keep this feature outside the 0.49.2 and 0.50.0 cohorts.
  - [ ] Publish `PlaybackStatus`, track metadata, duration, read-time position, volume, and supported capabilities under one stable session-scoped bus identity; disappear cleanly when the Run stops or its generation is replaced, and fail soft when the user D-Bus session is unavailable.
  - [ ] Map `Play`, `Pause`, `PlayPause`, `Next`, `Previous`, `Stop`, `Seek`, `SetPosition`, and `Volume` back into the existing generation-fenced music-player Control/helper contract rather than signaling the backend or editing Run state directly.
  - [ ] Validate deterministic D-Bus contract behavior plus a live GNOME smoke showing the media surface, metadata, progress, volume, and controls while preserving backend independence and exact Actor ownership.
