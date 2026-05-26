#!/usr/bin/env node

/**
 * Build the JavaScript-only distributive tree shim.
 *
 * Runtime logic lives in scripts/build-dist.ts and is compiled to
 * dist/scripts/build-dist.js when the package is built.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "scripts", "build-dist.js");
  return existsSync(compiled) ? compiled : join(root, "scripts", "build-dist.ts");
}

const { buildDist } = await import(pathToFileURL(mainModulePath()).href);
buildDist();
