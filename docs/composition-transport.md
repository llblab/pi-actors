# Composition Transport and CodeMode Interoperability

Status: Design intake recorded at the user's request. JSONL bundle support is a proposal, not an implemented API or an addition to the current UX/AX release gate. Basic CodeMode calls to available tools are an existing host capability; pi-actors-specific interoperability acceptance across supported host versions remains separate. [BACKLOG.md](../BACKLOG.md) is the only open-work surface.

## Three Distinct Responsibilities

- **Recipe bundle:** One transportable artifact containing related Recipe definitions and their local links.
- **Recipe composition:** The existing imports, named nodes and command-template executor; packaging must preserve its semantics rather than create a second execution engine.
- **CodeMode orchestration:** Host-provided JavaScript that calls available tools, branches, combines results and selects output. It is not a replacement Run kernel or an implicitly adopted JavaScript Recipe backend.

See the existing [Recipe contract](./template-recipes.md), [Run lifecycle](./async-runs.md) and [completion delivery](./coordinator-delivery.md).

## JSONL Recipe Bundle Direction

A bundle can place one JSON object on each line, with one explicit entry point and unique bundle-local keys for the embedded definitions. A local key belongs to the container envelope, not to the Recipe body: ordinary Recipe files still do not declare a top-level name, and a template node's name still invokes an import alias.

Illustrative syntax only; none of the bundle fields or fragment references below are currently supported:

```jsonl
{"kind":"recipe-bundle","version":1,"entry":"main"}
{"id":"scan","recipe":{"args":["path"],"template":"scan {path}"}}
{"id":"report","recipe":{"args":["path"],"template":"report {path}"}}
{"id":"main","recipe":{"args":["path"],"imports":{"scan":"#scan","report":"#report"},"template":[{"name":"scan"},{"name":"report"}]}}
```

The intended value is one file that preserves a composition graph instead of requiring a tree of Recipe files. JSONL is the proposed encoding, not the reason to invent different composition semantics.

### Preservation Boundaries

- Read and validate the complete bundle before work: version, record shapes, entry existence, unique keys, closed references, cycles, depth and bounded aggregate input. Forward references must not cause partial execution.
- Local ids locate definitions inside this artifact. They do not become global Skill names, registered-tool identities, Run generations, producer keys or permissions.
- Pack definitions and links, not a captured invocation. Do not bake current model/thinking, live cwd, credentials, session identity, Run state or runtime-owned origins into portable authority.
- Preserve argument/default/value precedence, direct-delegation versus composition behavior, root async/Control/artifact semantics and private origins. Imported Control must not silently become root Control.
- Moving definitions must not silently change relative paths or the meaning of recipe_dir/skill_dir. Source identity and diagnostic provenance must remain understandable without treating an authored original path as a trusted runtime origin.
- Prefer the existing Recipe loader/resolver and executor. File count or a new extension alone does not justify another domain, registry, execution service or temporary-file authority scheme.
- Packaging must not imply that external commands, scripts or resources were included, or that the destination has compatible dependencies. It does not create a sandbox or change native authority.

### Unresolved Product Choices

The following are deliberately not adopted by the illustrative example: exact manifest/record/reference grammar; whether only the declared entry can be invoked; permitted external references and dependency pinning; canonical source/provenance representation; aggregate/count limits; export handling for authored private values; and whether the artifact contains only Recipes or also scripts/assets. In particular, the user has not yet selected recipes-only versus resources-inclusive packaging. A portable graph is not automatically a hermetic executable.

## CodeMode as the Tool-Orchestration Plane

The checked host contract is Pi's installed docs/codemode.md. CodeMode runs an async JavaScript body in QuickJS and exposes available session tools through tools. It supports ordinary JavaScript control flow and parallel calls. The sandbox itself has no Node APIs, direct filesystem, network or timers; tool calls can still perform their normal external effects. Chat models are not callable through the models interface: an Actor/agent launch uses the real public launch tool, not a new models.chat API.

Calls that return a task's result can be composed within one script. A detached Actor is different: the existing spawn or async registered tool returns its launch receipt rather than keeping the tool call pending for the complete workload.

Illustrative orchestration, with a placeholder active-Skill identity rather than a runnable example:

```js
const receipt = await tools.spawn({
  recipe: "<active-skill>/<recipe>",
  values: {},
  verbose: true,
});
text(receipt);
```

The relevant split is:

```text
CodeMode awaits launch tool → launch receipt → CodeMode returns
                                      |
                                      v
                            Run continues in pi-actors
                                      |
                                      v
                    existing coordinator completion delivery
```

This is a split between launch acknowledgment and eventual outcome, not an unawaited JavaScript Promise that survives the VM. A launch receipt is not agent readiness, successful task completion, terminal handling or whole-scope closure. The existing tool's output schema still applies; a textual receipt must not be treated as an invented structured Run object.

### Lifetime and Failure Boundaries

