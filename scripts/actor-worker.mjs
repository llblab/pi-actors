#!/usr/bin/env node

/**
 * Canonical mailbox-backed actor worker demo.
 *
 * Thin process shim. Runtime logic lives in lib/actor-worker.ts and is
 * compiled to dist/lib/actor-worker.js for installed JS-only packages.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", "actor-worker.js");
  return existsSync(compiled) ? compiled : join(root, "lib", "actor-worker.ts");
}

const { runActorWorker } = await import(pathToFileURL(mainModulePath()).href);

try {
  await runActorWorker(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
