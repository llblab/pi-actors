# Project Backlog

## Open Work

### Native Windows Smoke and Runtime Notification Follow-up

- Priority: High.
- Target: Post-0.22.0 validation and hardening.
- Goal: Validate the cross-platform actor wake/notification layer on native Windows without changing the public actor API or replacing file-backed actor state as the observable source of truth.
- Decision:
  - Keep files as durable truth: mailbox/state/event/room files remain canonical for `inspect`, observability, crash recovery, and replay.
  - Treat runtime notification as an advisory wake layer, not as the queue itself.
  - Preserve `spawn`, `message`, and `inspect` as the only public actor API; platform transport choices stay internal.
- Progress:
  - Prepared the cross-platform runtime notification layer for release with a file-backed runtime notifier boundary using `notify(actor)` / `subscribe(actor, onWake)`, persisted `wake.jsonl` records, `fs.watch` subscription, and periodic fallback coverage.
  - Notifier subscriptions can now receive explicit reconciliation callbacks for initial scan, wake-triggered scans, and polling fallback.
  - Run-local `message` delivery now records the durable run inbox entry and advisory wake before attempting the optional live control endpoint; successful endpoint delivery marks the inbox entry `sent`.
  - Run mailbox inspection now shows recent durable inbox entries alongside recipe-declared mailbox metadata.
  - Added run inbox claim/handle/fail helpers for runtime loops, including locked claims so reconciliation callbacks can safely dispatch queued mailbox work once.
  - Added mailbox-only run control endpoints so runtimes can accept `message` through durable inbox/wake state without requiring FIFO or named-pipe delivery.
  - Migrated the packaged music-player control path to queued mailbox commands as the first concrete script using the mailbox-only runtime direction.
  - Added a native Windows `wmp` music-player backend using legacy Windows Media Player COM via `powershell.exe`, with `wmplayer.exe` detection in standard Program Files locations and mailbox-backed controls mapped to WMP play/pause/stop operations.
  - Hardened the music-player mailbox loop to avoid repeated unchanged mailbox reads by combining advisory wake records, `fs.watch`, and inbox signature polling.
  - Improved Unix-like playback support with the macOS-native `afplay` backend, broader audio extension scanning, and process-group signaling for child playback controls.
  - Room timeline appends and branch inbox append/status transitions now emit advisory wake records for the addressed room or branch actor.
- Direction:
  - Continue wiring mailbox-only endpoints and notifier reconciliation callbacks into concrete packaged actor scripts where file-backed mailbox dispatch should replace transport-specific control loops.
  - Ensure message delivery writes durable file-backed mailbox/state first, then emits a wake notification.
  - Require actor runtimes to reconcile mailbox state on wake and also on a periodic fallback so missed notifications do not lose work.
  - Provide a universal baseline backend using file-system change notification plus periodic reconcile across Linux, macOS, and Windows.
  - Keep FIFO/named-pipe/socket style endpoints as optional fast wake backends or compatibility paths, not as required durable queues.
  - Document the model as "wake, not queue": notification wakes a live actor; files remain the queue and audit trail.
- Windows smoke focus:
  - Run installed `@llblab/pi-actors@0.22.0` or newer on native Windows.
  - Verify simple `spawn` / `message` / `inspect` actor communication.
  - Verify small room-swarm/subagent communication, branch/direct messages, mailbox claim/handled transitions, graceful stop/cancel behavior, and opt-in retirement.
  - If smoke passes, update docs/release notes from "adapter support" to "Windows smoke-tested subagent communication" for the next release.
- Exit:
  - Actor communication works through the cross-platform notifier layer with public API unchanged.
  - Inspect/observability continue to read canonical file state and do not depend on a live notifier process.
  - Missed wake notifications are recovered by mailbox reconciliation.
  - Windows subagent communication smoke is documented with results and any remaining limitations.

### Consensus-First Build Recipe

