# Release Operations

Stable releases use one immutable tag workflow. The workflow runs normal product validation on Ubuntu, macOS, and Windows plus the dependency audit before any publication, publishes and verifies the exact npm package through Trusted Publisher, then creates or converges the GitHub Release from the matching changelog section. Architecture review uses the project-local Domain DAG Skill during architecture-affecting development; release automation does not run policy, line-count, source-style, or Domain DAG gates.

## CI Trigger Boundary

- **Ordinary branch push (`dev`, feature branches, or `main`):** No standalone validation or publication workflow. Updating an open PR emits its PR event, which owns the development checks.
- **Pull request:** One validation workflow runs the complete Ubuntu/macOS/Windows product matrix and one Ubuntu dependency audit. A branch push must not start a second copy of these checks.
- **Version-tag push (`v*.*.*`):** Only the release workflow starts. It invokes reusable validation once for the immutable tagged commit, then performs exact-tag/package preflight, npm publication/verification and GitHub Release convergence. This explicit pre-publication gate is retained; no standalone push-validation workflow runs alongside it.
- **`workflow_call`:** Reuses the validation implementation for that release gate; it is not an independent push trigger. The release and PR paths share the same platform/audit contract, not copied job definitions.

## Product Test Shards

The adopted CI layout has three isolated test jobs on each supported OS: `installed` runs the heavy `installed.scripts.test.ts` package/SDK owner; `owners-a` and `owners-b` receive alternating entries from the sorted discovery of every other top-level `*.test.ts` file. New test files join automatically. The partition must be exhaustive and non-overlapping; do not split or filter assertions inside an owner, omit platform cases, or change fixture/SDK watchdogs.

Each job uses a separate checkout and test-agent state, Node24 and the existing single-worker/preload flags. Package validation (types, Recipe QA, committed build parity and extension import) plus dry-pack runs once per OS on `installed`, not on every shard. Local `npm test` and `npm run validate` remain complete unsharded entrypoints. The reusable workflow must wait for all nine test jobs and the single dependency audit before release publication; one successful shard never substitutes for the full gate. This layout reduces aggregate critical-path pressure, not the cost or correctness obligations of an individual native test.

Simple tools/registration fixtures bind original runner births and actual `close`, then validate canonical success and fresh ESRCH again at deletion. Their joint acceptance phase has one10-second watchdog, replacing the old approximately2-second result/exit polling assumption; this is a fixture allowance, not a product/SDK/workload deadline. Missing post-close results fail promptly; uncertainty retains roots without signals or automatic wait inflation.

Implementation and native CI acceptance are tracked in BACKLOG until the complete sharded candidate passes.

## Local Validation

Run `npm run validate` and `npm run audit:dependencies` with Node24 selected, including after any login-shell setup. When launching validation from an Actor, clear `PI_ACTORS_DELIVERY_OWNER_ID`, `PI_ACTORS_DELIVERY_PARENT_RUN`, `PI_ACTORS_DELIVERY_PARENT_INSTANCE` and `PI_ACTORS_DELIVERY_PARENT_STATE_DIR` only in the test workload's environment. Otherwise independent SDK fixture coordinators may inherit the validation Actor's completion lineage and wait for the wrong coordinator. Keep the launcher's own lineage intact; this isolation changes neither product defaults nor test cases, the standard agent-directory preload or watchdogs.

## One-time npm Trusted Publisher setup

Configure the existing public package `@llblab/pi-actors` on npmjs.com with a GitHub Actions Trusted Publisher using these exact values:

- **Owner:** `llblab`
- **Repository:** `pi-actors`
- **Workflow filename:** `release.yml`
- **Environment:** Leave empty unless the workflow and npm configuration later adopt the same named GitHub environment in one reviewed change.

The binding must target `.github/workflows/release.yml`; npm asks for the filename rather than the repository-relative path. npm does not verify this identity when the setting is saved, so the first tagged publication provides the decisive proof.

Do not create `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another long-lived npm publish secret. The publication job runs on a GitHub-hosted Ubuntu runner with `id-token: write`, Node 24, npm 11.5.1 or newer, the public npm registry, and package-manager caching disabled at the credential-bearing boundary.

## Release sequence

1. Merge the validated release tree through the repository's guarded `dev` to `main` flow.
2. Create one immutable `v<package.version>` tag on the verified `main` commit.
3. Let `.github/workflows/release.yml` invoke the reusable complete product-validation and dependency-audit workflow.
4. Let the publication job verify the tag commit, package manifests, and non-empty changelog section.
5. Publish the exact public npm package through OIDC when the version does not exist.
6. Verify npm version, `gitHead`, Pi extension/skill metadata, and packed runtime manifests.
7. Create or update the GitHub Release only after npm verification succeeds.

A rerun skips `npm publish` only when the exact existing version reports the same tagged `gitHead`; contradictory identity fails closed because npm versions are immutable. After npm accepts publication, public metadata and the tarball may remain unavailable while the registry processes the package. Verification waits up to ten minutes, checks online metadata and tarball availability every ten seconds, and bounds each npm command by the remaining deadline. Exact version, `gitHead`, Pi metadata, or packed-manifest mismatches fail immediately once both registry reads succeed; availability retries never relax identity checks or repeat publication. A verification timeout leaves publication accepted but not yet verified: do not republish or move the tag. Wait for the exact public version and `gitHead`, then rerun the failed publication job so it skips the existing package and finishes GitHub Release convergence. A missing or mismatched Trusted Publisher usually surfaces as npm authentication or not-found failure and must be corrected in npm package settings—never by adding a token fallback.
