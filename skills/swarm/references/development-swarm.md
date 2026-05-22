# Small-Team Development Swarm

Also known as `MAWP`: Multi-Agent Worktree Protocol.

Use this protocol when 2–4 implementation agents work on one project at the same time.
It is intentionally lighter than a full orchestrator runtime.

Core idea: do not block everything in advance. Isolate work surfaces, declare intent before edits, exchange context only after collisions, and merge through one integrator.

## Core Shape

```text
1 project
→ 1 shared backlog
→ 2–4 isolated worktrees or branches
→ each agent owns a small task card
→ conflicts trigger structured context exchange
→ one integrator merges
```

Agents should not mutate the same `main` checkout concurrently. Prefer isolated branches or worktrees:

```bash
git worktree add ../agent-a -b agent/a-task
git worktree add ../agent-b -b agent/b-task
git worktree add ../agent-c -b agent/c-task
```

## When To Use

Use this mode when:

- Work can be split into small file/domain scopes.
- Agents need to write code, docs, tests, or fixtures concurrently.
- A human or integrator-agent can merge patches.
- The project is not high-risk enough to justify a heavy orchestration platform.

Do not use this mode when:

- Tasks require the same public API files.
- The architecture direction is unsettled.
- The expected conflicts are semantic, not just file-level.
- No integrator is available.

## Agent Role Split

Prefer splitting agents by **mutation class**, not by unrelated features.

Stable split:

```text
Agent A: mutate behavior
Agent B: verify behavior
Agent C: describe behavior
Agent D: integrate behavior
```

Practical mappings:

- `2 agents`: implementation; tests/docs/review.
- `3 agents`: implementation; tests; docs plus review.
- `4 agents`: implementation; tests; docs/examples; integrator/refactor/audit.

Recommended roles:

- `Implementation Agent`: writes logic; avoids docs unless needed for the task.
- `Test Agent`: writes tests and may expose bugs; avoids changing production logic.
- `Docs Agent`: updates docs/spec/examples/comments; avoids code.
- `Review/Integrator Agent`: reviews patches, resolves conflicts, runs checks, and merges.

Dangerous split:

```text
Agent A: implement feature X
Agent B: implement feature Y
Agent C: refactor architecture
Agent D: clean up types
```

This creates overlapping semantic ownership. Prefer behavior/test/docs/integration separation so agents do not compete for the same memetic niche.

## Task Card

Every implementation agent gets a task card. The card is the unit of delegation.

```markdown
# Task

Goal:

- What needs to be done.

Allowed files:

- Src/lib/foo.ts
- Src/routes/game/+page.svelte

Avoid files:

- Src/lib/shared/types.ts
- Src/lib/stores/\*

Expected output:

- Patch
- Short summary
- Tests/checks run
- Touched files list
```

A task card should specify mutation zones, not just intent. The smaller the allowed file set, the less coordination machinery is needed.

Scope expansion is the main conflict generator. Agents must not opportunistically refactor unrelated code or silently edit outside the declared task. If an out-of-scope change is needed, write it as a new backlog item or ask the integrator to replan.

## Backlog Partitioning

Use explicit task IDs when a coordinator will split backlog work across agents. File position is too fragile once agents start editing, while stable IDs can appear in scope files, branch names, handoffs, and review reports.

Recommended task card shape:

```markdown
## T-001: Add trust warnings

Labels:

- Docs
- Runtime

Allowed files:

- Docs/command-templates.md
- Lib/schema.ts

Avoid files:

- Package.json

Exit:

- Docs explain the trusted executable boundary.
- Tests cover warning detection.
```

Partition by independent mutation zones first, then by effort. Do not split one shared public contract across agents unless a single integrator owns that contract. If task independence is uncertain, assign the risky task to the integrator or run a planning/review swarm before implementation.

## Collaborative Branch Subagents

Use this pattern when a coordinator needs 2-4 implementation agents to work from one backlog without sharing a mutable checkout.

```text
coordinator reads backlog
→ coordinator writes one scope file per agent
→ local async-run adapter starts isolated clone or worktree branches
→ each subagent works only inside its branch workspace
→ runner verifies commit and pushes branch
→ coordinator reviews ready branches
→ integrator merges through the normal project flow
```

This is primarily a branch artifact protocol, not real-time agent chat. Subagents do not coordinate with each other during execution. They communicate by branch commits, handoff files, conflict reports, and integrator review. When the local runtime supports resumable sessions, a subagent may also use a coordinator checkpoint to ask the orchestrator for a bounded decision without losing its own context.

Coordinator responsibilities:

1. Read the canonical backlog and project instructions.
2. Select independent task groups with stable task IDs.
3. Write one scope file per agent with goal, allowed files, avoided files, exit criteria, checks, and branch name.
4. Start the local async-run adapter.
5. Inspect run status and logs until terminal.
6. Review successful branch diffs before merge.
7. Record failed or out-of-scope work back into the backlog.

Scope file rules:

