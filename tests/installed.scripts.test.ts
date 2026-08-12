/**
 * Installed package script regression tests.
 * Covers Node native type-stripping restrictions for scripts running under node_modules.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function linkPiPeers(root: string): Promise<void> {
  const peersDir = join(root, "node_modules", "@earendil-works");
  await mkdir(peersDir, { recursive: true });
  for (const peer of ["pi-coding-agent", "pi-tui"]) {
    await symlink(join(process.cwd(), "node_modules", "@earendil-works", peer), join(peersDir, peer), "dir");
  }
}

async function prepareInstalledPackage(root: string): Promise<string> {
  const packageDir = join(root, "node_modules", "@llblab", "pi-actors");
  await mkdir(packageDir, { recursive: true });
  await linkPiPeers(root);
  await cp(join(process.cwd(), "package.json"), join(packageDir, "package.json"));
  await cp(join(process.cwd(), "dist"), join(packageDir, "dist"), { recursive: true });
  await cp(join(process.cwd(), "lib"), join(packageDir, "lib"), { recursive: true });
  await cp(join(process.cwd(), "scripts"), join(packageDir, "scripts"), { recursive: true });
  await cp(join(process.cwd(), "recipes"), join(packageDir, "recipes"), { recursive: true });
  return packageDir;
}

async function preparePackedPackage(root: string): Promise<string> {
  const packDir = join(root, "pack");
  await mkdir(packDir, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true })}\n`);
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for packed-package tests");
  await execFileAsync(process.execPath, [
    npmCli,
    "pack",
    process.cwd(),
    "--pack-destination",
    packDir,
    "--silent",
  ], { cwd: root });
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  await execFileAsync(process.execPath, [
    npmCli,
    "install",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-package-lock",
    "--no-save",
    join(packDir, tarballs[0]),
  ], { cwd: root });
  await linkPiPeers(root);
  return join(root, "node_modules", "@llblab", "pi-actors");
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

test("installed dist runtime reports exact package identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-identity-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
       import(pathToFileURL(join(packageDir, "dist", "lib", "tools-inspect.js")).href).then(async (mod) => {
         const tool = mod.createInspectToolDefinition();
         const result = await tool.execute("status", { target: "runtime", view: "status", verbose: true }, undefined, undefined, {});
         if (result.details.version !== pkg.version) process.exitCode = 2;
         if (result.details.state_schema !== "run-kernel-v1") process.exitCode = 3;
         console.log(JSON.stringify({ version: result.details.version, state_schema: result.details.state_schema }));
       }).catch((error) => { console.error(error); process.exitCode = 1; });`,
      packageDir,
    ]);
    assert.equal(stderr, "");
    const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    assert.deepEqual(JSON.parse(stdout), {
      version: pkg.version,
      state_schema: "run-kernel-v1",
    });
  } finally {
    await removeTreeEventually(root);
  }
});

test("installed dist resolves qualified std and active-Skill Recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-skill-recipes-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const skillDir = join(root, "skill");
    const recipeDir = join(skillDir, "recipes", "nested");
    await mkdir(recipeDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill\n");
    await writeFile(
      join(recipeDir, "task.json"),
      JSON.stringify({ template: "echo {skill_dir}" }),
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       const skillDir = process.argv[2];
       import(pathToFileURL(join(packageDir, "dist", "lib", "recipes-references.js")).href).then((mod) => {
         mod.setActiveSkillRecipeSources([{ name: "sample", baseDir: skillDir }]);
         const skill = mod.readResolvedRecipeConfig(mod.resolveRecipeReferencePath("skill:sample/nested/task"));
         const std = mod.readResolvedRecipeConfig(mod.resolveRecipeReferencePath("std:utility-package-summary"));
         const context = mod.buildRecipeContextRecords(join(skillDir, "recipes", "nested", "task.json"));
         console.log(JSON.stringify({
           skill_dir: skill.skill_dir,
           skill_template: skill.template,
           std_ok: JSON.stringify(std.template).includes("recipe-utils.mjs"),
           qualified_name: context[0].qualified_name,
         }));
       }).catch((error) => { console.error(error); process.exitCode = 1; });`,
      packageDir,
      skillDir,
    ]);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.skill_dir, skillDir);
    assert.match(JSON.stringify(result.skill_template), /skill/);
    assert.equal(result.std_ok, true);
    assert.equal(result.qualified_name, "skill:sample/nested/task");
  } finally {
    await removeTreeEventually(root);
  }
});

test("packed artifact imports compiled extension, skills, and public schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-packed-artifact-"));
  try {
    const packageDir = await preparePackedPackage(root);
    const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    const agentDir = join(root, "agent");
    const homeDir = join(root, "home");
    await mkdir(agentDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "-e",
      `const { readFileSync } = require("node:fs");
       const { join } = require("node:path");
       const { pathToFileURL } = require("node:url");
       const packageDir = process.argv[1];
       import(pathToFileURL(join(packageDir, "dist", "pi-actors", "index.js")).href).then(async (mod) => {
         const tools = [];
         const definitions = new Map();
         const commands = [];
         const handlers = new Map();
         const pi = {
           getActiveTools: () => [],
           getThinkingLevel: () => "off",
           on: (name, handler) => handlers.set(name, handler),
           registerCommand: (name) => commands.push(name),
           registerTool: (definition) => {
             definitions.set(definition.name, definition);
             tools.push({
               name: definition.name,
               properties: Object.keys(definition.parameters.properties).sort(),
               required: definition.parameters.required,
             });
           },
           setActiveTools: () => undefined,
         };
         mod.default(pi);
         const resources = await handlers.get("resources_discover")();
         const context = {
           cwd: packageDir,
           sessionManager: { getSessionId: () => "packed-owner" },
         };
         const spawn = definitions.get("spawn");
         const inspect = definitions.get("inspect");
         const message = definitions.get("message");
         let started;
         let control;
         let trace;
         try {
           started = await spawn.execute("packed-spawn", {
             as: "run:packed-locker",
             recipe: "resource-locker",
             values: { lease_ms: 1000 },
           }, undefined, undefined, context);
           for (let attempt = 0; attempt < 200; attempt += 1) {
             control = await inspect.execute("packed-control", {
               target: "run:packed-locker",
               view: "control",
               verbose: true,
             }, undefined, undefined, context);
             if (control.details.endpoint) break;
             if (control.details.status !== "running") {
               let failure = "stderr unavailable";
               try {
                 failure = readFileSync(join(started.details.state_dir, "stderr.log"), "utf8").trim();
               } catch {}
               throw new Error("packed locker terminated before readiness: " + failure);
             }
             await new Promise((resolve) => setTimeout(resolve, 25));
           }
           if (!control?.details.endpoint) throw new Error("packed locker endpoint unavailable");
           trace = await inspect.execute("packed-trace", {
             target: "run:packed-locker", view: "trace", verbose: true,
           }, undefined, undefined, context);
           await message.execute("packed-stop", {
             target: "run:packed-locker",
             action: "stop",
             verbose: true,
           }, undefined, undefined, context);
           for (let attempt = 0; attempt < 200; attempt += 1) {
             control = await inspect.execute("packed-terminal", {
               target: "run:packed-locker",
               view: "control",
               verbose: true,
             }, undefined, undefined, context);
             if (control.details.status === "done") break;
             if (["failed", "cancelled", "killed"].includes(control.details.status)) {
               throw new Error("packed locker stopped as " + control.details.status);
             }
             await new Promise((resolve) => setTimeout(resolve, 25));
           }
         } finally {
           if (started && control?.details.status === "running") {
             await message.execute("packed-kill", {
               target: "run:packed-locker",
               action: "kill",
             }, undefined, undefined, context).catch(() => undefined);
           }
         }
         console.log(JSON.stringify({
           commands,
           packedRun: {
             controlPending: control.details.pending,
             endpoint: control.details.endpoint?.type,
             repo: started.details.values.repo,
             status: control.details.status,
             traceComplete: trace.details.summary.history_complete,
           },
           resources,
           tools,
         }));
       }).catch((error) => { console.error(error); process.exit(1); });`,
      packageDir,
    ], {
      env: {
        ...process.env,
        HOME: homeDir,
        PI_CODING_AGENT_DIR: agentDir,
        USERPROFILE: homeDir,
      },
    });
    assert.equal(stderr, "");
    assert.equal(pkg.version, JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")).version);
    assert.deepEqual(pkg.pi.extensions, ["./dist/pi-actors/index.js"]);
    assert.deepEqual(pkg.pi.skills, ["./dist/skills"]);
    const loaded = JSON.parse(stdout);
    assert.deepEqual(loaded.commands, ["actor-inspector"]);
    assert.equal(loaded.packedRun.endpoint, process.platform === "win32" ? "named-pipe" : "fifo");
    assert.equal(await realpath(loaded.packedRun.repo), await realpath(packageDir));
    assert.equal(loaded.packedRun.status, "done");
    assert.equal(loaded.packedRun.traceComplete, true);
    assert.equal(loaded.packedRun.controlPending, 0);
    assert.equal(loaded.resources.skillPaths.length, 1);
    assert.equal(loaded.resources.skillPaths[0].replaceAll("\\", "/").endsWith("/dist/skills"), true);
    assert.deepEqual(loaded.tools.map((tool: any) => tool.name), [
      "register_tool",
      "spawn",
      "message",
      "inspect",
    ]);
    assert.deepEqual(loaded.tools.map((tool: any) => tool.properties), [
      ["args", "async", "description", "draft", "name", "template", "update", "values"],
      ["artifacts", "as", "file", "recipe", "template", "transport_context", "values", "verbose"],
      ["action", "input", "target", "verbose"],
      ["lines", "source", "status", "target", "verbose", "view"],
    ]);
    for (const [name, skill] of [["actors", "actors"], ["swarm", "swarm"]]) {
      assert.match(
        await readFile(join(packageDir, "dist", "skills", name, "SKILL.md"), "utf8"),
        new RegExp(`^---\\r?\\nname: ${skill}\\r?$`, "m"),
      );
    }
    assert.doesNotMatch(stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  } finally {
    await removeTreeEventually(root);
  }
});

test("installed dist enforces the same bounded Trace, Control, and inspect contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-installed-bounds-"));
  try {
    const packageDir = await prepareInstalledPackage(root);
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", `
      const { mkdtempSync, statSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const { pathToFileURL } = require("node:url");
      const packageDir = process.argv[1];
      Promise.all(["limits", "runs-controls", "runs-trace", "tools-inspect"].map((name) =>
        import(pathToFileURL(join(packageDir, "dist", "lib", name + ".js")).href))).then(async ([limits, controls, trace, inspect]) => {
        const stateDir = mkdtempSync(join(tmpdir(), "pi-actors-installed-kernel-"));
        const status = { control: ["pause"], ownerId: "owner-a", run: "installed",
          run_instance_id: "generation-a", state_dir: stateDir, status: "running" };
        for (let index = 0; index <= limits.TRACE_JOURNAL_MAX_EVENTS; index++)
          trace.appendRunTraceEvent(stateDir, { kind: "installed.pressure", data: { index } });
        for (let index = 0; index < limits.RUN_CONTROL_PENDING_LIMIT; index++)
          controls.appendRunControlInStateDir(stateDir, { action: "pause", input: { index }, run_instance_id: "generation-a" });
        let reason;
        try { controls.appendRunControlInStateDir(stateDir, { action: "pause", run_instance_id: "generation-a" }); }
        catch (error) { reason = error.reason; }
        const tool = inspect.createInspectToolDefinition({ getRunStatus: () => status });
        const traceView = await tool.execute("trace", { target: "run:installed", view: "trace", verbose: true }, undefined, undefined, {});
        const controlView = await tool.execute("control", { target: "run:installed", view: "control", verbose: true }, undefined, undefined, {});
        console.log(JSON.stringify({ reason, trace: traceView.details.summary, control: {
          available: controlView.details.available, backpressured: controlView.details.backpressured,
          pending: controlView.details.pending }, traceBytes: statSync(join(stateDir, "trace.jsonl")).size,
          controlBytes: statSync(join(stateDir, "controls.jsonl")).size }));
      }).catch((error) => { console.error(error); process.exit(1); });`, packageDir]);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.reason, "control_backpressure");
    assert.equal(result.trace.history_complete, false);
    assert.equal(result.trace.compacted, true);
    assert.equal(result.control.pending, 64);
    assert.equal(result.control.available, 0);
    assert.equal(result.control.backpressured, true);
    assert.ok(result.traceBytes <= 4 * 1024 * 1024);
    assert.ok(result.controlBytes <= 1024 * 1024);
  } finally {
    await removeTreeEventually(root);
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
    assert.equal(await readTextIfExists(join(stateDir, "wake.jsonl")), "");
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
