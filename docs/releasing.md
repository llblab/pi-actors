# Release Operations

Stable releases use one immutable tag workflow. The workflow runs normal product validation on Ubuntu, macOS, and Windows plus the dependency audit before any publication, publishes and verifies the exact npm package through Trusted Publisher, then creates or converges the GitHub Release from the matching changelog section. Architecture review uses the project-local Domain DAG Skill during architecture-affecting development; release automation does not run policy, line-count, source-style, or Domain DAG gates.

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
3. Let `.github/workflows/release.yml` invoke the reusable `npm run validate` and dependency-audit workflow.
4. Let the publication job verify the tag commit, package manifests, and non-empty changelog section.
5. Publish the exact public npm package through OIDC when the version does not exist.
6. Verify npm version, `gitHead`, Pi extension/skill metadata, and packed runtime manifests.
7. Create or update the GitHub Release only after npm verification succeeds.

A rerun skips `npm publish` only when the exact existing version reports the same tagged `gitHead`; contradictory identity fails closed because npm versions are immutable. Registry lookup retries remain bounded. A missing or mismatched Trusted Publisher usually surfaces as npm authentication or not-found failure and must be corrected in npm package settings—never by adding a token fallback.
