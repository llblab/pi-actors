# Project Backlog

## Open Work

### Actor Rooms, Roster, and Cross-Branch Messaging

- Priority: High.
- Goal: Continue evolving actor communication without adding a second public messaging model.
- Direction:
  - Evaluate whether room storage/routing should remain built into the tool adapter or move behind a dedicated non-LLM communication actor recipe/script, possibly singleton-scoped. Preserve the same public `room:<run>` address and envelope either way.
  - Consider reducing direct file-backed state where it improves coherence: model room/roster state as actor-owned data structures served by helper scripts/actors, with files retained only for durable snapshots, recovery, artifacts, or audit logs.
  - Avoid full roster rewrite amplification during bursty room activity; branch communication snapshot writes are already debounced while root snapshots stay current.
- Exit:
  - Any backend/storage change preserves existing `spawn` / `message` / `inspect` semantics and room address compatibility.

### Graceful Actor Retirement

- Priority: Medium.
- Goal: Automatically retire coordinator/helper actors that were launched only to supervise a bounded worker tree once their dependent workers have finished.
- Direction:
  - Build on the existing `retire_when: "children_terminal"` recipe/run metadata contract and observability retirement-candidate detection for ephemeral supervisors.
  - Treat auto-retirement as opt-in only; never infer it for arbitrary long-lived services, user tools, or persistent backlog implementers.
  - Extend candidate detection from current `progress.activeSubagents === 0` gating to full observed child/descendant actor state rather than log text: the supervisor may retire only when all launched child async runs or descendant `pi -p` workers are terminal and required artifacts/outbox events have been flushed.
  - Prefer graceful stop (`control.stop` / actor message) before process termination; escalate only after a bounded timeout and record the retirement event in run state.
  - Preserve manual `cancel` / `kill` semantics and make retirement visible through `inspect` / ambient observability.
- Exit:
  - A packaged coordinator recipe can launch worker actors, complete its coordination duties, and shut itself down automatically after the worker tree reaches terminal state.
  - Persistent services and implementer actors remain alive unless their recipe explicitly opts into retirement.

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

### Recipe Usage Telemetry Evolution

- Priority: Low.
- Goal: Improve long-term operator insight into recipe usefulness without making telemetry noisy.
- Direction:
  - Consider sidecar stats sync/backup policy after inline user-owned `usage.calls` / `usage.last_called` proves useful.
  - Do not add failure counters as primary usefulness evidence unless there is a strong operator-facing need.
