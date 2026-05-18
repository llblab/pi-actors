# Project Backlog

## Open Work

- Add command-template trust/safety guidance and lightweight risk warnings.
  - Priority: Medium.
  - Scope: Document that shell-free argv construction protects placeholder interpolation but does not sandbox trusted executables; detect and surface warnings for obvious interpreter-risk templates such as `bash`, `sh`, `node -e`, `python -c`, and broad filesystem commands.
  - Exit: Docs explain the trust boundary, tests cover warning detection, and runtime/tool details can show high-risk-template warnings without blocking existing tools.
