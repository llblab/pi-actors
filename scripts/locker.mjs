#!/usr/bin/env node

/**
 * Local coordination locker service shim.
 *
 * Runtime logic lives in lib/locker.ts and is compiled to dist/lib/locker.js
 * for installed JS-only packages.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(scriptDir);
  return basename(parent) === "dist" ? dirname(parent) : parent;
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", "locker.js");
  return existsSync(compiled) ? compiled : join(root, "lib", "locker.ts");
}

const { runLocker } = await import(pathToFileURL(mainModulePath()).href);

try {
  await runLocker(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