- Prefer local files over large inline prompts.
- Include task IDs and exact workspace path.
- Include allowed and avoided file lists.
- Require the agent to restate task IDs, allowed files, and exit criteria before editing.
- State that commit and push may be handled by the runner when the local adapter owns git finalization.

Subagent instruction core:

```text
Work only in this repository workspace: <work_dir>.
Read your assigned scope from: <scope_file>.
Before editing, restate task IDs, allowed files, avoided files, and exit criteria.
Do not edit outside declared scope.
If an out-of-scope change is required, write it as a backlog note or handoff risk.
If blocked by a coordinator-only decision and the runtime supports checkpoints, emit a bounded Coordinator Checkpoint instead of discarding your context.
Run the checks named in the scope when practical.
Write a concise handoff report before finishing.
```

## Coordinator Checkpoints

A coordinator checkpoint is a deliberate pause, not free-form chat. It is useful when the subagent has built local context that should not be thrown away, but continuing requires a coordinator decision: scope change, ambiguous product choice, conflict policy, credential/account boundary, or release/publish permission.

Target behavior for capable adapters:

```text
subagent reaches a decision gate
→ subagent emits Coordinator Checkpoint
→ runner pauses the subagent session without dropping context
→ coordinator answers the bounded question
→ runner resumes the same subagent context with the answer
→ subagent records the decision in its handoff
```

Checkpoint payload:

```markdown
# Coordinator Checkpoint

Agent:
Task IDs:
Workspace:
Question:
Why coordinator input is needed:
Options considered:
Recommended option:
Risk if guessed:
State to preserve:
```

Coordinator reply should answer only the checkpoint question. It should not inject broad new context unless the subagent explicitly asked for it. If the runtime cannot resume the same subagent context, write the checkpoint as an artifact, stop the branch as degraded, and let the coordinator replan or launch a new subagent with the checkpoint included.

Coordinator prompt template:

```text
Read the project backlog and instructions.
Partition actionable work into <N> independent task groups.
Prefer groups with non-overlapping allowed files.
Write one scope file per agent under <run_dir>/scopes/.
Each scope file must include task IDs, goal, allowed files, avoided files, exit criteria, checks, branch name, and handoff path.
Do not start execution until every scope has a clear branch artifact contract.
```

Scope file template:

```markdown
# Scope: agent-01

Run:
Branch:
Workspace:
Handoff path:

Task IDs:

- T-001
- T-002

Goal:

- ...

Allowed files:

- ...

Avoid files:

- ...

Exit criteria:

- ...

Checks:

- ...

Out-of-scope handling:

- Do not edit outside allowed files.
- Record required out-of-scope changes in the handoff risk section.
```

Branch artifact contract:

- Success means the expected branch exists, contains at least one commit for the assigned task group, and has been pushed.
- The branch name should include the run id and task range or agent id.
- The handoff report should name task IDs, touched files, checks, risks, and follow-up.
- A branch with no commit is not a successful artifact, even if the subagent exits with code 0.

Partial failure is normal. Treat a run with some ready branches and some failed branches as degraded, not as total failure. The coordinator should report ready branches, failed branches, failure reasons, and the safest next action for each failed scope.

## Soft-Lock Manifest

For 2–4 agents, start with a simple repository-local manifest rather than a lock server.

Suggested path:

```text
.agents/locks.md
```

Example:

```markdown
# Agent Locks

## agent-a

Task: fix scheduler tests
Owns:

- Pallets/aaa/src/tests/scheduler/\*
- Pallets/aaa/src/mock.rs

## agent-b

Task: update fee model docs
Owns:

- Docs/aaa/fees.md
- Docs/aaa/spec.md

## agent-c

Task: refactor frontend card component
Owns:

- Src/lib/components/Card.svelte
```

Protocol:

1. Read `.agents/locks.md` before starting.
2. Add or update your section before editing.
3. Treat `Owns:` as a soft write claim.
4. Avoid another agent's owned files unless the integrator replans.
5. On completion, remove the section or mark it done.

This manifest is weaker than an automated lock adapter but easier for humans and agents to inspect. Use a runtime-backed lock protocol when automation, TTL, or conflict enforcement is needed.

## Exclusive Files

Some files create semantic conflicts even when Git merges cleanly. Require exclusive ownership for public contracts and central runtime boundaries.

Examples:

```text
src/lib/types/*
pallets/*/src/lib.rs
runtime/src/*
docs/spec/*
package.json
Cargo.toml
```

Project-local protocol should define its own exclusive files. If a task needs one, assign it to a single agent or the integrator.

## Conflict Types

### Merge Conflict

Git cannot combine two edits to the same file.

Response:

1. Both agents produce conflict reports.
2. Resolver/integrator reads both reports.
3. Resolver merges patch.
4. Original agents review affected files only.

### Semantic Conflict

Files may merge, but meaning diverges. Example: one agent changes an API while another writes code against the old API.

Response:

1. Stop affected workers.
2. Integrator decides whether the backlog task is invalidated.
3. Split or replan before more implementation.

