# Project Backlog

## Open Work

Continue progressive component/pipeline expansion in small validated slices; real smoke runs remain gated. Prefer task-first design for new high-level recipe families: start from operator/coordinator work patterns, then derive missing component cells.

- Plan organic universal communication primitives.
  - Priority: High.
  - Status: The actor-like model is empirically useful: async runs can emit follow-up messages upward, coordinators can send run-local commands downward, multiple parallel runs can progress independently, and recipes no longer need sleep-poll coordination. The design is captured in `docs/actor-messages.md`: `spawn`, `message`, and `inspect` as concentrated verbs; addressed actors; one symmetric message envelope; mailbox `accepts`/`emits`; and adapter mappings from low-level async actions. Initial implementation landed pure actor address/message normalization plus public `spawn`, `message`, and `inspect` tools for `run:<id>` actors; `spawn` accepts state/artifact metadata, `message` routes `run:<id>` → `coordinator` envelopes into the run delivery path, `message` can invoke `tool:<name>` actors, all packaged async recipes declare mailbox metadata, `inspect view=mailbox` exposes recipe mailbox contracts from run metadata, and recipe-authored messages now use envelope-aligned `type` fields with deterministic validated wrapping available through `utility-actor-message`. Remaining work is to continue docs/examples/recipe migration toward actor vocabulary and decide which low-level async compatibility surfaces stay public.
  - Scope: Design and implement a small semantic layer around addressed messages and actors while preserving low-level primitives as adapters where useful. Candidate top-level concepts are `spawn` for creating an actor/run from a recipe or template, `message` for sending typed messages to any address, and `inspect` for intentional observation/debugging. Candidate addresses include `run:<id>`, `branch:<run>/<branch>`, `coordinator`, `session:<id>`, `tool:<name>`, and future chat/session endpoints. Candidate message fields include `to`, `from`, `type`, `summary`, `body`, `delivery`, `reply_to`, `correlation_id`, and `metadata`.
  - Contract direction: Unify “send down” and “messages up” as one message model. `to: run:<id>` routes to a run mailbox, `to: coordinator` routes to the current follow-up delivery path, and branch/tool/session addresses can be layered over the same semantic envelope. Recipes should declare mailbox capability (`accepts`, `emits`, delivery defaults) without exposing FIFO/outbox mechanics as their public interface.
  - Design gates: Breaking changes are allowed in this phase, so compress concepts instead of preserving accidental surfaces. Consolidate duplicated lifecycle/message/event APIs into a concentrated protocol with the fewest durable nouns and verbs that still explain the system. Duplex communication should be symmetric where the domain is symmetric: the same message envelope should represent run→coordinator, coordinator→run, run→run, branch→parent, and parent→branch traffic, with routing/transport hidden below it. Keep command templates as the portable synchronous execution graph; keep recipe files as semantic definitions; avoid leaking transports into public args; make polling an explicit diagnostic operation, not an example path; decide whether low-level `async_run` action names remain compatibility shims or are replaced by the actor API.
  - Exit: The project exposes documented high-level universal communication primitives for starting work, sending messages, and inspecting state; packaged recipes/examples use the organic interface; async send/outbox behavior is covered by compatibility tests or intentionally migrated; all recipes validate and docs describe the actor/message model clearly.

- Progressively increase component parameterization and higher-level recipe composition.
  - Priority: High.
  - Scope: Iteratively strengthen atom/component recipes with public policy knobs such as model pools, stage-specific models, thinking, tool policy, output format, evidence policy, risk policy, source policy, artifact paths, event delivery, handoff format, resume/continuity policy, and validation gates; add higher-level component recipes that compose existing atoms into reusable coordinator patterns.
  - Exit: Each iteration adds or refines at least one atom-level parameterization surface and at least one composed recipe/pipeline, with packaged recipe import validation passing and docs/changelog updated.

- Add another task-first high-level pipeline candidate from the design map.
  - Priority: Medium.
  - Status: `pipeline-release-readiness`, `pipeline-repo-health`, `pipeline-async-run-ops`, `pipeline-docs-maintenance`, and `pipeline-media-library` landed. `pipeline-media-library` required playlist output-mode parameterization, then reused playlist and artifact-report cells.
  - Scope: Reassess `docs/task-first-recipes.md` for the next high-value task cell, then implement only the minimum missing cells needed for that task.
  - Exit: Another task-first pipeline lands with docs, package validation, and a note about which missing atoms/utilities it required.

- Grow the standard recipe library with safer structured utility transforms.
  - Priority: Low.
  - Status: `utility-artifact-manifest` landed for machine-readable artifact metadata; `utility-artifact-write` landed for deterministic writes of accepted prepared artifacts; `utility-package-summary` landed for bounded package metadata used by release/repo-health flows; `utility-validate-recipe` landed with a dedicated recipe validator script.
  - Scope: Continue beyond listing/extraction utilities toward structured transforms for artifact packaging, report normalization, release prep, and machine-readable summaries. Keep helpers generic, parameterized, and justified by repeated recipe needs.
  - Exit: A future utility slice adds another structured transform only when a repeated recipe need appears; otherwise treat the current helper-backed utility surface as sufficient.

## Blocked Work

- Validate branch-local checkpoint semantics with collaborative-runner experiments.
  - Priority: Low.
  - Blocked by: At least one real collaborative branch-runner async-run experiment.
  - Scope: Use real collaborative branch-runner async runs to validate whether `failure: "branch"`, node-level `retry`, and `recover` cleanup are sufficient for branch-local validation and bounded reattempts.
  - Exit: Decision recorded as sufficient, documentation-only refinement needed, or propose a further minimal command-template extension with tests.
