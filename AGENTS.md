# Project Context

## Meta-Protocol Principles

- `Constraint-Driven Evolution`: Add structure when real project constraints justify it
- `Single Source of Truth`: Keep durable protocol, open work, completed delivery, and docs in separate files
- `Context Hygiene`: Compress stale context before it becomes coordination drag
- `Boundary Clarity`: README is the human entrypoint, `AGENTS.md` is durable protocol, `BACKLOG.md` is open work, and `CHANGELOG.md` is delivery history

## Concept

`pi-auto-tools` is a local-first, cybernetic automation layer for pi. It persists user/agent-registered tools in `~/.pi/agent/auto-tools.json` and registers them automatically across sessions, giving agents durable operational muscle memory for trusted local commands, scripts, recipes, and async runs. Treat it as MCP-adjacent local capability creation: the agent can create and refine its own tools instead of depending only on external tool servers.

## Topology

- `/index.ts`: Minimal extension coordinator/composition root; it wires live pi ports and should avoid owning domain behavior
- `/lib/*.ts`: Flat Domain DAG modules for cohesive reusable behavior; `command-templates.ts` mirrors the shared portable command-template standard, `schema.ts` owns auto-tools arg declarations and placeholder-derived tool schemas, `identity.ts` owns names, `config.ts` owns config persistence, `registry.ts` owns registry register/update/delete use-cases, `output.ts` owns result formatting/truncation, `execution.ts` owns registered-tool execution, `recipe-references.ts` owns template recipe reference detection and path resolution, `async-runs.ts` owns async run state, `observability.ts` owns ambient run summaries, `temp.ts` owns pi-agent temp cleanup, `prompts.ts` owns LLM-facing copy, `tools.ts` owns pi-facing tool definitions for both `register_tool`, async run primitives, and generated runtime tools, `runtime.ts` owns load/conflict/registration coordination, and `paths.ts` owns config/tmp path resolution
- `index.ts` should import local domains as namespaces (`import * as CommandTemplates from "./lib/command-templates.ts"`) so orchestration reads through domain names instead of flat helper imports
- `/scripts/*.mjs`: Thin helper processes for detached async run execution; keep policy in registered tool config and reusable logic in `/lib`
- `/examples/recipes/*.json` and `/examples/scripts/*`: Experimental local recipe examples; keep them optional and policy-light; prefer public args/defaults for operator/agent decisions instead of baking project-specific prompts or file names into reusable recipes
- `/tests/*.test.ts`: Focused regression tests for pure domains
- `/README.md`: Human-facing install, usage, and runtime semantics
- `/BACKLOG.md`: Canonical open work; keep it empty when no actionable or gated work remains
- `/CHANGELOG.md`: Completed delivery history
- `/docs/README.md`: Documentation index

## Operating Principles

- Prefer explicit migration boundaries over silent user-config rewrites
- Keep published documentation portable: use `~`, `<repo>`, or relative paths instead of machine-local absolute paths
- Preserve runtime output discipline because tool output flows directly into agent context
- Keep the project lens local-first and cybernetic: agents create durable local capabilities, then use semantic tools instead of repeatedly reconstructing shell commands
- Design recipes as agent-callable tools: make prompts, scopes, paths, models, and policy knobs public args/defaults when the caller should decide them at invocation time

## Durable Conventions

