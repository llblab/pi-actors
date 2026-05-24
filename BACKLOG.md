# Project Backlog

## Open Work

### Branch Inbox Retention and Transition Scaling

- Priority: Medium.
- Goal: Keep direct branch message queues reliable for long-lived interactive branch runners without unbounded rewrite amplification.
- Direction:
  - Evaluate current whole-file branch inbox status rewrites under realistic long-lived direct-message workloads.
  - Consider bounded retention, compaction, or append-only transition logs for `queued` / `claimed` / `handled` / `failed` state changes while preserving stable message IDs and exact-once claim semantics.
  - Keep branch-local inbox append/status mutations lock-guarded and preserve inspector visibility for unread/current-branch filters.
- Exit:
  - A documented decision or implementation explains how branch inboxes scale for persistent runners and proves existing direct-message semantics remain compatible.

### Installed Recipe Trust Boundary Hardening

- Priority: Medium.
- Goal: Keep recipe-library growth local-first without letting operator muscle memory become an accidental sandbox bypass.
- Direction:
  - Review packaged recipes, examples, and docs for destructive or external side effects and ensure they require explicit paths, typed args, narrow helper scripts, and clear operator gates.
  - Keep warnings framed as diagnostics, not a security boundary.
  - Prefer small audited helper scripts over broad shell templates when recipes touch files, processes, networks, or external services.
- Exit:
  - A trust-boundary review confirms packaged recipes and docs preserve the current local-first/not-sandbox-first contract, with any needed hardening captured in tests or docs.

### Direct Branch Message Consumption Semantics

- Priority: Medium.
- Goal: Make it impossible to misunderstand branch inbox delivery as universal active delivery without a consuming coordinator or runner protocol.
- Direction:
  - Audit README, actor-message docs, async-run docs, actors skill, and recipe guidance for branch inbox wording.
  - Clarify that direct branch messages are queued and become active work only when the relevant coordinator/runner claims, injects, handles, or fails them.
  - Add or update a bounded smoke scenario that demonstrates queued direct messages, claim/handle transitions, and inspector visibility.
- Exit:
  - Public docs and tests show both halves of direct branch delivery: durable branch-local queueing and explicit worker consumption semantics.

### Actor Rooms, Roster, and Cross-Branch Messaging

- Priority: High.
- Goal: Continue evolving actor communication without adding a second public messaging model.
- Direction:
  - Evaluate whether room storage/routing should remain built into the tool adapter or move behind a dedicated non-LLM communication actor recipe/script, possibly singleton-scoped. Preserve the same public `room:<run>` address and envelope either way.
  - Treat the next backend decision as an evidence-backed experiment, not a rewrite: stress a real room/direct-message workload, compare the current file-backed adapter with a thin communication actor/helper, and record the decision.
  - Consider reducing direct file-backed state where it improves coherence: model room/roster state as actor-owned data structures served by helper scripts/actors, with files retained only for durable snapshots, recovery, artifacts, or audit logs.
  - Further storage changes should preserve the current burst/read/concurrency safeguards: branch communication snapshot writes are debounced, root snapshots stay current, roster files are not rewritten during bursts when only `last_seen` changes, room status inspection does not parse full timelines, branch-local inbox append/status rewrites are lock-guarded, and legacy no-ID branch inbox records can be claimed exactly once.
  - Prevent monolith drift: `actor-rooms.ts` may remain a thin adapter, but growing routing policy, subscription loops, fanout policy, or long-lived state ownership should move behind a focused communication helper/actor rather than accumulating in the tool adapter.
- Exit:
  - Any backend/storage change preserves existing `spawn` / `message` / `inspect` semantics and room address compatibility.
  - A short decision note or changelog entry explains why the room backend stayed file-backed or moved behind a communication actor/helper.

### Graceful Actor Retirement

- Priority: Medium.
- Goal: Automatically retire coordinator/helper actors that were launched only to supervise a bounded worker tree once their dependent workers have finished.
- Direction:
  - Build on the existing `retire_when: "children_terminal"` recipe/run metadata contract and observability retirement-candidate detection for ephemeral supervisors.
  - Treat auto-retirement as opt-in only; never infer it for arbitrary long-lived services, user tools, or persistent backlog implementers.
  - Extend candidate detection beyond current active command/proc-descendant gating to full observed child async-run state rather than log text: the supervisor may retire only when all launched child async runs are terminal and required artifacts/outbox events have been flushed.
  - Prefer graceful stop (`control.stop` / actor message) before process termination; escalate only after a bounded timeout and record the retirement event in run state.
  - Preserve manual `cancel` / `kill` semantics and make retirement visible through `inspect` / ambient observability.
- Exit:
  - A packaged coordinator recipe can launch worker actors, complete its coordination duties, and shut itself down automatically after the worker tree reaches terminal state.
  - Persistent services and implementer actors remain alive unless their recipe explicitly opts into retirement.

### Coordinator Strategy Boundary

- Priority: Medium.
- Goal: Keep the generic coordinator from becoming a second overloaded monolith as room/direct-message workflows mature.
- Direction:
  - Split only at real pressure points: branch inbox claim/finalize helpers, participant execution, room transcript synthesis, and mode strategies are likely seams, but avoid cosmetic module churn.
  - Preserve the current principle that the locker stays generic/thin and all orchestration policy stays in coordinator strategy code or recipe composition.
  - Prefer reusable helper modules or small scripts only when at least two packaged workflows need the same behavior.
- Exit:
  - Adding a new coordinator mode or packaged multi-agent workflow does not require editing unrelated mode logic.
  - Existing room-swarm, locker, and direct-branch-message tests still cover the extracted seams.

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

### Actor OS Scenario Smoke Matrix

- Priority: Medium.
- Goal: Convert the 0.19.x actor-communication hardening into repeatable end-to-end scenario checks instead of relying on ad hoc demos.
- Direction:
  - Cover one scenario each for shared room coordination, direct branch work delivery, branch inbox claim/handle/fail transitions, inspector navigation, recipe context injection, recipe persistence suggestion, and opt-in retirement candidate detection.
  - Keep scenarios local-first and bounded: fake `pi`/models where possible, no external services, no long sleeps, no broad golden transcripts.
  - Prefer packaged recipes and public `spawn` / `message` / `inspect` calls so the smoke matrix exercises the same surface agents use.
- Exit:
  - A single validation command or documented test group verifies the actor OS behaviors that made 0.19.x production-useful.
  - The smoke matrix catches regressions in actor communication, recipe memory, and observability without requiring a manual swarm demo.

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
