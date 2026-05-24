/**
 * Installed package script regression tests.
 * Covers Node native type-stripping restrictions for scripts running under node_modules.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function prepareInstalledPackage(root: string): Promise<string> {
  const packageDir = join(root, "node_modules", "@llblab", "pi-actors");
  const peersDir = join(root, "node_modules", "@earendil-works");
  await mkdir(packageDir, { recursive: true });
  await mkdir(peersDir, { recursive: true });
  for (const peer of ["pi-coding-agent", "pi-tui"]) {
    await symlink(join(process.cwd(), "node_modules", "@earendil-works", peer), join(peersDir, peer), "dir");
  }
  await cp(join(process.cwd(), "package.json"), join(packageDir, "package.json"));
  await cp(join(process.cwd(), "index.js"), join(packageDir, "index.js"));
  await cp(join(process.cwd(), "dist"), join(packageDir, "dist"), { recursive: true });
  await cp(join(process.cwd(), "lib"), join(packageDir, "lib"), { recursive: true });
  await cp(join(process.cwd(), "scripts"), join(packageDir, "scripts"), { recursive: true });
  await cp(join(process.cwd(), "recipes"), join(packageDir, "recipes"), { recursive: true });
  return packageDir;
}

test("installed extension entrypoint from package metadata imports compiled runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-entry-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
       const entry = join(packageDir, pkg.pi.extensions[0]);
       import(pathToFileURL(entry).href).then((mod) => {
         if (typeof mod.default !== "function") throw new Error("extension default export missing");
         console.log("installed extension ok");
       }).catch((error) => {
         console.error(error.code || error.name, error.message);
         process.exit(1);
       });`,
      packageDir,
    ]);
    assert.match(stdout, /installed extension ok/);
    assert.doesNotMatch(stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed async-runner avoids importing TypeScript from node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-runner-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      `${JSON.stringify({
        run: "installed-runner",
        state_dir: stateDir,
        status: "running",
        template: `${process.execPath} -e "console.log('installed async ok')"`,
        values: {
          actor_address: "run:installed-runner",
          communication_file: join(stateDir, "communication.json"),
          default_room: "room:installed-runner",
          run_id: "installed-runner",
          state_dir: stateDir,
        },
      })}\n`,
    );

    await execFileAsync(process.execPath, [
      join(packageDir, "scripts", "async-runner.mjs"),
      stateDir,
    ]);

    const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8"));
    assert.equal(result.code, 0);
    assert.doesNotMatch(
      await readTextIfExists(join(stateDir, "stderr.log")),
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
    );
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /installed async ok/);
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "execution.ts")), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed validate-recipe avoids importing TypeScript from node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-validator-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const recipe = join(root, "recipe.json");
    await writeFile(recipe, `${JSON.stringify({ template: "echo ok" })}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      join(packageDir, "scripts", "validate-recipe.mjs"),
      recipe,
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.passed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed validate-recipe resolves bare imports from packaged recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-imports-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const recipe = join(root, "recipe.json");
    await writeFile(
      recipe,
      `${JSON.stringify({
        imports: { status: "utility-git-status" },
        template: [{ name: "status" }],
      })}\n`,
    );

    const { stdout } = await execFileAsync(process.execPath, [
      join(packageDir, "scripts", "validate-recipe.mjs"),
      recipe,
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.passed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
