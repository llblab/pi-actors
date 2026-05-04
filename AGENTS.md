# Project Context

## Meta-Protocol Principles

- `Constraint-Driven Evolution`: Add structure when real project constraints justify it
- `Single Source of Truth`: Keep durable protocol, open work, completed delivery, and docs in separate files
- `Context Hygiene`: Compress stale context before it becomes coordination drag
- `Boundary Clarity`: README is the human entrypoint, `AGENTS.md` is durable protocol, `BACKLOG.md` is open work, and `CHANGELOG.md` is delivery history

## Concept

`pi-auto-tools` is a pi extension that persists user-registered tools in `~/.pi/agent/auto-tools.json` and registers them automatically across sessions.

## Topology

- `/index.ts`: Minimal extension coordinator/composition root; it wires live pi ports and should avoid owning domain behavior
- `/lib/*.ts`: Flat Domain DAG modules for cohesive reusable behavior; `command-templates.ts` mirrors the shared portable command-template standard, `schema.ts` owns auto-tools arg declarations and placeholder-derived tool schemas, `identity.ts` owns names, `config.ts` owns config persistence, `registry.ts` owns registry register/update/delete use-cases, `output.ts` owns result formatting/truncation, `execution.ts` owns registered-tool execution, `prompts.ts` owns LLM-facing copy, `tools.ts` owns pi-facing tool definitions for both `register_tool` and generated runtime tools, `runtime.ts` owns load/conflict/registration coordination, and `paths.ts` owns config path resolution
- `index.ts` should import local domains as namespaces (`import * as CommandTemplates from "./lib/command-templates.ts"`) so orchestration reads through domain names instead of flat helper imports
- `/tests/*.test.ts`: Focused regression tests for pure domains
- `/README.md`: Human-facing install, usage, and runtime semantics
- `/BACKLOG.md`: Canonical open work; keep it empty when no actionable or gated work remains
- `/CHANGELOG.md`: Completed delivery history
- `/docs/README.md`: Documentation index

## Operating Principles

- Prefer explicit migration boundaries over silent user-config rewrites
- Keep published documentation portable: use `~`, `<repo>`, or relative paths instead of machine-local absolute paths
- Preserve runtime output discipline because tool output flows directly into agent context

## Durable Conventions

- `Tool registry source`: `~/.pi/agent/auto-tools.json` is the persistent user config | Trigger: Any runtime registration or migration work | Action: Preserve atomic writes and avoid hidden format changes without an explicit compatibility path
- `Current runtime contract`: v0.3.0 registers trusted command templates with tool names from registry keys, placeholder-derived args, inline/default config fallback, split-first command-arg construction, optional sequential composition, direct no-shell execution, and `{file}` as the canonical local file path arg | Trigger: Changing registration or invocation behavior | Action: Keep README, command-template docs, implementation, and migration notes aligned
- `Template migration boundary`: v0.2.0 replaces `script` with `template` as a breaking change | Trigger: Loading or editing persisted config | Action: Reject legacy `script` entries explicitly and do not silently rewrite user config outside the repo
- `Reserved tool names`: Built-in or core tool names must not be shadowed | Trigger: Adding or renaming registration logic | Action: Keep conflict checks before persistence and runtime registration
- `Output discipline`: Tool stdout is returned with bounded context impact | Trigger: Changing execution or formatting | Action: Keep tail truncation, full-output temp files, and failure formatting intact
- `Context sync`: Meaningful implementation or docs changes must reconcile `BACKLOG.md`, `CHANGELOG.md`, README, and docs navigation | Trigger: Closing, narrowing, or discovering work | Action: Run the context validator before final status when practical
- `Public path hygiene`: Published docs must not include machine-local absolute paths | Trigger: Adding validation commands, examples, or local instructions to README/AGENTS/docs/changelog | Action: Use `~/.pi/...`, `<repo>/...`, `${SKILL_DIR}/...`, or relative paths

## Validation

- `npm run check`: Lightweight extension-load sanity check
- `npm test`: Focused regression tests for extracted pure domains
- `npm run pack:dry`: Verify package contents and npm metadata
- `bash ~/.pi/agent/skills/evolve-context/scripts/validate-context.sh`: Validate context split, links, and README/docs reachability

## Pre-Task Preparation

1. Read this file, `BACKLOG.md`, and `README.md`
2. Inspect `index.ts` around the touched tool/runtime path
3. Prefer targeted edits over broad rewrites
4. Run the smallest validation set that covers the touched scope

## Task Completion Protocol

1. Reconcile backlog state with reality: close, narrow, split, defer, or gate items explicitly
2. Update README/docs when public behavior, setup, package contents, or navigation changes
3. Record meaningful delivered slices in `CHANGELOG.md`
4. Run relevant validation and report exact commands
