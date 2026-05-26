#!/usr/bin/env node

/**
 * Multi-actor coordinator helper shim.
 *
 * Runtime logic lives in lib/coordinator.ts and is compiled to
 * dist/lib/coordinator.js for installed JS-only packages.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", "coordinator.js");
  return existsSync(compiled) ? compiled : join(root, "lib", "coordinator.ts");
}

const { runCoordinator } = await import(pathToFileURL(mainModulePath()).href);

try {
  await runCoordinator(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
