# Actors Deep Reference

Use this document after `skills/actors/SKILL.md` when quick-start actor mechanics are not enough.

## Recipe Navigator

Use packaged recipes by name with `spawn file=<name>` for async actors, or register/call them as tools when repeated use deserves a stable shortcut. Start with the curated list below; use [`recipe-library.md`](recipe-library.md) for the full shipped inventory.

### Top Recipes

- [`pipeline-room-swarm`](../recipes/pipeline-room-swarm.json): room-visible swarm coordination with roles, rounds, optional locker, artifact synthesis, and `subagent_ttl_ms` for hard participant budgets.
- [`pipeline-repo-health`](../recipes/pipeline-repo-health.json): git/doc/validation evidence to normalized repository health report.
- [`pipeline-release-readiness`](../recipes/pipeline-release-readiness.json): changelog/package/skill/validation evidence to release review and artifact report.
- [`actor-worker`](../recipes/actor-worker.json): canonical mailbox-backed branch worker reference for claim/handle/status/artifact patterns.
- [`coordinator-locker`](../recipes/coordinator-locker.json): queue, lease locks, and journaled coordinator messages for multi-actor ownership.

### Common Cells

- Subagents: [`subagent-prompt`](../recipes/subagent-prompt.json), [`subagent-review-coordinator`](../recipes/subagent-review-coordinator.json), [`subagent-quorum`](../recipes/subagent-quorum.json), [`lens-swarm`](../recipes/lens-swarm.json).
- Artifacts/messages: [`utility-artifact-manifest`](../recipes/utility-artifact-manifest.json), [`utility-artifact-write`](../recipes/utility-artifact-write.json), [`utility-actor-message`](../recipes/utility-actor-message.json).
- Validation/state: [`utility-validation-wrapper`](../recipes/utility-validation-wrapper.json), [`utility-validate-recipe`](../recipes/utility-validate-recipe.json), [`utility-run-summary`](../recipes/utility-run-summary.json), [`utility-run-state-files`](../recipes/utility-run-state-files.json), [`utility-jsonl-tail`](../recipes/utility-jsonl-tail.json).

## Operating Patterns

- **Short deterministic command**: call a foreground registered tool or command template.
- **Long job/service/fanout**: `spawn` an async recipe, then inspect messages and artifacts.
- **One-off experiment**: use inline `template`; promote only useful repeats.
- **Reusable workflow**: package a user or bundled recipe with public knobs, mailbox, artifacts, and docs.
- **Subagent/swarm execution**: compose packaged recipes/pipelines from smaller recipe cells; add missing generic cells to the extension rather than creating one-off external orchestration scripts.
- **Consensus-first build**: when many lenses should shape one artifact, have proposer subagents post room messages, then one named implementer writes, one QA reviewer checks, and one finalizer emits `run.done`.
- **Coordinated workers**: spawn `coordinator-locker` when several actors need a shared queue, acquire/renew/release resource leases, or a journaled coordination point.
- **Release/review pipeline**: pi-actors can prepare evidence, summaries, and artifacts; external actions such as commit, PR, merge, tag, and publish require the appropriate gated release workflow.

## Complementary Methodology Engines

pi-actors is the local execution engine for methodology skills. A methodology skill can define abstract patterns such as lens swarm, quorum, task cards, lock discipline, consensus-first build, or clean-context merge; pi-actors turns those patterns into concrete local actors, recipes, queues, leases, artifacts, and messages.

Keep the split clean: methodology chooses coordination shape; pi-actors supplies addressable local machinery.

## Lifecycle Discipline

1. Choose an existing recipe/tool when available.
2. Spawn with a stable actor id for observable work.
3. Inspect `status` after launch.
4. Use notifications and `inspect`; do not busy-poll.
5. Read `messages` and `artifacts`, not only stdout.
6. Use `message` for explicit control or domain commands; inspect `mailbox` before domain-specific messages.
7. Promote repeated inline forms to recipes.
8. Keep recipes small and shallow: files over 1 MiB or import chains deeper than 32 are rejected.
9. Update docs/context when changing public behavior; if the change affects how agents operate this extension, update the bundled skill and prompt guidance too.

## Common Pitfalls

- Treating actor mechanics as multi-agent methodology.
- Repeating inline templates instead of promoting recipes.
- Creating task-specific external orchestration scripts when the scenario belongs in pi-actors as a reusable recipe/pipeline.
- Embedding complex shell loops or Bash `${...}` parameter expansion directly in command templates; braces are pi-actors placeholders too.
- Omitting stable run ids for work that needs follow-up.
- Sending domain messages without checking `mailbox`.
- Expecting current room messages to wake prompt-only subagents; use direct branch messages or a runner protocol for initiating work.
- Reading only stdout and missing actor messages/artifacts.
- Assuming every packaged message-controlled script is native-Windows-ready; core run control is platform-adapted, but Unix-tool scripts must be migrated recipe by recipe.
- Baking local absolute paths into published docs or reusable recipes.
- Creating recipes that perform external side effects without explicit operator gates.
- Letting project insights live only in chat instead of updating BACKLOG/CHANGELOG/docs and, when agent behavior changes, the packaged skill or prompt guidance.
- Preserving old runtime/event/FIFO vocabulary instead of `spawn`/`message`/`inspect` and actor messages.
