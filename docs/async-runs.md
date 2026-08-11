# Runs

A Run is one detached execution instance:

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

## Creation

`spawn` accepts a Recipe/file or inline command template and optional values, Run id, transport context, and artifact declarations. The runtime resolves the Recipe, validates typed values and current policy placeholders, claims the state directory, creates a new immutable `run_instance_id`, captures process identity, starts the runner, and appends `run.start` Trace.

A reused state directory fails while its prior generation remains active. Restart cleanup removes stale terminal state before the new generation starts.

## Identity and Ownership

Each Run persists:

- safe Run id and state path;
- current Pi owner id;
- immutable `run_instance_id`;
- process id plus captured process identity;
- launch source and tool-call provenance;
- captured Recipe/template/values;
- model and thinking policy provenance.

Inspection, Control, cancellation, kill, retirement, and teardown filter by owner. Lifecycle mutations revalidate generation, state, and process identity under the canonical lock.

## State Files

```text
run.json
trace.jsonl
controls.jsonl
control-endpoint.json       controlled services only
execution.json
progress.json
result.json
stdout.log
stderr.log
terminal.json               terminal lifecycle evidence
terminal-notification.json  reconciliation evidence
diagnostics.jsonl
<declared artifacts>
```

`run.json` carries `state_schema: "run-kernel-v1"`. New Runs do not create communication-plane state.

## Trace

Trace records strict bounded events:

```json
{"id":"…","ts":"…","kind":"command.done","summary":"Command completed","data":{"code":0},"level":"info","attention":"followup"}
```

Required fields: `id`, `ts`, `kind`. Optional fields: `summary`, `data`, `level`, `attention`. Trace rejects addressed-envelope fields and malformed or oversized data. All first-party writers use the canonical append authority, which validates and size-checks inside a token-owned cross-process lock before one append-only JSONL write.

Runtime lifecycle, runner progress, command completion, cancellation, kill, parent teardown, and controlled-service observations use Trace. `inspect view=trace` projects these events with Controls, owned Pi turns, logs, results, artifacts, and diagnostics under a deterministic global bound.

## Control

A Recipe declares actor-local actions only when its process consumes them:

```json
{"control":["pause","resume","stop"]}
```

Public request:

```json
{"target":"run:player","action":"pause","input":{"reason":"operator"},"verbose":false}
```

The runtime:

1. acquires the lifecycle lock;
2. revalidates owner, `run_instance_id`, running state, and process identity;
3. appends a queued generation-bound record to `controls.jsonl`;
4. resolves a matching ready endpoint from `control-endpoint.json`;
5. writes the exact `{id, action, input?}` wire document to FIFO or named pipe;
6. records delivered or failed outcome.

Unix services may publish a FIFO; native Windows services publish a Windows named pipe. Native Windows FIFO delivery fails before transport rather than degrading to another protocol. Both transports admit the same portable envelope: action is at most 64 lowercase ASCII characters, serialized JSON input is at most 380 bytes, and the newline-terminated wire record is at most 512 bytes. Invalid envelopes fail before journal admission or transport. Put larger data in a declared artifact/path and send only a bounded reference or instruction through Control.

A service claims queued or transport-delivered Controls and records handled/failed outcomes under the token-owned Control journal lock. Journal snapshots replace atomically, and expected-status fencing prevents delivery failure evidence from regressing a Control already claimed or completed by a fast consumer. Terminal compaction remains bounded. Services capture their startup generation, so stale-generation Controls never execute.

Runtime lifecycle `kill`, retention actions, and review retry/reset remain runtime-owned rather than Recipe-declared.

## Execution Evidence

`execution.json` stores general command/session provenance. The async runner keeps bounded stdout/stderr logs plus bounded complete captures when semantic validation requires untruncated evidence. Pi command execution also records owned session provenance for later Trace projection and review checks.

Review acceptance remains a command-stage concern. General execution evidence does not imply review approval.

## Status and Terminal Reconciliation

Statuses include `running`, `done`, `failed`, `exited`, `cancelled`, and `killed`. Status resolution combines persisted metadata, result/terminal evidence, and verified process state.

Ambient observation detects terminal transitions and Trace attention. Terminal follow-up delivery persists handled/failure evidence so reloads retry unhandled transitions without duplicating completed notifications.

Large semantic results stay outside compact visible follow-up text and remain available in structured details, execution captures, or artifacts.

## Cancellation and Kill

Cancellation and kill use canonical lifecycle control:

- acquire the state lock;
- validate owner and optional generation fence;
- verify process identity;
- signal the owned process or process group/tree;
- persist lifecycle evidence and Trace;
- finalize in-flight execution and progress.

Shutdown and parent teardown kill only exact owned generations. A stale pid or replacement generation fails closed.

## Retention

Archive and prune apply only to terminal Runs and enforce path containment. Retention never removes active or foreign-owned state. The state index can rebuild from trustworthy Run directories after corruption.

## Service Recipes

Packaged controlled services demonstrate the endpoint protocol:

- `music-player` consumes playback Controls and emits playback Trace;
- `resource-locker` consumes queue/lease actions and emits lock Trace.

One-shot pipelines omit Control and terminate through their command graph.

## Inspection

```text
inspect target=run:<id> view=recipe
inspect target=run:<id> view=trace source=lifecycle lines=40
inspect target=run:<id> view=control
```

Use `/actor-inspector` to inspect Runs as concrete actor instances in the live TUI. Runtime, Recipe registry, and tool definitions remain separate management targets.
