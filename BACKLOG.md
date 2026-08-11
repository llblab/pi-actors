# Project Backlog

## 0.43.1 — Contract Closure

**Base:** `0.43.0` at `0d6db30cd2e070c1d03ed1e60bef70538a3083c1`
**Release type:** patch-level assurance and distribution closure
**Release sentence:** the Run kernel is published, portable, redacted, and mechanically self-consistent.

## Mission

Close the concrete gaps exposed after the `0.43.0` Run-kernel migration without adding another orchestration layer or expanding the public model.

The canonical model remains unchanged:

```text
Recipe --spawn--> Run
Run = Recipe + Trace + Control
```

The public lifecycle remains:

```text
spawn   create a Run
message apply Control
inspect read Recipe, Trace, or Control
```

`register_tool` remains the separate capability-memory surface.

`0.43.1` succeeds when the same contract is true in source mode, installed-package mode, documentation, diagnostics, first-party controlled services, CI, GitHub Release, and npm distribution.

## Hard Boundaries

The release must preserve:

- exactly the existing public Run nouns: `Recipe`, `Run`, `Trace`, and `Control`;
- exactly the existing Run views: `recipe`, `trace`, and `control`;
- exactly the existing management targets: `runtime`, `recipes`, and `tool:<name>`;
- the stable public tool names `spawn`, `message`, `inspect`, and `register_tool`;
- owner filtering, immutable `run_instance_id` fencing, canonical lifecycle locking, and process-identity verification;
- shutdown and parent-teardown behavior;
- terminal reconciliation and bounded follow-up context;
- complete command captures, owned Pi-session evidence, redaction, path containment, and symlink rejection;
- automatic Recipe review, immutable capture, CAS, journaled mutation, lineage, retry, reset, and recovery safety;
- shell-free command-template execution;
- the strict Domain DAG and removed-communication-surface gates.

The release must not add:

- actor chat, rooms, branches, peers, routing, mailboxes, inboxes, outboxes, or addressed envelopes under any name;
- a task tree, planner hierarchy, decision registry, swarm scheduler, model router, or model-economics subsystem to the kernel;
- new public targets, views, request fields, Trace fields, Control states, or Recipe keys;
- a remote protocol, broker, workflow DSL, or general event bus;
- compatibility aliases for removed `0.42` surfaces;
- a long-lived npm token or third-party publish action;
- new runtime dependencies unless an existing retained invariant cannot be closed otherwise.

## Deferred Beyond This Release

Do not absorb these future lines into `0.43.1`:

- total Trace retention, rotation, or semantic compaction;
- pending-Control admission backpressure and queue quotas;
- outcome/cost aggregation for Recipe fitness;
- automatic model selection or planner/worker economics;
- task-tree or decision-ownership orchestration;
- a generalized acknowledgement protocol for arbitrary controlled services.

Those require separate evidence and belong to later releases.

## Known Closure Gaps

The executor must verify this observation against the current checkout before changing code:

1. The repository-side Trusted Publisher path is prepared, but npm account binding and tagged publication proof remain external release preconditions.

If the observation no longer holds, preserve the already-closed behavior and remove only the corresponding obsolete task. Do not reimplement solved work.

---

## P0 — Release and Contract Closure

### CCL-02 — Activate npm Trusted Publisher and prove registry convergence

**Goal:** make `pi install npm:@llblab/pi-actors` install the released Run kernel through the prepared tokenless, provenance-bearing path.

**Status:** repository preparation is complete; npm account configuration and one tagged release proof remain externally gated.

**External operator precondition:**

- Configure the npm Trusted Publisher for package `@llblab/pi-actors` with owner `llblab`, repository `pi-actors`, workflow filename `release.yml`, and no environment unless both sides adopt the same reviewed environment name.
- Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another long-lived token fallback.
- Remove any obsolete account-level automation tokens only after one Trusted Publisher release succeeds.

**Release-time closure:**