- Await the actual launch tool until it returns its receipt. The host cancels still-running tool calls when the CodeMode script ends and discards unawaited Promises. A fire-and-forget tools.spawn call is not a supported detachment mechanism.
- A launch may already have effects before a failure/cancellation prevents its receipt from being seen. Calls made before script failure are not rolled back. Do not blindly relaunch or assume that cancellation stopped an already materialized Run.
- CodeMode store/load carries small JSON data, not live Promises or Run authority. Store writes commit only when the script succeeds: a later script failure can discard a stored receipt without undoing an already launched Run. It is not a substitute lifecycle journal or resume engine.
- Once the existing kernel owns a launched Run, CodeMode supplies no substitute lifecycle, owner, generation, controller, clock, stop or result-publication authority. The VM's sandbox is not an OS sandbox for called tools or Actors. Normal VM completion is not parent-session shutdown; the existing parent/session lifecycle still applies, with no new promise that a Run survives its coordinator.
- A later phase that needs the agent's final result normally runs after the existing completion delivery, potentially in another CodeMode call. Returning the launch receipt does not make that final result available to the next line of the first script. This direction adopts no polling loop, new wait budget or Promise-resumption service.
- Calling spawn through CodeMode remains a Recipe spawn. Calling an actually active registered tool remains that tool's invocation. Persistence, availability/callability and launch_kind distinctions do not disappear inside JavaScript.
- Use actual available tools and their argument/result contracts; current CodeMode discovery helpers can expose them. Do not assume every supported Pi installation has CodeMode, silently raise the declared Pi 1.0.0 floor, or make the ordinary public-tool path depend on it.

## Requested Skill-Level Guidance

The user specifically wants discoverable operating guidance, especially in actors and swarm, not merely a note that CodeMode exists. The following are candidate patterns for future maintained Skill examples, not claims that those examples have already shipped. They can be developed independently of JSONL bundle support.

- **Direct tool call — the baseline.** Prefer the ordinary tool for one simple operation when JavaScript adds no useful branching, batching or projection. CodeMode is optional, not a compulsory wrapper.
- **Short preflight and conditional chain.** Collect cheap prerequisite facts, check each tool's real success/error contract, then select the next ordinary tool or launch. Potential benefit: fewer model round trips and less intermediate context. Limit: an awaited call can still return a failure-shaped result; neither await nor VM completion means every operation succeeded.
- **Independent launch fan-out.** After scope/profile preparation, await a bounded set of actual launch receipts, preserving successes and failures with allSettled when appropriate, then return control to the coordinator. Potential benefit: grouped orchestration with less repetitive model traffic and concurrent independent launch preparation where the tools permit it. Limits: receipts are not workload results, concurrency consumes real resources, and a missing receipt can hide partial launch effects. Do not parallelize overlapping writes or destructive actions merely because JavaScript permits it.
- **Phased completion fan-in.** Launch in one phase; use existing completion delivery; in a later phase selectively read admitted result references and prepare synthesis inputs. Potential benefit: keep long work outside the VM and reduce boilerplate around collecting evidence. Limits: no polling/new wait service, no imagined surviving Promise, and no automatic quorum or integration verdict from an array of receipts.
- **Selective result projection.** Batch independent allowed reads and emit only decision-relevant results, warnings and references. Potential benefit: smaller model context instead of raw tool dumps. Limits: preserve failures, partiality, minority findings and source provenance; every textual clipping follows the approved bracketed omission rule, and already-lost lengths stay unknown.

### Skill Ownership and Example Quality

actors should own the common launch/registered-tool, capability-discovery, receipt, cancellation and lifecycle boundaries. swarm should reference that common mechanism and explain its own added methodology: disjoint task scopes, independent contexts/lenses, reasoning profiles, shared-contract ownership, contradiction-preserving synthesis and one integration owner. Promise concurrency is not reviewer independence or permission to delegate.

Each maintained example should state its prerequisite and actual tool/result contracts, why CodeMode is useful compared with direct calls, what gets awaited, what is emitted, what survives or remains unknown after failure, and how the next phase starts. Examples must not invent structured fields on textual tool results, discard unsuccessful branches, repeat uncertain launches, or confuse the JS sandbox with native isolation. Acceptance belongs to actual supported-host source/packed tool paths, not merely plausible snippets. Neither this guidance request nor its future examples authorize launching participants while only recording the design.

## Output Selection and Clipping

CodeMode can select or shorten tool output before it reaches the model, but it must not turn a partial result into a completeness claim. Follow the [user-approved omission disclosure](./run-supervision.md#user-approved-omission-disclosure): explicitly mark text clipping with square-bracket omitted-character counts from already-authorized privacy-projected text. If a tool already returned truncated data or an unknown original length, keep that uncertainty and any valid retained-source reference; a script cannot reconstruct the original count from the shortened string. Preserve original failures and relevant partial effects instead of printing only a success-shaped summary.

These notes record the requested direction and verified host constraints. They do not implement bundle loading, validate a new cross-host detachment promise, widen output retention/visibility, resume Grow Loop, or authorize release, native changes or delegated execution.
