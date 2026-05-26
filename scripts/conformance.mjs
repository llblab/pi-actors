#!/usr/bin/env node

/**
 * Internal conformance runner.
 *
 * This script runs the protocol-facing regression suites that exercise recipe
 * discovery, registry mutation, spawn lifecycle, message routing, room/branch
 * state, ownership checks, artifacts, and attention semantics without requiring
 * the Pi UI.
 *
 * Keep output compact for CI and release preflight use; detailed failures are
 * printed only when the underlying Node test run fails.
 */

import { spawnSync } from "node:child_process";

const suites = [
  "tests/protocol-examples.test.ts",
  "tests/recipe-discovery.test.ts",
  "tests/registry.test.ts",
  "tests/runtime-registry.test.ts",
  "tests/async-runs.test.ts",
  "tests/actor-rooms.test.ts",
  "tests/tools.test.ts",
];

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...suites],
  { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: "pipe" },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const summary = output
  .split("\n")
  .filter((line) =>
    /^ℹ (tests|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line),
  )
  .join("\n");

console.log("pi-actors conformance");
console.log(`suites ${suites.length}`);
if (summary) console.log(summary);
if (result.status !== 0) {
  console.error(output.trimEnd());
  process.exit(result.status ?? 1);
}
