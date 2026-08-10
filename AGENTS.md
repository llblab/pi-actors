# Project Context

## Meta-Protocol Principles

- `README.md`: human product entrypoint.
- `AGENTS.md`: durable implementation protocol.
- `BACKLOG.md`: canonical future-only work.
- `CHANGELOG.md`: completed delivery history.
- `docs/README.md`: documentation index.

Keep these surfaces distinct and reconcile them after meaningful changes.

## Concept

`pi-actors` is a local Run kernel and persistent capability registry for Pi:

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

An actor is any runnable local capability, including a script, tool, service, pipeline, or subagent. Recipes define actors' reusable execution. Runs are concrete actor instances and own one generation of execution and evidence. Trace owns observations. Control owns actor-local inputs for services that actually consume them. `register_tool` persists capabilities separately.

Public Run verbs remain `spawn`, `message`, and `inspect`.

## Core Structure

```text
Pi host
  -> index.ts                         composition root
     -> lib/tools*.ts                 public tool adapters
     -> lib/runtime.ts / registry.ts  active user Recipe tools
     -> lib/recipes-*.ts              Recipe resolution/evolution
     -> lib/async-runs.ts             Run lifecycle facade
     -> lib/runs-*.ts                 focused lifecycle/evidence domains
     -> lib/observability.ts          terminal + Trace-attention observation
     -> lib/inspector*.ts             owner-filtered actor-instance inspection
     -> scripts/*.mjs                 process/service entrypoints
     -> recipes/*.json                packaged Recipe library
     -> skills/* + docs/*             agent and human guidance
```

`index.ts` wires Pi ports and must not own domain behavior. Keep the local TypeScript import graph acyclic.

## Key Domains

- `command-templates.ts`: portable synchronous execution graph.
- `recipes-references.ts`, `recipes-discovery.ts`, `recipe-control.ts`: Recipe resolution, imports, shadowing, and Control declarations.
- `async-runs.ts`: lifecycle facade.
- `runs-start.ts`, `runs-status.ts`, `runs-control.ts`, `runs-control-delivery.ts`, `runs-controls.ts`, `runs-trace.ts`, `runs-process.ts`, `runs-retention.ts`, `runs-parent-teardown.ts`: focused Run internals.
- `execution-sessions.ts`, `trace-projection.ts`, `session-evidence.ts`: bounded/redacted execution and inspection evidence.
- `tools-message.ts`: exact Control facade.
- `tools-inspect.ts`: exact `run:<id>`, `runtime`, `recipes`, and `tool:<name>` inspection.
- `tools-spawn.ts`, `tools-register.ts`, `tools-local.ts`, `tools-response.ts`: Run creation, persistent capabilities, Recipe-backed tools, and compact results.
- `inspector.ts`, `inspector-overlay.ts`, `inspector-command.ts`, `inspector-actions.ts`: actor-instance Recipe/Trace/Control projection, navigation, command wiring, and fenced actions. **Actor Inspector** remains the product and command name, not a separate domain.
- `observability.ts`, `runtime-notifier.ts`, `run-ui-runtime.ts`: Trace attention, terminal reconciliation, and Pi follow-up delivery.
- automatic draft/tool review domains: structurally redacted model review, journaled mutation, lineage, recovery, and explicit retry/reset safety.

Scripts remain self-contained when no non-script consumer justifies a TypeScript domain. Recipes stay optional, composable, policy-light, and caller-configurable.

## Operating Principles

### Recipe

- Recipe files may define args/defaults, imports, artifacts, command-template flags, and `control`.
- Declare actor-local actions only when a long-lived process implements them.
- Actions are lowercase, unique, and cannot use runtime-reserved lifecycle names.
- Removed communication-plane metadata fails explicitly; never translate it.
- User Recipes shadow packaged definitions; invalid shadowing blocks fallback.
- Files over 1 MiB, import depth over 32, and import cycles fail closed.

### Trace

Canonical event:

```json
{"id":"…","ts":"…","kind":"…","summary":"…","data":{},"level":"info","attention":"notify"}
```

Keep events bounded and free of addressing/routing fields. Use artifacts or execution captures for large evidence. `attention: "followup"` must remain rare and semantically justified.

### Control

Public shape:

```json
{"target":"run:<id>","action":"…","input":{},"verbose":false}
```

Persist Control before transport. Fence every record and endpoint with immutable `run_instance_id`; controlled services capture that generation at startup. Serialize atomic journal replacement through token-owned dead-process-reclaiming locks, and keep status transitions expected-state-fenced and monotonic when consumers complete before producer delivery evidence. FIFO and named pipe are transport details, not public concepts; constrain FIFO documents to the portable atomic-write bound, reject partial writes, and keep FIFO readers gap-free across writers. Revalidate owner, generation, state, and process identity under the lifecycle lock immediately before delivery.

Runtime lifecycle and review actions remain runtime-owned.

### Inspect

Run views are exactly `recipe`, `trace`, and `control`. Non-Run management targets are `runtime`, `recipes`, and `tool:<name>`. Apply owner filtering and redaction before projecting evidence.

## Retained Safety Invariants

Never weaken:

- owner filtering;
- immutable generation fencing;
- cross-platform process identity checks;
- canonical lifecycle locks and same-directory restart serialization;
- shutdown and parent-teardown kill;
- terminal notification reconciliation and handled/failure evidence;
- bounded logs, complete captures, and tool output;
- owned Pi session provenance;
- path containment, canonical ownership markers, and symlink rejection;
- redaction of secrets and machine-local paths;
- automatic review admission, CAS, journaling, quarantine, lineage, retry, and reset safety.

Lifecycle operations fail closed when identity, ownership, or generation cannot be proven. Do not directly signal processes from UI code or edit active Run state to force outcomes.

## Registry and Evolution

`~/.pi/agent/recipes/*.json` is executable capability memory. Preserve filename identity, atomic writes, canonical per-path locks, explicit operator-gated changes, and transportability.

Automatic review receives value-free structural projections, not executable content, paths, prose, canonical names, or secrets. Deterministic executors derive unchanged Recipes from trusted captures. Approved mutation must journal intent before mutation and roll forward safely after crashes.

`PI_ACTORS_AUTOMATIC_REVIEW=off` disables scheduling and safe-boundary activation while remaining visible in runtime status.

## Output and Observability

Tool result/error text contributes exactly one leading line break. Keep model-facing responses compact and state-backed. Preserve complete byte-exact command streams in bounded spill files while returning bounded tails; never feed truncated tails into pipeline stdin.

File watchers accelerate reconciliation; a bounded terminal-only interval recovers missed events. Terminal follow-ups contain only Run id, status, one base path, and relative artifact names in visible content; semantic details remain structured. Delivery remains honestly at-least-once across the send/handled-marker crash window.

When a deferred Run result gates the next step, wait for its terminal follow-up. Inspect early only for operator request, meaningful attention, or diagnosis of an overdue Run.

## Documentation and Release Discipline

- Keep published text portable: use `~`, `<repo>`, or relative paths.
- Update `skills/actors/SKILL.md` when durable operating mechanics change.
- Keep `skills/swarm/SKILL.md` focused on multi-agent methodology rather than kernel internals.
- Before release run build, full tests, preservation tests, Recipe QA, Domain DAG validation, ABCd context validation, line-count gates, and release gates.
- Until a stable version beyond `1.x`, prefer clean breaking simplification over compatibility aliases or renamed legacy abstractions.
