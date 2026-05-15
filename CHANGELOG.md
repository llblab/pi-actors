# Changelog

## Unreleased

No unreleased changes.

## 0.5.6: Coordinator-Scoped Job Notifications Hotfix

- `[Job Observability]` Scoped async job ambient status and terminal follow-up context to the agent session that started the job. Impact: multiple pi agents sharing the same job state root can run independent async jobs without receiving each other's completion messages or sub-agent indicators, while explicit `status`/`tail` inspection by job id remains available.
- `[Template Jobs]` Added `template_job action=kill` as a forceful `SIGKILL` escape hatch for stuck owned job runners, with the same cwd/runner ownership checks as graceful `cancel`. Impact: operators can recover from unresponsive detached jobs without unsafe broad process killing.
- `[Release]` Added a tag-triggered GitHub Actions release workflow that verifies the `vX.Y.Z` tag matches `package.json`, extracts the matching `CHANGELOG.md` section, and publishes a GitHub Release automatically.
- `[Backlog]` Clarified that typed command-template argument declarations must be progressive: current untyped `args` declarations continue to work unchanged while typed forms are added.

## 0.5.5

- `[Template Job Shape]` Allowed job recipe files to place command-template node flags such as `mode`, `timeout`, `retry`, `critical`, `args`, and `defaults` at the job top level beside `job`. Impact: parallel jobs can use the compact shape `{ "job": "name", "mode": "parallel", "template": [...] }` without an unnecessary nested template wrapper.
- `[Template Job Defaults]` Clarified that `state_dir` is optional and defaults to the extension job-state directory derived from the job id. Impact: recipe files only need `job` and `template` unless they intentionally override state placement.
- `[Command Template Repeat]` Added `repeat` expansion with zero-based `{index}`, wrapped zero-based `{prev}`/`{next}`, `{repeat}`, underscore-padded forms such as `{_index}`, and limited arithmetic expressions such as `{_(index+1)}`. Impact: repeated parallel or sequence templates can be written once instead of copy-pasting near-identical branches while keeping human numbering explicit.

## 0.5.4

- `[Co-located Job Recipes]` Allowed registered tool entries to include job envelope fields directly when they also define `template`. Impact: operators can keep small or local job recipes in `auto-tools.json` without introducing `job.tool` cycles or a separate recipe file.
- `[Job Recipe Args]` Derived tool args from available file-backed and co-located job recipe templates when `args` is omitted. Impact: job recipes keep the same optional `args`/`defaults` behavior as command templates while explicit `args` remains an override.
- `[Docs]` Split the synchronous Command Template Standard from the async Template Job Standard. Impact: command templates remain portable and backwards-compatible across extensions, while jobs are documented as an optional async extension.

## 0.5.3

- `[Job Recipe References]` Replaced registered-tool `job` bindings with `template` job recipe references. Impact: the registry has one executable binding field, job files must own a `template`, and job recipes can no longer point back to tools.
- `[Runtime Boundary]` Enforced the `tool → template → job → template` graph across runtime, docs, and tests. Impact: jobs stay lightweight async envelopes, cyclic shortcuts such as `tool.job` and `job.tool` are rejected, and job recipe tools keep their public args explicit.

## 0.5.2

- `[Job Launch Tools]` Added job-backed registered tools. A tool may now define `job` instead of `template`; calling it starts the named template-job recipe asynchronously and returns job metadata. Impact: heavyweight agent fanout can keep `template(mode: "parallel")` inside `~/.pi/agent/jobs/*.json` while exposing a compact callable tool.
- `[Docs]` Documented the `tool → job recipe → template(mode: "parallel")` model across README and adapter docs. Added compact operator onboarding and the `task` vs `template` vs `job` distinction. Impact: job recipes can become the source of truth for async agent scenarios instead of duplicating large templates in tool definitions, and new operators get the job mental model without reading every subsystem note.

## 0.5.1

- `[Job Observability]` Made detached job status triangles use runner-reported active command counts across all running jobs instead of only process-tree probing. Impact: async parallel jobs keep stable per-sub-agent indicators while work is active, with the animation wave moving across the current aggregate set.
- `[Docs]` Clarified that template jobs own async lifecycle and ambient sub-agent visibility, while command templates still own sequence and parallel execution shape. Impact: agentic fanout should use `job(template(mode: "parallel"))` instead of blocking foreground orchestration.

## 0.5.0

