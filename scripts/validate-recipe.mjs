#!/usr/bin/env -S node --experimental-strip-types

/**
 * Template recipe validator CLI shim.
 *
 * Runtime logic lives in lib/validate-recipe.ts and is compiled to
 * dist/lib/validate-recipe.js for installed JS-only packages.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", "validate-recipe.js");
  return existsSync(compiled) ? compiled : join(root, "lib", "validate-recipe.ts");
}

const { validateRecipes } = await import(pathToFileURL(mainModulePath()).href);

try {
  const report = validateRecipes(process.argv.slice(2));
  if (report.help) console.error(report.usage);
  else console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