- `Tool registry source`: `~/.pi/agent/auto-tools.json` is the persistent user config | Trigger: Any runtime registration or migration work | Action: Preserve atomic writes and avoid hidden format changes without an explicit compatibility path
- `Current runtime contract`: v0.7.0 registers trusted command templates with tool names from registry keys, placeholder-derived args, progressive typed arg declarations, inline/default config fallback, split-first command-arg construction, sequential or `mode: "parallel"` composition, direct no-shell execution, optional per-node positive `timeout` disabled by default, lightweight warnings for obvious trusted-executable risk shapes, per-node `delay`, bounded leaf/node `retry`, `failure: "continue|branch|root"` propagation, `recover` cleanup between retry attempts, template recipes with explicit `async: true` detached mode, one `async_run` action tool with run-local JSONL outbox events, Unix FIFO send, graceful cancel, and force kill, generic detached run primitives with process-group cancellation, injected async `{run_id}` and `{state_dir}` values, coordinator-scoped observability with at least one triangle per running async run plus additional runner-reported active branches, terminal follow-up context, `template` recipe references, recipe-layer `imports`, co-located recipe entries, `~/.pi/agent/recipes/*.json` template recipe files, run state under `~/.pi/agent/tmp/pi-auto-tools/runs`, and `{file}` as the canonical local file path arg | Trigger: Changing registration or invocation behavior | Action: Keep README, command-template docs, template-recipe docs, async-run docs, implementation, and migration notes aligned
- `Typed arg authoring`: Typed args support `string`, `path`, `int`, `number`, `bool`, and `enum(...)` plus two equivalent readability styles: metadata-first (`args` + `defaults` + simple `{name}` placeholders) for long command lines, and inline-first (`{name:type=default}` placeholders) for compact one-property templates | Trigger: Changing arg parsing, docs, schema generation, or registry serialization | Action: Preserve both styles, keep explicit `args` type declarations higher priority than inline placeholder types, and keep untyped args/placeholders backward-compatible
- `Template recipe graph`: The valid execution chain is `tool → template → recipe → run → template`; file-backed and co-located recipes are storage variants of that chain | Trigger: Adding registry bindings, recipes, docs, or runtime shortcuts | Action: Keep command templates synchronous and portable, use `async: true` as the detached run switch, require every recipe to own `template` directly, and reject cyclic shortcuts such as recipe-owned `tool`
- `Layer boundary discipline`: Command-template evolution must be separated from template-recipe configuration and async-run lifecycle configuration | Trigger: Adding syntax, placeholders, imports, async controls, or docs | Action: Put portable execution graph semantics in `docs/command-templates.md`, recipe storage/import/default/reference behavior in `docs/template-recipes.md`, and detached lifecycle/state/IPC behavior in `docs/async-runs.md`; type imported recipes as command-template-shaped recipe definitions, not async-run instances
- `Executable script recipes`: Recipe templates may point directly at executable helper scripts, including JavaScript `.mjs` files with shebangs; do not prefix such examples with `node` unless the script is intentionally not executable | Trigger: Adding or editing example recipes and docs | Action: Keep the script executable bit, call `{repo}/examples/scripts/name.mjs ...` directly, and document that shell and JavaScript wrappers are both direct executable targets
- `Template migration boundary`: v0.2.0 replaces `script` with `template` as a breaking change | Trigger: Loading or editing persisted config | Action: Reject legacy `script` entries explicitly and do not silently rewrite user config outside the repo
- `Reserved tool names`: Built-in or core tool names must not be shadowed | Trigger: Adding or renaming registration logic | Action: Keep conflict checks before persistence and runtime registration
- `Output discipline`: Tool stdout is returned with bounded context impact | Trigger: Changing execution or formatting | Action: Keep tail truncation, full-output temp files, and failure formatting intact
- `Extension temp directory`: Temporary runtime files belong under `~/.pi/agent/tmp/pi-auto-tools`; session start prepares the directory and prunes stale entries | Trigger: Adding temp files, run state, logs, or artifacts | Action: Do not use system tmp for extension-owned state unless the operator explicitly overrides a path
- `Context sync`: Meaningful implementation or docs changes must reconcile `BACKLOG.md`, `CHANGELOG.md`, README, and docs navigation | Trigger: Closing, narrowing, or discovering work | Action: Run the context validator before final status when practical
- `Public path hygiene`: Published docs must not include machine-local absolute paths | Trigger: Adding validation commands, examples, or local instructions to README/AGENTS/docs/changelog | Action: Use `~/.pi/...`, `<repo>/...`, `${SKILL_DIR}/...`, or relative paths

## Validation

- `npm run check`: Lightweight extension-load sanity check
- `npm test`: Focused regression tests for extracted pure domains
- `npm run pack:dry`: Verify package contents and npm metadata
- `bash ~/.pi/agent/skills/abcd-context/scripts/validate-context.sh`: Validate context split, links, and README/docs reachability

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
