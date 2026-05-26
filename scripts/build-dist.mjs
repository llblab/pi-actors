#!/usr/bin/env node

/**
 * Build the JavaScript-only distributive tree.
 *
 * The dist tree is the default package entry surface for Node-like runtimes:
 * compiled JS modules plus mirrored runtime assets used by recipes, skills, and
 * protocol fixture consumers.
 */

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

run("tsc", ["-p", "tsconfig.build.json"]);

for (const dir of ["scripts", "recipes", "fixtures", "skills"]) {
  cpSync(dir, join("dist", dir), { recursive: true });
}

const builtScripts = readdirSync(join("dist", "scripts"))
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => join("dist", "scripts", name));

run(process.execPath, ["--check", ...builtScripts]);
