#!/usr/bin/env node

/**
 * Build the JavaScript-only distributive tree.
 *
 * This is intentionally standalone: it is package/build glue, not reusable
 * actor-domain behavior. It cleans dist, compiles TypeScript, mirrors runtime
 * assets, and syntax-checks packaged scripts.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
