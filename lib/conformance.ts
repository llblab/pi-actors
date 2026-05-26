/**
 * Internal conformance runner logic.
 * Zones: CI/release validation, protocol regression suite selection
 */

import { spawnSync } from "node:child_process";

export const conformanceSuites = [
  "tests/protocol-examples.test.ts",
  "tests/recipe-discovery.test.ts",
  "tests/registry.test.ts",
  "tests/runtime-registry.test.ts",
  "tests/async-runs.test.ts",
  "tests/actor-rooms.test.ts",
  "tests/tools.test.ts",
];

export interface ConformanceReport {
  code: number;
  output: string;
  summary: string;
  suites: number;
}

export function runConformance(cwd = new URL("..", import.meta.url)): ConformanceReport {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", ...conformanceSuites],
    { cwd, encoding: "utf8", stdio: "pipe" },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const summary = output
    .split("\n")
    .filter((line) =>
      /^ℹ (tests|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line),
    )
    .join("\n");

  return {
    code: result.status ?? 1,
    output,
    summary,
    suites: conformanceSuites.length,
  };
}
