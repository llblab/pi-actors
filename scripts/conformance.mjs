#!/usr/bin/env node

/**
 * Internal conformance runner shim.
 *
 * Runtime logic lives in lib/conformance.ts and is compiled to
 * dist/lib/conformance.js for installed JS-only packages.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function mainModulePath() {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", "conformance.js");
  return existsSync(compiled) ? compiled : join(root, "lib", "conformance.ts");
}

const { runConformance } = await import(pathToFileURL(mainModulePath()).href);
const report = runConformance(packageRoot());

console.log("pi-actors conformance");
console.log(`suites ${report.suites}`);
if (report.summary) console.log(report.summary);
if (report.code !== 0) {
  console.error(report.output.trimEnd());
  process.exit(report.code);
}
