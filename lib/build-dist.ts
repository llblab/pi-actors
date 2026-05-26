/**
 * Dist build pipeline entrypoint logic.
 * Zones: packaging, JavaScript-only distributive tree
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function buildDist(): void {
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
}