- Priority: Medium.
- Goal: Promote the proven proposer → implementer → QA → finalizer pattern into a generic packaged workflow instead of demo-specific scripts; pi-actors should grow its standard recipe/script library for recurring actor OS scenarios.
- Direction:
  - Public inputs: mission, artifact paths/assertions, proposer role JSON, implementer prompt, QA prompt, model/thinking/tool knobs, and optional room/locker settings.
  - Proposers should coordinate through room messages with no write tools.
  - The implementer owns the first artifact write after inspecting room consensus.
  - QA inspects artifacts and room evidence without mutating files.
  - The finalizer applies QA-grounded fixes and emits `run.done` only after artifact assertions pass.
  - Reuse packaged subagent/message/artifact components where practical; if a script is needed, make it a generic packaged helper in the extension, not a task-local demo script.
- Exit:
  - A packaged recipe can reproduce the interactive-music-instrument workflow shape for another single-artifact task without copying the demo script.
  - Docs and skills point agents to the packaged recipe and explain when to choose it over a free-form room swarm.

### Persistent Backlog Implementer Workflow

- Priority: Medium.
- Goal: Express persistent front/back backlog implementers as reusable extension-level recipe composition instead of bespoke workflow scripts.
- Direction:
  - Use existing coordination cells such as `coordinator-locker` for queue/assignment/locking semantics.
  - Compose existing subagent launcher recipes for execution slices rather than adding dedicated implementer scripts.
  - Add missing reusable component recipes only when an implementer scenario cannot be expressed with the existing library.
  - Update `skills/actors/SKILL.md` whenever a new implementer/coordinator recipe is added so agents know which scenario to launch and which packaged recipes to use.
  - Preserve the protocol insight: implementers report `task.result` / `awaiting_assignment`, stay alive between assignments, and stop only after coordinator-issued control.
- Exit:
  - A packaged workflow, if added, is described by recipes and existing helper cells; no one-off backlog-implementer scripts are required.
  - The actors skill documents the supported launch scenarios and the concrete packaged recipes for each.

### Branch-Local Checkpoint Semantics

- Priority: Low.
- Blocked by: At least one real collaborative branch-runner async-run experiment.
- Goal: Validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are enough for branch-local validation and bounded reattempts.
- Exit:
  - Record one decision: sufficient, documentation-only refinement needed, or propose one minimal command-template extension with tests.

### Host-Level Tool Unregistration

- Priority: Low.
- Blocked by: Host API support for custom tool unregistration.
- Goal: Remove stale dynamically registered tool definitions completely when the host API supports it.
- Direction:
  - Track pi extension API support for custom tool unregistration.
  - Replace active-tool deactivation fallback with real unregister when available.
  - Preserve current safe behavior: deleted tools should not remain active after reload.
- Exit:
  - Deleting a recipe file removes the corresponding runtime tool definition and active-tool entry without session restart.

### Recipe Discovery Expansion

- Priority: Low.
- Goal: Support larger recipe libraries without confusing recipe identity or priority.
- Direction:
  - Add nested recipe directories only after flat `recipes/*.json` discovery semantics are stable.
  - Keep same-id priority and invalid-blocking behavior explicit if nested ids are introduced.

### Actor Recipe Feedback Loop

- Priority: Low.
- Goal: Turn actor recipe-context awareness into a practical improvement loop for packaged recipes and operator-owned recipe memory.
- Direction:
  - After real multi-agent runs, capture whether child actors report that recipe/import/mailbox/role boundaries fit the task.
  - Keep the loop advisory and operator-gated: feedback may suggest recipe edits or copying into `~/.pi/agent/recipes`, but must not auto-save or rewrite durable recipes without confirmation.
  - Prefer small recipe/readme/skill refinements over adding scenario catalogs; recurring patterns should become packaged recipes only after repeated use.
- Exit:
  - At least one real run produces recipe-boundary feedback that is either applied to a recipe/docs change or explicitly rejected with rationale.

### Recipe Usage Telemetry Evolution

- Priority: Low.
- Goal: Improve long-term operator insight into recipe usefulness without making telemetry noisy.
- Direction:
  - Consider sidecar stats sync/backup policy after inline user-owned `usage.calls` / `usage.last_called` proves useful.
  - Consider an operator-approved recipe promotion workflow that turns successful package/ad hoc/direct spawn suggestions into a reviewed `~/.pi/agent/recipes` entry with provenance and diff, without auto-saving.
  - Do not add failure counters as primary usefulness evidence unless there is a strong operator-facing need.
