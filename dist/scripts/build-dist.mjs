#!/usr/bin/env node

/**
 * Builds or verifies the JavaScript-only distributive tree without exposing a
 * partial tree to Pi or destroying the previous distributive on failure.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const DIST_DIR = "dist";
const checkOnly = process.argv.includes("--check");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

function listFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  }).sort();
}

function listModuleScripts(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listModuleScripts(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

function assertTreesEqual(expectedRoot, actualRoot) {
  if (!existsSync(expectedRoot)) {
    throw new Error(`${expectedRoot} is missing; run npm run build.`);
  }
  const expectedFiles = listFiles(expectedRoot);
  const actualFiles = listFiles(actualRoot);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("dist file inventory is stale; run npm run build.");
  }
  for (const path of expectedFiles) {
    if (!readFileSync(join(expectedRoot, path)).equals(readFileSync(join(actualRoot, path)))) {
      throw new Error(`dist/${path} is stale; run npm run build.`);
    }
  }
}

function replaceDist(candidate) {
  const backup = `.dist-backup-${process.pid}-${Date.now()}`;
  const hadDist = existsSync(DIST_DIR);
  if (hadDist) renameSync(DIST_DIR, backup);
  try {
    renameSync(candidate, DIST_DIR);
    if (hadDist) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadDist && existsSync(backup) && !existsSync(DIST_DIR)) {
      renameSync(backup, DIST_DIR);
    }
    throw error;
  }
}

const candidate = mkdtempSync(join(process.cwd(), ".dist-build-"));
try {
  run(process.execPath, [
    join("node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
    "--outDir",
    candidate,
  ]);

  mkdirSync(join(candidate, "pi-actors"), { recursive: true });
  writeFileSync(
    join(candidate, "pi-actors", "index.js"),
    'export { default } from "../index.js";\n',
    "utf8",
  );
  for (const dir of ["scripts", "fixtures", "skills"]) {
    cpSync(dir, join(candidate, dir), { recursive: true });
  }
  const builtScripts = [
    ...listModuleScripts(join(candidate, "scripts")),
    ...listModuleScripts(join(candidate, "skills")),
  ];
  run(process.execPath, ["--check", ...builtScripts]);

  if (checkOnly) {
    assertTreesEqual(DIST_DIR, candidate);
    console.log("pi-actors: dist is current");
  } else {
    replaceDist(candidate);
  }
} finally {
  rmSync(candidate, { recursive: true, force: true });
}
