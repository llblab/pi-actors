#!/usr/bin/env node

/**
 * Detached async-runner shim.
 *
 * Runtime logic lives in lib/async-runner.ts and is compiled to
 * dist/lib/async-runner.js for installed JS-only packages.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", "async-runner.js");
  return existsSync(compiled) ? compiled : join(root, "lib", "async-runner.ts");
}

const { runAsyncRunner } = await import(pathToFileURL(mainModulePath()).href);

try {
  await runAsyncRunner(process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