### Architecture Conflict

The task decomposition itself is wrong.

Response:

1. Stop workers on affected scopes.
2. Re-open planning.
3. Produce new task cards with corrected ownership.

## Conflict Handshake Protocol

Agents should not freely negotiate in long context-sharing threads. Exchange semantic deltas in a bounded format.

```markdown
# Conflict Report

Agent:
Task:
Conflicting files:

- ...

What I changed:

- ...

Why I changed it:

- ...

What I need preserved:

- ...

Can safely discard:

- ...

Suggested resolution:

- ...
```

Resolution flow:

```text
Agent A hits conflict with Agent B
→ Agent A writes Conflict Report
→ Agent B writes Conflict Report
→ Integrator/resolver reads both
→ Resolver creates merged patch
→ Original agents review only affected files
```

The goal is to exchange intent and invariants, not to let agents recursively debate.

## Scope Expansion Rule

Multi-agent work is stricter than solo work.

Required instruction for implementation agents:

```text
Do not opportunistically refactor unrelated code.
Do not modify files outside declared scope.
If you discover a needed out-of-scope change, record it as a backlog item or conflict note.
```

This is the difference between useful parallelism and diff chaos.

## Handoff Report

Each agent writes a concise handoff after finishing.

Suggested path:

```text
.agents/handoff/agent-a.md
```

Template:

```markdown
# Handoff: agent-a

Task:
Branch/worktree:

Summary:

- ...

Touched files:

- ...

Tests/checks:

- ...

Behavior changes:

- ...

Risks / follow-up:

- ...

Integrator notes:

- What must be preserved during merge.
```

Example:

```markdown
# Agent A Handoff

Task:
A1: Add tests for scheduler window expiry

Touched files:

- Pallets/aaa/src/tests/scheduler/window.rs

Summary:

- Added tests for inclusive window end.
- Added test for close only when current_block > end.

Checks:

- Cargo test -p pallet-aaa scheduler_window

Open questions:

- None.

Conflict notes:

- Does not touch runtime logic.
```

## Runner Adapter Contract

A local branch runner may be useful, but it is adapter policy rather than portable Swarm core. Keep concrete model names, tool allowlists, async-run syntax, and runtime-specific CLI invocation outside this skill.

Minimum runner behavior:

1. Clone or create an isolated worktree from the requested repo and base branch.
2. Create the expected feature branch.
3. Run one subagent with the prepared scope file and bounded tool access.
4. Verify the current branch is still the expected branch.
5. Verify there are intentional changes before commit.
6. Commit with a task-aware summary when the adapter owns git finalization.
7. Push the expected branch.
8. Emit a structured result with branch, commit, pushed status, handoff path, checks, and failure reason.

Recommended subagent tools are the smallest set that can complete the task, usually read, edit/write, and shell validation. Avoid broad external account tools inside implementation subagents. External actions such as opening pull requests, merging, publishing, or commenting belong to the coordinator or integrator after review.

Runner exit policy:

- Exit 0 only after commit verification and successful push when the runner owns git finalization.
- Exit non-zero when clone, checkout, subagent execution, commit verification, or push fails.
- A failed branch should not cancel sibling branches in the same async fanout.
- Timeouts should preserve logs and any handoff artifacts for coordinator inspection.

## Integrator Protocol

The integrator is the only actor that merges to the shared target branch.

Integrator steps:

1. Read backlog, locks, and handoffs.
2. Merge one branch at a time.
3. Resolve conflicts using conflict reports, not guesses.
4. Run the project's validation gates.
5. Ask original agents to review affected files when conflict resolution changed their work.
6. Produce final summary: merged tasks, tests, touched files, residual risks.

## Effective Protocol

```markdown
# Multi-Agent Protocol

1. Each agent MUST work in a separate branch or worktree.
2. Before editing, each agent MUST declare task, intended files, forbidden files, and expected output.
3. Agents SHOULD avoid files already claimed in `.agents/locks.md`.
4. Public API, storage, runtime, schema, and spec files require exclusive ownership.
5. Each agent MUST produce a handoff note after completion: touched files, semantic changes, checks run, unresolved risks.
6. If a conflict occurs, both agents MUST produce Conflict Reports.
7. Conflict resolution MUST preserve semantic intent, not merely compile.
8. Integrator merges patches into the shared target after checks pass.
9. No agent may silently expand task scope.
```

Context exchange rule:

```text
Before conflict: minimal shared context.
At conflict: compressed intent/diff/risk exchange.
After conflict: update backlog/locks.
```

Constant agent chat destroys independence. Conflict reports preserve the useful context without contaminating every worker.

## Minimal Directory

```text
.agents/
  backlog.md
  locks.md
  protocol.md
  handoff/
    agent-a.md
    agent-b.md
    agent-c.md
```

This directory is optional. Use it when the repository lacks an existing coordination plane. If the project already has backlog, lock, and handoff conventions, reuse them instead.