- `[Command Templates]` Added `mode` for template object nodes, with `sequence` as the default and `parallel` for concurrent child execution. Object-form examples and persisted tool entries now keep `template` last, with regression coverage for serialization order. Parallel nodes now expose soft-quorum branch labels, statuses, and coverage details. Added compact per-node `delay` in milliseconds for launch pacing without scheduler semantics. Impact: one `template` property now describes sequential and parallel command trees with stable flag-first reading, graceful degradation, optional staged launch, and no separate workflow DSL.
- `[Template Jobs]` Added the unified `template_job` action tool for detached template job lifecycle: start, status, tail, list, and cancel. Jobs use state files, log files, a thin runner process, and stale-state cancellation guardrails. `template_job action=start` can start from a template job JSON file, an inline command template, or a registered auto-tool name. Job state now defaults to `~/.pi/agent/tmp/pi-auto-tools/jobs` and stale temp entries are pruned on session start. Impact: Swarm-style async orchestration can move generic process observation into pi-auto-tools while domain quorum semantics stay in Swarm.
- `[Job Observability]` Added ambient interactive UI status for active sub-agent count and compact completion events for detached jobs. Removed persistent prompt-area widgets and done/exited counters. The running indicator now shows one `▷` per concrete sub-agent with a faster moving dim `▶` wave, single-subagent blink, and a late-sorting status key. Impact: long-running swarms are visible while active, then become actionable context only when they finish.
- `[Command Template Standard]` Folded template job and temp-directory primitives into `docs/command-templates.md`; `docs/job-primitives.md` is now the pi-auto-tools adapter note. Impact: the portable standard is self-contained and consumers point inward instead of chaining across external standards.
- `[Template Job Library]` Added `~/.pi/agent/jobs/*.json` as the reusable template job library. Kept reusable recipes as documentation guidance instead of packaged root files because model and tool names are local policy. Impact: async recipes can be reused compactly without expanding tool config or shipping operator-specific examples.
- `[Registry Tools]` Made `register_tool` callable without args to return a compact list of registered auto-tools. Impact: agents can inspect the extension registry without reading `auto-tools.json` directly.
- `[Registry Activation]` Made every successful `register_tool` call activate all registered auto-tools in the current session. Impact: registered tools stay fresh and callable immediately after list, register, update, or delete operations.
- `[Release Validation]` Added `npm run validate` for CI and release checks. Impact: TypeScript, extension import, tests, and dry-run packing are available through one command.
- `[Docs]` Reworked README and job docs around a compact mental model: command, command template, registered tool, template job. Impact: the new async job concept is easier to explain without implying a scheduler or second workflow language.

## 0.4.0

- `[Command Templates]` Prepared the 0.4.0 runtime profile for the current portable command-template contract: default 30s command timeout, per-step retry propagation, fail-open composition for non-critical failures, and `critical: true` abort semantics. Impact: registered auto-tools now behave like the reference command-template handler profile used by `pi-telegram`.
- `[Docs]` Cleaned the backlog and synchronized README plus command-template docs with the strengthened 0.4.0 contract. Impact: release notes, open work, and user-facing runtime semantics now describe the same behavior.

## 0.3.0

- `[Architecture]` Renamed the command-template domain from `lib/templates.ts` to `lib/command-templates.ts`, made it byte-identical to the shared `pi-telegram` implementation, and moved auto-tools-specific arg/schema helpers into `lib/schema.ts`. Impact: the portable standard stays copyable while registry-specific schema derivation remains local.
- `[Command Templates]` Migrated runtime helpers to the current shared command-template standard: string shorthand configs, inline `{arg=default}` defaults, derived tool args, missing-value errors, relative executable expansion, sequence expansion, direct execution with stdin, and timeout escalation. Impact: `pi-auto-tools` now matches the `pi-telegram` command-template regression surface, loads current inline-default `auto-tools.json` entries without `name`/`label`/`args`/`defaults`, and can run multi-step template-backed tools.
- `[Registry]` Canonical persisted object entries now omit redundant `name` and `label`; object keys supply tool names, and runtime labels derive from tool names. Impact: `auto-tools.json` follows the command-template standard more closely while legacy `name`/`label` fields are accepted and normalized away.
- `[Docs]` Harmonized the portable command-template standard wording with `pi-telegram`, using `template`/`args`/`defaults`, command-arg terminology, and `{file}` as the canonical local file path arg. Impact: both extensions now describe the same integration contract without `argv`, `command`, or `{filename}` ambiguity.

## 0.2.1

- `[Docs]` Split command-template documentation into a portable standard core (`docs/command-templates.md`) and local registry adaptation (`docs/tool-registry.md`). Impact: the shared command-template contract can be copied across extensions without coupling their internals, while `pi-auto-tools` keeps its registry storage shape documented separately.

## 0.2.0

- `[Breaking Registry]` Replaced script-backed persistent tools with template-backed command registration. Tools now store `template`, named `args`, and optional `defaults`; legacy stored `script` entries are rejected with explicit migration guidance.
- `[Command Templates]` Standardized split-first invocation: templates are split into shell-like argv tokens before placeholder substitution, then executed through `pi.exec` without shell evaluation. Placeholder values containing spaces remain single argv values.
- `[Register Tool]` Updated `register_tool` to create, update, and delete template-backed tools, preserve existing templates on metadata/default updates, block reserved/external conflicts, persist atomically, and register tools immediately for the active session.
- `[Runtime Output]` Preserved bounded context output for registered tools: stdout is formatted for the agent, large outputs are tail-truncated, full output is saved to temp files, and command failures include useful stderr/stdout sections.
- `[Architecture]` Refactored the extension into a flat `/lib` Domain DAG with `index.ts` as a small namespace-domain composition root. Core domains now cover templates, args/identity, config, registry mutations, runtime coordination, tool definitions, output, prompts, paths, and execution.
- `[Packaging & Validation]` Removed the runtime `typebox` dependency from schema assembly, made `npm run check` import the extension entrypoint, added focused domain and architecture-guard tests, and verified package contents with dry-run packing plus live post-reload smoke.
- `[Docs]` Added command-template documentation as a portable standard, condensed README into a feature/usage format, documented skill-script and sub-agent registration examples alongside their resulting `auto-tools.json` state, documented `{file}` as the canonical local file path placeholder, and reset `BACKLOG.md` after all open work reached validated stop conditions.

## 0.1.1

- `[Registry]` Shipped the script-backed persistent tool registry. Impact: pi can register, update, delete, persist, and auto-load trusted local script tools from `~/.pi/agent/auto-tools.json`.
