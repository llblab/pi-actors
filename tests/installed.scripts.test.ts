/**
 * Installed package script regression tests.
 * Covers Node native type-stripping restrictions for scripts running under node_modules.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { deliverRunControl } from "../lib/runs-control-delivery.ts";

const execFileAsync = promisify(execFile);

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function waitForText(path: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = await readTextIfExists(path);
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}`);
}

async function removeTreeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "") || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
  assert.deepEqual(pkg.pi.extensions, ["./dist/pi-actors/index.js"]);
  assert.deepEqual(pkg.pi.sourceExtensions, ["./index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./dist/skills"]);
  assert.deepEqual(pkg.pi.sourceSkills, ["./skills"]);
  await access(join(process.cwd(), pkg.pi.extensions[0]));
  await access(join(process.cwd(), pkg.pi.sourceExtensions[0]));
});

test("build output mirrors JS runtime assets under dist", async () => {
  for (const dir of ["scripts", "recipes", "fixtures", "skills"] as const) {
    const sourceEntries = await readdir(join(process.cwd(), dir));
    const distEntries = await readdir(join(process.cwd(), "dist", dir));
    assert.deepEqual(distEntries.sort(), sourceEntries.sort(), `dist/${dir} should mirror ${dir}`);
  }
  assert.equal(
    await readFile(join(process.cwd(), "dist", "pi-actors", "index.js"), "utf8"),
    'export { default } from "../index.js";\n',
  );
  await access(join(process.cwd(), "dist", "scripts", "async-runner.mjs"));
  await access(join(process.cwd(), "dist", "scripts", "build-dist.mjs"));
  await access(join(process.cwd(), "dist", "recipes", "utility-validate-recipe.json"));
  await access(join(process.cwd(), "dist", "fixtures", "protocol", "control-record.json"));
  await access(join(process.cwd(), "dist", "fixtures", "protocol", "trace-event.json"));
  await access(join(process.cwd(), "dist", "skills", "actors", "SKILL.md"));
  await access(join(process.cwd(), "dist", "skills", "swarm", "SKILL.md"));
});

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(() => access(path), /ENOENT/);
}

test("dist package contract excludes stale renamed files and source runtime imports", async () => {
  await assertMissing(join(process.cwd(), "dist", "index.ts"));
  for (const staleLib of [
    "actor-inspector-tui",
    "actor-messages",
    "actor-recipe-context",
    "actor-rooms",
    "actor-tools",
    "actor-worker",
    "async-runner",
    "coordinator",
    "locker",
    "mailbox-worker",
    "output",
    "recipe-context",
    "recipe-discovery",
    "recipe-references",
    "recipe-usage",
    "recipe-utils",
    "run-executor",
    "validate-recipe",
  ]) {
    await assertMissing(join(process.cwd(), "dist", "lib", `${staleLib}.js`));
    await assertMissing(join(process.cwd(), "dist", "lib", `${staleLib}.d.ts`));
  }
  for (const script of await readdir(join(process.cwd(), "dist", "scripts"))) {
    if (!script.endsWith(".mjs")) continue;
    const text = await readFile(join(process.cwd(), "dist", "scripts", script), "utf8");
    assert.doesNotMatch(text, /\.\.\/lib\/.*\.ts/);
    assert.doesNotMatch(text, /node_modules.*\.ts/);
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

test("music-player direct control queues canonical Controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-control-"));
  const stateDir = join(root, "music");
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({ run: "music", run_instance_id: "generation-a" }),
    );
    const { stdout } = await execFileAsync(process.execPath, [
      join(process.cwd(), "scripts", "music-player.mjs"),
      "next",
      stateDir,
    ]);
    assert.match(stdout, /command=next queued/);
    const control = JSON.parse(await readFile(join(stateDir, "controls.jsonl"), "utf8"));
    assert.equal(control.action, "next");
    assert.equal(control.run_instance_id, "generation-a");
    assert.equal(control.status, "queued");
    assert.equal(Object.hasOwn(control, "to"), false);
    const wake = JSON.parse(await readFile(join(stateDir, "wake.jsonl"), "utf8"));
    assert.equal(wake.actor, "run:music");
    assert.equal(wake.reason, "control.queued");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music-player consumes publicly delivered Controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-music-delivery-"));
  const stateDir = join(root, "music");
  const source = join(root, "silence.wav");
  const fakePlayer = join(root, process.platform === "win32" ? "ffplay.exe" : "ffplay");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({ run: "music", run_instance_id: "generation-a" }),
  );
  await writeFile(source, "audio fixture", "utf8");
  if (process.platform === "win32") {
    const sourceFile = join(root, "fake-player.cs");
    await writeFile(
      sourceFile,
      "using System; using System.Threading; public class Program { public static void Main(string[] args) { Thread.Sleep(30000); } }\n",
      "utf8",
    );
    const quotedSource = sourceFile.replaceAll("'", "''");
    const quotedPlayer = fakePlayer.replaceAll("'", "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -Path '${quotedSource}' -OutputAssembly '${quotedPlayer}' -OutputType ConsoleApplication`,
    ]);
  } else {
    await writeFile(fakePlayer, "#!/bin/sh\nsleep 30\n", "utf8");
    await chmod(fakePlayer, 0o755);
  }
  let playbackPid: number | undefined;
  let childOutput = "";
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "music-player.mjs"), "play", source, "false", "70", "ffplay", stateDir],
    {
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  try {
    await waitForText(join(stateDir, "control-endpoint.json"), /run_instance_id/);
    if (process.platform === "win32") {
      const playerState = JSON.parse(
        await waitForText(join(stateDir, "player.json"), /"pid":"\d+"/),
      );
      playbackPid = Number(playerState.pid);
    }
    const action = process.platform === "win32" ? "status" : "stop";
    const stopStartedAt = Date.now();
    await deliverRunControl("music", stateDir, {
      action,
      run_instance_id: "generation-a",
    });
    try {
      await waitForText(join(stateDir, "controls.jsonl"), /"status":"handled"/);
    } catch (error) {
      const controls = await readTextIfExists(join(stateDir, "controls.jsonl"));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
        `child_exit=${child.exitCode ?? "running"}; child_signal=${child.signalCode ?? "none"}; ` +
        `controls=${JSON.stringify(controls.slice(-2000))}; output=${JSON.stringify(childOutput.slice(-2000))}`,
      );
    }
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      const code = await Promise.race([
        new Promise<number | null>((resolve) => child.once("exit", resolve)),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("music-player did not stop")), 5000),
        ),
      ]);
      assert.equal(code, 0);
      assert.ok(Date.now() - stopStartedAt < 2500, "music-player stop must beat natural fixture exit");
    }
    const control = JSON.parse(await readFile(join(stateDir, "controls.jsonl"), "utf8"));
    assert.equal(control.status, "handled");
    assert.equal(typeof control.delivered_at, "string");
  } finally {
    child.kill("SIGKILL");
    if (process.platform === "win32" && playbackPid) {
      await execFileAsync("taskkill", ["/PID", String(playbackPid), "/T", "/F"]).catch(() => {});
    }
    await removeTreeEventually(root);
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
          run_id: "installed-runner",
          state_dir: stateDir,
          trace_file: join(stateDir, "trace.jsonl"),
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
