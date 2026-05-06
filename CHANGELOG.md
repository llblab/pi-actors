# Changelog

## Unreleased

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
