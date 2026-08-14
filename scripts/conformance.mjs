#!/usr/bin/env node

/**
 * Internal conformance runner.
 *
 * This script is intentionally standalone package/release glue rather than a
 * lib domain: it only selects regression suites and formats their summary.
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const conformanceSuites = [
  "tests/agent-journeys.test.ts",
  "tests/control.test.ts",
  "tests/runs-controls.test.ts",
  "tests/runs-trace.test.ts",
  "tests/observability.test.ts",
  "tests/async-run-control.test.ts",
  "tests/run-kernel-dogfood.test.ts",
  "tests/installed.scripts.test.ts",
  "tests/inspector-overlay.test.ts",
  "tests/tools-inspect-kernel.test.ts",
  "tests/recipes-discovery.test.ts",
  "tests/review-swarm-dogfood.test.ts",
  "tests/registry.test.ts",
  "tests/runtime.test.ts",
  "tests/async-runs.test.ts",
  "tests/tools.test.ts",
];

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    ...conformanceSuites,
  ],
  { cwd: packageRoot(), encoding: "utf8", stdio: "pipe" },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const summary = output
  .split("\n")
  .filter((line) =>
    /^ℹ (tests|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line),
  )
  .join("\n");

console.log("pi-actors conformance");
console.log(`suites ${conformanceSuites.length}`);

if (summary) console.log(summary);
if ((result.status ?? 1) !== 0) {
  console.error(output.trimEnd());
  process.exit(result.status ?? 1);
}
