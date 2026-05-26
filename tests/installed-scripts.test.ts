/**
 * Installed package script regression tests.
 * Covers Node native type-stripping restrictions for scripts running under node_modules.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  await cp(join(process.cwd(), "dist"), join(packageDir, "dist"), { recursive: true });
  await cp(join(process.cwd(), "lib"), join(packageDir, "lib"), { recursive: true });
  await cp(join(process.cwd(), "scripts"), join(packageDir, "scripts"), { recursive: true });
  await cp(join(process.cwd(), "recipes"), join(packageDir, "recipes"), { recursive: true });
  return packageDir;
}

test("package metadata exposes compiled and source extension entrypoints", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./dist/index.js"]);
  assert.deepEqual(pkg.pi.sourceExtensions, ["./index.ts"]);
  assert.deepEqual(pkg.pi.skills, [
    "./dist/skills/actors/SKILL.md",
    "./dist/skills/swarm/SKILL.md",
  ]);
  assert.deepEqual(pkg.pi.sourceSkills, [
    "./skills/actors/SKILL.md",
    "./skills/swarm/SKILL.md",
  ]);
  await access(join(process.cwd(), pkg.pi.extensions[0]));
  await access(join(process.cwd(), pkg.pi.sourceExtensions[0]));
});

test("build output mirrors JS runtime assets under dist", async () => {
  await access(join(process.cwd(), "dist", "scripts", "actor-worker.mjs"));
  await access(join(process.cwd(), "dist", "scripts", "async-runner.mjs"));
  await access(join(process.cwd(), "dist", "scripts", "build-dist.mjs"));
  await access(join(process.cwd(), "dist", "recipes", "actor-worker.json"));
  await access(join(process.cwd(), "dist", "recipes", "utility-validate-recipe.json"));
  await access(join(process.cwd(), "dist", "fixtures", "protocol", "actor-message-branch.json"));
  await access(join(process.cwd(), "dist", "fixtures", "protocol", "mailbox-contract.json"));
  await access(join(process.cwd(), "dist", "skills", "actors", "SKILL.md"));
  await access(join(process.cwd(), "dist", "skills", "swarm", "SKILL.md"));
});

test("build output includes compiled modules for TypeScript-backed script shims", async () => {
  for (const module of [
    "actor-worker",
    "async-runner",
    "conformance",
    "recipe-utils",
    "validate-recipe",
  ]) {
    await access(join(process.cwd(), "dist", "lib", `${module}.js`));
    await access(join(process.cwd(), "dist", "lib", `${module}.d.ts`));
  }
});

test("installed extension entrypoint imports compiled dist runtime", async () => {
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

test("music-player direct control queues mailbox commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-control-"));
  const stateDir = join(root, "music");
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      join(process.cwd(), "scripts", "music-player.mjs"),
      "next",
      stateDir,
    ]);
    assert.match(stdout, /command=next queued/);
    const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
    assert.equal(inbox.body, "next");
    assert.equal(inbox.status, "queued");
    assert.equal(inbox.type, "player.next");
    const wake = JSON.parse(await readFile(join(stateDir, "wake.jsonl"), "utf8"));
    assert.equal(wake.actor, "run:music");
    assert.equal(wake.reason, "run.message");
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
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "async-runner.ts")), "");
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "execution.ts")), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed actor-worker avoids importing TypeScript from node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-worker-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const stateDir = join(root, "worker-state");
    await mkdir(stateDir, { recursive: true });

    const worker = execFile(
      process.execPath,
      [
        join(packageDir, "scripts", "actor-worker.mjs"),
        "--state-dir",
        stateDir,
        "--run",
        "installed-worker",
        "--branch",
        "worker",
        "--poll-ms",
        "50",
      ],
      { timeout: 2000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    worker.kill("SIGTERM");

    const journal = await readTextIfExists(join(stateDir, "worker-events.jsonl"));
    assert.match(journal, /worker.started/);
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "actor-worker.ts")), "");
    assert.equal(await readTextIfExists(join(stateDir, ".type-strip-lib", "mailbox-loop.ts")), "");
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
    assert.equal(await readTextIfExists(join(root, ".type-strip-lib", "validate-recipe.ts")), "");
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
