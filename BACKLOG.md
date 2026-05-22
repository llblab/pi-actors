# Project Backlog

## Open Work

No open release-blocking work remains for `0.15.0`.

The former active tracks are now release-ready:

- Universal actor communication: public guidance centers `spawn`, `message`, `inspect`, actor messages, mailbox contracts, and artifacts; low-level lifecycle/storage wording is confined to implementation/diagnostic docs.
- Component parameterization and composition: packaged recipes are policy-light, require caller-provided model/model-pool policy, expose reusable knobs, validate imports/mailboxes, and are covered by the actors Recipe Navigator.
- Structured utility transforms: current utility surface is sufficient for shipped pipelines; add future utilities only when a repeated packaged-pipeline need appears.

## Future Work

- Add new utilities or pipelines only when a concrete repeated task pattern justifies them.
- Continue opportunistic actor-vocabulary cleanup when touching implementation docs or diagnostics.

## Blocked Work

### Branch-Local Checkpoint Semantics

- Priority: Low.
- Blocked by: At least one real collaborative branch-runner async-run experiment.
- Scope: Validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are enough for branch-local validation and bounded reattempts.
- Exit: Record one decision: sufficient, documentation-only refinement needed, or propose one minimal command-template extension with tests.
