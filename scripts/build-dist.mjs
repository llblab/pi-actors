#!/usr/bin/env node

/**
 * Build the JavaScript-only distributive tree.
 *
 * This is intentionally standalone: it is package/build glue, not reusable
 * actor-domain behavior. It cleans dist, compiles TypeScript, mirrors runtime
 * assets, and syntax-checks packaged scripts.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

run(process.execPath, [
  join("node_modules", "typescript", "bin", "tsc"),
  "-p",
  "tsconfig.build.json",
]);

mkdirSync(join("dist", "pi-actors"), { recursive: true });
writeFileSync(
  join("dist", "pi-actors", "index.js"),
  'export { default } from "../index.js";\n',
  "utf8",
);

for (const dir of ["scripts", "fixtures", "skills"]) {
  cpSync(dir, join("dist", dir), { recursive: true });
}

function listModuleScripts(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listModuleScripts(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

const builtScripts = [
  ...listModuleScripts(join("dist", "scripts")),
  ...listModuleScripts(join("dist", "skills")),
];

run(process.execPath, ["--check", ...builtScripts]);
