# Project Backlog

## Open Work

- Add command-template trust/safety guidance and lightweight risk warnings.
  - Priority: Medium.
  - Scope: Document that shell-free argv construction protects placeholder interpolation but does not sandbox trusted executables; detect and surface warnings for obvious interpreter-risk templates such as `bash`, `sh`, `node -e`, `python -c`, and broad filesystem commands.
  - Exit: Docs explain the trust boundary, tests cover warning detection, and runtime/tool details can show high-risk-template warnings without blocking existing tools.

## Completed

- [x] Add typed command-template argument declarations.
  - Exit: Parser, registry normalization, generated tool schemas, runtime validation/normalization, and docs support compact typed forms such as `file:path`, `out_dir:path`, `timeout:int=60000`, `speed:number=1.5`, `dry_run:bool=true`, and `mode:enum(check,fix)=check` without introducing JSON Schema as the authoring format; untyped current `args` declarations continue to work unchanged.

- [x] Scope async job completion notifications to the launching agent session.
  - Exit: Jobs started through `template_job` or job-launch tools persist the launching session owner, ambient job summaries and terminal follow-up notifications are filtered to that coordinator, and explicit `status`/`tail` inspection by job id remains available.

- [x] Complete 0.5.2 onboarding and task/job mental-model documentation.
  - Exit: README now includes a compact operator onboarding path, job docs define `task` vs `template` vs `job`, registered tools support the `tool → template → job → template` model, and docs describe launcher tools.