- The tagged workflow passes reusable validation, publishes or safely recognizes the exact npm version, verifies matching `gitHead` and packed Pi runtime manifests, then converges the GitHub Release.
- `npm view @llblab/pi-actors@0.43.1 version` and npm `latest` resolve to `0.43.1`.
- The GitHub Release and npm package identify the same tag commit.
- The Pi package index may update asynchronously; observe it without unbounded polling or repository mutation.
- If Trusted Publisher remains unconfigured or mismatched, report that exact external blocker and keep publication failed closed.

**Dependencies:** npm account configuration and the final tagged release.

---

## P1 — Signal, Compression, and Integration Closure

### CCL-12 — Close release evidence and publish `0.43.1`

**Goal:** leave one internally consistent source tree, package, release, and empty future-work file.

**Work:**

- Reconcile implementation comments, README, `AGENTS.md`, `docs/`, Actors skill, fixtures, schemas, tests, and release notes.
- Keep Swarm skill changes limited to kernel-interface corrections; do not expand orchestration methodology in this release.
- Update package version and packaged skill metadata to `0.43.1` only after all implementation tasks close.
- Move completed work into one concise `CHANGELOG.md` section with externally meaningful behavior and impact.
- Reset `BACKLOG.md` to:

  ```text
  # Project Backlog

  No open items.
  ```

- Run the final local boundary:

  ```bash
  npm ci
  npm run test:preservation
  npm run release:validate
  npm run audit:dependencies
  ```

- Create tag `v0.43.1` only from the validated release commit.
- Observe the gated workflow through successful validation, npm publication, npm verification, and GitHub Release publication.
- Verify the final public package through npm, not only `npm pack --dry-run`.

**Release closure:**

- Ubuntu, macOS, Windows, and dependency-audit jobs succeed.
- GitHub Release is published only after validation and npm verification.
- npm exact version and `latest` both resolve to `0.43.1`.
- The installed package reports `0.43.1`, exposes the same schemas as source, and contains no removed communication surface.
- Recipe QA has zero diagnostics and zero baseline warnings.
- Shipped lines remain below `28,853`.
- No unresolved P0/P1 finding remains.
- `BACKLOG.md` contains no completed work.

**Dependencies:** all prior tasks and the npm Trusted Publisher external precondition.

---

## Dependency Order

```text
Released 0.43.0 baseline
  └── CCL-02 → CCL-12
```

`CCL-02` may proceed in parallel with kernel fixes after the frozen released baseline, but no tag may be created until the complete graph closes.

## Required Test Matrix

At minimum, retain or add direct evidence for:

| Boundary               | Required evidence                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Public Control request | exact fields, action length, serialized-input bound, removed-field rejection              |
| Recipe Control         | same action grammar/length, duplicate and runtime-reserved rejection                      |
| Control journal        | generation fencing, monotonic transitions, compaction, stale-lock recovery                |
| Control projection     | recursive redaction in tool content/details, triage, and Actor Inspector                  |
| Control transport      | exact complete-wire bound, FIFO atomicity, named-pipe parity, partial-write failure       |
| Runtime status         | exact version in source and packed/dist modes                                             |
| Runtime triage         | pending/stale distinction, delivered inclusion, age boundaries, owner/lifecycle filtering |
| Trace append           | canonical validation, cross-process serialization, no malformed/lost/duplicate records    |
| First-party services   | canonical Trace only, canonical Control claim/finalization, endpoint generation           |
| Documentation          | canonical examples accepted by current schemas/dispatchers                                |
| Recipe QA              | zero diagnostics and zero normalized warnings                                             |
| Release                | validation-before-publication, OIDC-only npm publishing, rerun convergence                |
| Compression            | strict shipped-line ratchet from `0.43.0`                                                 |
| Installed package      | compiled entrypoint, skills, version, schemas, no stale files/source imports              |

## Final Decision Rule

Do not release because the code compiles or because the new abstractions look cleaner.

Release only when this statement is supported end to end:

> A user installing `@llblab/pi-actors@0.43.1` receives the same validated Run kernel described by the repository: every Run exposes one captured Recipe, one redacted causal Trace, and one portable generation-fenced Control boundary—without a communication plane and without distribution ambiguity.
