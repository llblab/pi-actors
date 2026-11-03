/** Mirrors lib/command-templates.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import {
  join,
  resolve,
} from "node:path";
import {
  tmpdir,
} from "node:os";
import test from "node:test";
import {
  type TestContext,
  describe,
} from "node:test";
import {
  buildCommandTemplateInvocation,
  execCommandTemplate,
  expandCommandTemplateConfigs,
  getCommandTemplateRiskLabels,
  getCommandTemplateWarnings,
  resolveCommandTemplateScriptInvocation,
  resolveInheritedDefaultReferences,
  splitCommandTemplate,
  type CommandTemplateExecResult,
  type CommandTemplateAttemptReceipt,
} from "../lib/command-templates.ts";
import {
  createHash,
} from "node:crypto";
import {
  type ChildProcess,
} from "node:child_process";
import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  syncBuiltinESMExports,
} from "node:module";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Command templates", { concurrency: false }, async () => {
/**
 * Command-template regression tests
 * Covers shell-free splitting, executable expansion, defaults, inline placeholder resolution, and composition expansion
 */



test("Command templates split shell-like words without invoking a shell", () => {
  assert.deepEqual(
    splitCommandTemplate("tool 'literal words' --name hello\\ world"),
    ["tool", "literal words", "--name", "hello world"],
  );
  assert.deepEqual(
    splitCommandTemplate("C:\\Program\\ Files\\node.exe --version"),
    ["C:\\Program Files\\node.exe", "--version"],
  );
});

test("Command templates accept shorthand string configs", () => {
  const invocation = buildCommandTemplateInvocation(
    "./tts --text {text} --lang {lang=ru}",
    { text: "hello world" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: resolve("/work", "tts"),
    args: ["--text", "hello world", "--lang", "ru"],
  });
});

test("Command templates infer portable script interpreters", () => {
  const node = buildCommandTemplateInvocation("./worker.mjs --mode check", {}, "/work");
  assert.deepEqual(node, {
    command: process.execPath,
    args: [resolve("/work", "worker.mjs"), "--mode", "check"],
  });
  const seen: string[] = [];
  const deno = resolveCommandTemplateScriptInvocation(
    { command: "/work/worker.js", args: ["value"] },
    (name) => {
      seen.push(name);
      return name === "deno" ? "/runtime/deno" : undefined;
    },
  );
  assert.deepEqual(seen, ["node", "bun", "deno"]);
  assert.deepEqual(deno, {
    command: "/runtime/deno",
    args: ["run", "/work/worker.js", "value"],
  });
  const seenBun: string[] = [];
  resolveCommandTemplateScriptInvocation(
    { command: "/work/worker.mjs", args: [] },
    (name) => {
      seenBun.push(name);
      return name === "bun" ? "/runtime/bun" : undefined;
    },
  );
  assert.deepEqual(seenBun, ["node", "bun"]);
  assert.deepEqual(
    resolveCommandTemplateScriptInvocation(
      { command: "/work/task.sh", args: ["value"] },
      (name) => name === "bash" ? "/runtime/bash" : undefined,
    ),
    { command: "/runtime/bash", args: ["/work/task.sh", "value"] },
  );
});

test("Command template arrays inherit only top-level args and defaults", () => {
  const steps = expandCommandTemplateConfigs({
    template: [
      "tts --text {text} --lang {lang} --out {mp3}",
      {
        template: "ffmpeg -i {mp3} {ogg} {codec}",
        defaults: { codec: "opus" },
        timeout: 123,
      },
    ],
    args: ["text", "lang", "mp3", "ogg"],
    defaults: { lang: "en" },
    output: "ogg",
    timeout: 999,
  });
  assert.deepEqual(steps, [
    {
      template: "tts --text {text} --lang {lang} --out {mp3}",
      args: ["text", "lang", "mp3", "ogg"],
      defaults: { lang: "en" },
      retry: undefined,
    },
    {
      template: "ffmpeg -i {mp3} {ogg} {codec}",
      args: ["text", "lang", "mp3", "ogg"],
      defaults: { lang: "en", codec: "opus" },
      timeout: 123,
      retry: undefined,
    },
  ]);
});

test("Command template child defaults can reference inherited defaults", () => {
  const steps = expandCommandTemplateConfigs({
    defaults: { model: "parent-model", reviewer_model: "reviewer-model" },
    template: [
      { defaults: { model: "{model}" }, template: "echo {model}" },
      { defaults: { model: "{reviewer_model}" }, template: "echo {model}" },
    ],
  });
  assert.equal(steps[0].defaults?.model, "parent-model");
  assert.equal(steps[1].defaults?.model, "reviewer-model");
});

test("Command template child defaults can reference runtime values", () => {
  const resolved = resolveInheritedDefaultReferences(
    { lenses: "{lenses}", lens: "{lenses[index]}" },
    { lenses: ["parent"], index: 0 },
    { lenses: ["runtime"], index: 0 },
  );
  assert.deepEqual(resolved?.lenses, ["runtime"]);
  assert.equal(resolved?.lens, "runtime");
});

test("Template composition expansion preserves retry and failure on step objects", () => {
  const steps = expandCommandTemplateConfigs({
    template: [
      "scan --path {dir}",
      {
        template: "lint --strict {dir}",
        retry: 3,
        failure: "root",
      },
      {
        template: "deploy {dir}",
        failure: "root",
        timeout: 60000,
      },
    ],
    args: ["dir"],
    defaults: { dir: "./src" },
  });
  assert.deepEqual(steps, [
    {
      template: "scan --path {dir}",
      args: ["dir"],
      defaults: { dir: "./src" },
      retry: undefined,
    },
    {
      template: "lint --strict {dir}",
      args: ["dir"],
      defaults: { dir: "./src" },
      retry: 3,
      failure: "root",
    },
    {
      template: "deploy {dir}",
      args: ["dir"],
      defaults: { dir: "./src" },
      failure: "root",
      timeout: 60000,
      retry: undefined,
    },
  ]);
});

test("Command template repeat expands numbered defaults", () => {
  const steps = expandCommandTemplateConfigs({
    repeat: 3,
    template:
      "render page{_(index+1)}.html prev=page{_(prev+1)}.html next=page{_(next+1)}.html raw={index}/{repeat}",
  });
  assert.equal(steps.length, 3);
  assert.deepEqual(
    {
      index: steps[0].defaults?.index,
      next: steps[0].defaults?.next,
      prev: steps[0].defaults?.prev,
      repeat: steps[0].defaults?.repeat,
      _index: steps[0].defaults?._index,
      __index: steps[0].defaults?.__index,
      _prev: steps[0].defaults?._prev,
      _next: steps[0].defaults?._next,
    },
    {
      index: "0",
      next: "1",
      prev: "2",
      repeat: "3",
      _index: "00",
      __index: "000",
      _prev: "02",
      _next: "01",
    },
  );
  const invocation = buildCommandTemplateInvocation(steps[0], {}, "/work");
  assert.deepEqual(invocation.args, [
    "page01.html",
    "prev=page03.html",
    "next=page02.html",
    "raw=0/3",
  ]);
  assert.deepEqual(buildCommandTemplateInvocation(steps[2], {}, "/work").args, [
    "page03.html",
    "prev=page02.html",
    "next=page01.html",
    "raw=2/3",
  ]);
});

test("Command templates detect high-risk trusted executable shapes", () => {
  const config = {
    template: [
      "bash -c {script}",
      "node -e {code}",
      "python3 -Ic {code}",
      "rm -rf {work_dir}",
    ],
  };
  const warnings = getCommandTemplateWarnings(config);
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /bash/);
  assert.match(warnings[1], /eval/);
  assert.match(warnings[2], /code-eval/);
  assert.match(warnings[3], /removes filesystem paths/);
  assert.equal(
    warnings.every((warning) => /Mitigation:/.test(warning)),
    true,
  );
  assert.deepEqual(getCommandTemplateRiskLabels(config), [
    "risk.shell",
    "risk.eval",
    "risk.destructive_fs",
  ]);
  assert.match(
    getCommandTemplateWarnings("bash -lc {script}").join("\n"),
    /shell command strings/,
  );
  assert.deepEqual(getCommandTemplateRiskLabels("/work/task.sh"), ["risk.shell"]);
});

test("Command templates classify advisory risk labels deterministically", () => {
  assert.deepEqual(
    getCommandTemplateRiskLabels({
      template: [
        "cp {source} /etc/target",
        "curl https://example.test/{token}",
        "npm publish",
        "tail -f /tmp/app.log",
        "systemctl restart demo.service",
      ],
    }),
    [
      "risk.broad_fs_write",
      "risk.external_side_effect",
      "risk.secret_touching",
      "risk.network",
      "risk.long_running",
      "risk.platform_specific",
    ],
  );
});

test("Command templates resolve typed inline placeholders", () => {
  const invocation = buildCommandTemplateInvocation(
    "tool {file:path} {request_timeout:int=60000} {speed:number=1.5} {mode:enum(check,fix)=check}",
    { file: "/tmp/a.txt" },
    "/work",
  );
  assert.deepEqual(invocation.args, ["/tmp/a.txt", "60000", "1.5", "check"]);
});

test("Command templates resolve ternary placeholders", () => {
  const enabled = buildCommandTemplateInvocation(
    "validate recipes {all?--all:}",
    { all: true },
    "/work",
  );
  const disabled = buildCommandTemplateInvocation(
    "validate recipes {all?--all:}",
    { all: false },
    "/work",
  );
  assert.deepEqual(enabled.args, ["recipes", "--all"]);
  assert.deepEqual(disabled.args, ["recipes"]);
});

test("Command templates resolve nullish coalescing placeholders", () => {
  const missing = buildCommandTemplateInvocation(
    "deploy {env??dev} {region??local}",
    { region: "" },
    "/work",
  );
  const provided = buildCommandTemplateInvocation(
    "deploy {env??dev} {region??local}",
    { env: "prod", region: "eu" },
    "/work",
  );
  assert.deepEqual(missing.args, ["dev", "local"]);
  assert.deepEqual(provided.args, ["prod", "eu"]);
});

test("Command templates resolve defaults and inline placeholder defaults", () => {
  const invocation = buildCommandTemplateInvocation(
    {
      template: "./tts --text {text} --lang {lang=ru} --rate {rate}",
      defaults: { rate: "+30%" },
    },
    { text: "hello world" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: resolve("/work", "tts"),
    args: ["--text", "hello world", "--lang", "ru", "--rate", "+30%"],
  });
});

test("Command templates resolve embedded recursive defaults", () => {
  const invocation = buildCommandTemplateInvocation(
    {
      defaults: {
        repo: "/repo",
        docs_dir: "docs",
        directory: "{repo}/{docs_dir}",
      },
      template: "find {directory}",
    },
    {},
    "/work",
    { missingLabel: "test" },
  );
  assert.deepEqual(invocation, {
    command: "find",
    args: ["/repo/docs"],
  });
});

test("Command templates resolve array-index placeholders and recursive defaults", () => {
  const invocation = buildCommandTemplateInvocation(
    {
      defaults: { prompt: "{prompts[index]}" },
      template: "subagent {prompt}",
    },
    { index: "1", prompts: ["left", "right"] },
    "/work",
  );
  assert.deepEqual(invocation.args, ["right"]);
});

test("Command template execution writes stdin without invoking a shell", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    [
      "-e",
      "process.stdin.on('data', data => process.stdout.write(String(data).toUpperCase()))",
    ],
    { stdin: "hello" },
  );
  assert.deepEqual(result, {
    stdout: "HELLO",
    stderr: "",
    code: 0,
    killed: false,
    stdoutBytes: 5,
    stderrBytes: 0,
  });
});

test("Command template capture directories retain every retry stream", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-actors-command-evidence-"));
  const counter = join(root, "counter.txt");
  await writeFile(counter, "0");
  try {
    const script = `
      const fs = require("fs");
      const path = ${JSON.stringify(counter)};
      const attempt = Number(fs.readFileSync(path, "utf8")) + 1;
      fs.writeFileSync(path, String(attempt));
      process.stdout.write("out-" + attempt);
      process.stderr.write("err-" + attempt);
      if (attempt === 1) process.exit(1);
    `;
    const result = await execCommandTemplate(process.execPath, ["-e", script], {
      captureDir: root,
      retry: 2,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "out-2");
    assert.equal(result.stderr, "err-2");
    assert.equal(
      await readFile(join(root, "attempt-001", "stdout.log"), "utf8"),
      "out-1",
    );
    assert.equal(
      await readFile(join(root, "attempt-001", "stderr.log"), "utf8"),
      "err-1",
    );
    assert.equal(
      await readFile(join(root, "attempt-002", "stdout.log"), "utf8"),
      "out-2",
    );
    assert.equal(
      await readFile(join(root, "attempt-002", "stderr.log"), "utf8"),
      "err-2",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Command template execution bounds tails and spills complete streams", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    [
      "-e",
      "process.stdout.write('A'.repeat(4096)); process.stderr.write('B'.repeat(3072))",
    ],
    { captureLimitBytes: 256 },
  );
  assert.equal(Buffer.byteLength(result.stdout), 256);
  assert.equal(Buffer.byteLength(result.stderr), 256);
  assert.equal(result.stdoutBytes, 4096);
  assert.equal(result.stderrBytes, 3072);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(typeof result.stdoutFile, "string");
  assert.equal(typeof result.stderrFile, "string");
  const { readFile, rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  assert.equal((await readFile(result.stdoutFile!, "utf8")).length, 4096);
  assert.equal((await readFile(result.stderrFile!, "utf8")).length, 3072);
  await rm(dirname(result.stdoutFile!), { recursive: true, force: true });
});

test("Command template capture preserves UTF-8 across chunks and bounded tails", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    [
      "-e",
      `const bytes = Buffer.from("🙂🙂");
       process.stdout.write(bytes.subarray(0, 2));
       setTimeout(() => process.stdout.write(bytes.subarray(2)), 20);`,
    ],
    { captureLimitBytes: 5 },
  );
  assert.equal(result.stdout, "🙂");
  assert.equal(result.stdout.includes("�"), false);
  assert.equal(result.stdoutBytes, 8);
  assert.equal(result.stdoutTruncated, true);
  const { readFile, rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  assert.equal(await readFile(result.stdoutFile!, "utf8"), "🙂🙂");
  await rm(dirname(result.stdoutFile!), { recursive: true, force: true });
});

test("Command template timeout escalates when SIGTERM is ignored", async () => {
  const startedAt = Date.now();
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { timeout: 500, killGrace: 10 },
  );
  assert.equal(result.killed, true);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - startedAt < 2000);
});

test("Command template timeout terminates descendants retaining stdio", async () => {
  if (process.platform === "win32") return;
  const startedAt = Date.now();
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `;
  const result = await execCommandTemplate(process.execPath, ["-e", script], {
    timeout: 100,
    killGrace: 10,
  });
  assert.equal(result.killed, true);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - startedAt < 2000);
});

test("Command template retry succeeds on second attempt", async () => {
  const counterFile = join(tmpdir(), `ct-retry-${process.pid}.txt`);
  const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(counterFile, "0");
  const script = `
    const fs = require("fs");
    const p = ${JSON.stringify(counterFile)};
    let n = parseInt(fs.readFileSync(p, "utf8"));
    n++;
    fs.writeFileSync(p, String(n));
    if (n < 2) process.exit(1);
  `;
  const result = await execCommandTemplate(process.execPath, ["-e", script], {
    retry: 2,
    killGrace: 10,
  });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(counterFile, "utf8").trim(), "2");
  unlinkSync(counterFile);
});

test("Command template retries keep high-volume captures bounded", async () => {
  const counterFile = join(tmpdir(), `ct-capture-retry-${process.pid}.txt`);
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { readFile, rm } = await import("node:fs/promises");
  writeFileSync(counterFile, "0");
  const script = `
    const fs = require("fs");
    const p = ${JSON.stringify(counterFile)};
    const n = Number(fs.readFileSync(p, "utf8")) + 1;
    fs.writeFileSync(p, String(n));
    process.stdout.write(String(n).repeat(4096));
    if (n < 2) process.exit(1);
  `;
  const result = await execCommandTemplate(process.execPath, ["-e", script], {
    captureLimitBytes: 128,
    retry: 2,
  });
  assert.equal(result.code, 0);
  assert.equal(Buffer.byteLength(result.stdout), 128);
  assert.equal(result.stdoutBytes, 4096);
  assert.equal(result.stdoutTruncated, true);
  assert.equal((await readFile(result.stdoutFile!, "utf8")).length, 4096);
  unlinkSync(counterFile);
  await rm(dirname(result.stdoutFile!), { recursive: true, force: true });
});

test("Command template retry exhausts attempts and surfaces last failure", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "process.exit(3)"],
    { retry: 3, killGrace: 10 },
  );
  assert.notEqual(result.code, 0);
  assert.equal(result.killed, false);
});

test("Command template retry default is 1 (no retry)", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "process.exit(1)"],
    { killGrace: 10 },
  );
  assert.notEqual(result.code, 0);
});

test("Command templates leave timeout disabled by default", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "setTimeout(() => {}, 100);"],
    { killGrace: 10 },
  );
  assert.equal(result.killed, false);
  assert.equal(result.code, 0);
});

test("Command templates report missing required placeholders", () => {
  assert.throws(
    () => buildCommandTemplateInvocation("tool {missing}", {}, "/work"),
    /Missing command template value: missing/,
  );
});

});

await describe("Native attempt management", { concurrency: false }, async () => {


async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-managed-native-"));
  let child: ChildProcess | undefined;
  let exit: Promise<unknown[]> | undefined;
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
    await rm(root, { recursive: true, force: true });
  });
  const retain = (process: ChildProcess) => {
    child = process;
    exit = new Promise((resolve) => process.once("exit", (...args) => resolve(args)));
    return process;
  };
  return { root, retain };
}

test("A fresh managed handle is observed synchronously inside admission after stream/exit management", async (t) => {
  const { root, retain } = await fixture(t);
  let inAdmission = false;
  let observed = false;
  const result = await execCommandTemplate(process.execPath, ["-e", "console.log('managed output')"], {
    captureDir: join(root, "captures"),
    admitSpawn: (start) => {
      inAdmission = true;
      try {
        const child = retain(start());
        assert.equal(observed, true);
        return child;
      } finally { inAdmission = false; }
    },
    onAttemptManaged: (context) => {
      observed = true;
      assert.equal(inAdmission, true);
      assert.equal(Object.isFrozen(context), true);
      assert.equal(context.attempt, 1);
      assert.equal(context.process.stdout!.listenerCount("data") > 0, true);
      assert.equal(context.process.stderr!.listenerCount("data") > 0, true);
      assert.equal(context.process.listenerCount("error") > 0, true);
      assert.equal(context.process.listenerCount("close") > 0, true);
    },
  });
  assert.equal(result.code, 0);
  assert.equal(observed, true);
  assert.match(result.stdout, /managed output/);
});

test("Managed-observer failure retains complete streams and native exit before rejecting without retry", async (t) => {
  const { root, retain } = await fixture(t);
  const primary = Object.freeze(new Error("birth observer rejected"));
  const secondary = Object.freeze(new Error("completion observer rejected"));
  let closed: number | null | undefined;
  let completed = 0;
  let managed = 0;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", "console.log('retained stdout');console.error('retained stderr');process.exit(7)"], {
    retry: 3, captureDir: join(root, "captures"),
    onAttemptManaged: ({ process }) => { managed++; retain(process); throw primary; },
    onAttemptComplete: (receipt) => { completed++; closed = receipt.nativeExitCode; throw secondary; },
  }), (error) => error === primary);
  assert.equal(managed, 1);
  assert.equal(completed, 1);
  assert.equal(closed, 7);
  assert.match(await readFile(join(root, "captures", "attempt-001", "stdout.log"), "utf8"), /retained stdout/);
  assert.match(await readFile(join(root, "captures", "attempt-001", "stderr.log"), "utf8"), /retained stderr/);
  assert.equal(existsSync(join(root, "captures", "attempt-002")), false);
});

test("Admission failure after managed spawn cannot orphan capture or replace the original failure", async (t) => {
  const { root, retain } = await fixture(t);
  const primary = Object.freeze(new Error("admission failed after native start"));
  let completions = 0;
  let exitCode: number | null | undefined;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", "console.log('captured despite admission failure');process.exit(7)"], {
    retry: 3, captureDir: join(root, "captures"),
    admitSpawn: (start) => { retain(start()); throw primary; },
    onAttemptComplete: (receipt) => { completions++; exitCode = receipt.nativeExitCode; },
  }), (error) => error === primary);
  assert.equal(completions, 1);
  assert.equal(exitCode, 7);
  assert.match(await readFile(join(root, "captures", "attempt-001", "stdout.log"), "utf8"), /captured despite admission failure/);
  assert.equal(existsSync(join(root, "captures", "attempt-002")), false);
});

test("Capture preparation failure occurs before any native process is created", async (t) => {
  const { root, retain } = await fixture(t);
  const blocked = join(root, "not-a-directory");
  await writeFile(blocked, "preserved");
  let native: ChildProcess | undefined;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", "console.log('must not run')"], {
    captureDir: blocked,
    admitSpawn: (start) => { native = retain(start()); return native; },
  }));
  assert.equal(native, undefined);
  assert.equal(await readFile(blocked, "utf8"), "preserved");
});

test("Denied admission never creates captures or invokes managed/settled observers", async (t) => {
  const { root } = await fixture(t);
  const primary = new Error("not admitted");
  await assert.rejects(() => execCommandTemplate(process.execPath, [], {
    captureDir: join(root, "captures"),
    admitSpawn: () => { throw primary; },
    onAttemptManaged: () => assert.fail("Denied attempt became managed"),
    onAttemptComplete: () => assert.fail("Denied attempt became settled"),
  }), (error) => error === primary);
  assert.equal(existsSync(join(root, "captures")), false);
});

test("Spawn admission cannot duplicate, skip, or substitute the managed factory", async (t) => {
  for (const mode of ["duplicate", "skip", "substitute"]) {
    const { root, retain } = await fixture(t);
    const marker = join(root, "started");
    let completed = 0;
    const message = mode === "duplicate" ? /only once/ : mode === "skip" ? /must invoke/ : /must return/;
    await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)},'once\\n')`], {
      retry: 3,
      admitSpawn: (start) => {
        if (mode === "skip") return {} as ChildProcess;
        retain(start());
        if (mode === "duplicate") start();
        return {} as ChildProcess;
      },
      onAttemptComplete: () => { completed++; },
    }), message);
    assert.equal(completed, mode === "skip" ? 0 : 1);
    if (mode === "skip") assert.equal(existsSync(marker), false);
    else assert.equal(await readFile(marker, "utf8"), "once\n");
  }
});

test("A retained factory expires when admission returns or throws without starting", async (t) => {
  for (const throws of [false, true]) {
    const { root, retain } = await fixture(t);
    const primary = new Error("admission closed");
    let saved: (() => ChildProcess) | undefined;
    let managed = 0;
    let completed = 0;
    await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", "console.log('late child must not run')"], {
      captureDir: join(root, "captures"),
      admitSpawn: (start) => { saved = start; if (throws) throw primary; return {} as ChildProcess; },
      onAttemptManaged: () => { managed++; },
      onAttemptComplete: () => { completed++; },
    }), (error) => throws ? error === primary : /must invoke/.test(String(error)));
    assert.ok(saved);
    assert.throws(() => retain(saved!()), /admission window is closed/);
    assert.equal(managed, 0);
    assert.equal(completed, 0);
    assert.equal(existsSync(join(root, "captures")), false);
  }
});

test("Completed capture receipts retain a kernel-only digest of observed raw stdout, never the clipped memory tail or a UTF-8 certificate", async t => {
  for (const bytes of [Buffer.from("\uFEFFHEAD🌍" + "x".repeat(2048) + "TAIL\uFFFD"), Buffer.from([0xff, ...Buffer.from("prefix-tail")])]) {
    const { root, retain } = await fixture(t); let receipt: CommandTemplateAttemptReceipt | undefined;
    const result = await execCommandTemplate(process.execPath, ["-e", `const bytes=Buffer.from(${JSON.stringify([...bytes])});process.stdout.write(bytes.subarray(0,2));setTimeout(()=>process.stdout.write(bytes.subarray(2)),10)`], {
      captureDir: join(root, "captures"), captureLimitBytes: 8,
      onAttemptManaged: ({ process }) => { retain(process); }, onAttemptComplete: value => { receipt = value; },
    });
    assert.ok(receipt); assert.equal(Object.isFrozen(receipt), true);
    assert.equal(receipt.stdoutSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.stdoutTruncated, true); assert.notEqual(receipt.stdoutSha256, createHash("sha256").update(result.stdout).digest("hex"));
    assert.deepEqual(await readFile(result.stdoutFile!), bytes);
    assert.equal(Object.hasOwn(result, "stdoutSha256"), false); assert.equal(Object.hasOwn(receipt.result, "stdoutSha256"), false);
  }
});

test("Capture-write failures drain both streams, retain bounded tails, and cannot replace an earlier error", async (t) => {
  const { root, retain } = await fixture(t);
  const primary = new Error("earlier managed observer failure");
  let receipt: Readonly<CommandTemplateExecResult> | undefined;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", "process.stdout.write('stdout-prefix→tail\\n');process.stderr.write('stderr-prefix→tail\\n');process.exit(7)"], {
    retry: 3, captureLimitBytes: 8, captureDir: join(root, "captures"),
    onAttemptManaged: ({ process }) => {
      retain(process);
      for (const name of ["stdout", "stderr"]) {
        const file = join(root, "captures", "attempt-001", `${name}.log`);
        rmSync(file); mkdirSync(file);
      }
      throw primary;
    },
    onAttemptComplete: ({ result, nativeExitCode, stdoutSha256 }) => { receipt = result; assert.equal(nativeExitCode, 7); assert.equal(stdoutSha256, undefined); },
  }), (error) => error === primary);
  assert.ok(receipt);
  assert.equal(receipt.stdoutCaptureIncomplete, true);
  assert.equal(receipt.stderrCaptureIncomplete, true);
  assert.equal(receipt.stdoutFile, undefined);
  assert.equal(receipt.stderrFile, undefined);
  assert.equal(receipt.stdout, "→tail\n");
  assert.equal(receipt.stderr, "→tail\n");
  assert.equal(receipt.stdoutTruncated, true);
  assert.equal(existsSync(join(root, "captures", "attempt-002")), false);
});

test("A capture-only failure preserves its error and separates observed from retained file bytes", async (t) => {
  const { root, retain } = await fixture(t);
  const first = join(root, "first-ack");
  const second = join(root, "second-ack");
  const stdout = join(root, "captures", "attempt-001", "stdout.log");
  const primary = Object.assign(new Error("injected capture append failure"), { code: "EIO" });
  const original = fs.appendFileSync;
  let writes = 0;
  fs.appendFileSync = ((path, ...args) => {
    if (String(path) === stdout) {
      writes++;
      if (writes === 2) { writeFileSync(second, ""); throw primary; }
      const result = original(path, ...args);
      writeFileSync(first, "");
      return result;
    }
    return original(path, ...args);
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  let receipt: Readonly<CommandTemplateExecResult> | undefined;
  try {
    await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", `const fs=require('node:fs');
      const wait=p=>new Promise(r=>{const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t);r()}},1)});
      (async()=>{process.stdout.write('first\\n');await wait(${JSON.stringify(first)});process.stdout.write('second\\n');
      await wait(${JSON.stringify(second)});process.stdout.write('tail\\n');process.exitCode=7})()`], {
      retry: 3, captureLimitBytes: 8, captureDir: join(root, "captures"), timeout: 5000,
      onAttemptManaged: ({ process }) => { retain(process); },
      onAttemptComplete: ({ result, nativeExitCode, stdoutSha256 }) => { receipt = result; assert.equal(nativeExitCode, 7); assert.equal(stdoutSha256, undefined); },
    }), (error) => error === primary);
  } finally { fs.appendFileSync = original; syncBuiltinESMExports(); }
  assert.ok(receipt);
  assert.equal(receipt.stdoutCaptureIncomplete, true);
  assert.equal(receipt.stdoutBytes, Buffer.byteLength("first\nsecond\ntail\n"));
  assert.equal(receipt.stdoutFileBytes, Buffer.byteLength("first\n"));
  assert.equal(receipt.stdoutFile, stdout);
  assert.equal(await readFile(stdout, "utf8"), "first\n");
  assert.match(receipt.stdout, /tail\n$/);
  assert.equal(writes, 2);
  assert.equal(existsSync(join(root, "captures", "attempt-002")), false);
});

test("An error on an already-live managed handle is not accepted as native exit", async (t) => {
  const { root, retain } = await fixture(t);
  const primary = new Error("live process error, not exit");
  let completions = 0;
  await assert.rejects(() => execCommandTemplate(process.execPath, ["-e", "console.log('still managed');process.exit(7)"], {
    retry: 3, captureDir: join(root, "captures"),
    onAttemptManaged: ({ process }) => { retain(process); process.emit("error", primary); },
    onAttemptComplete: ({ result, nativeExitCode }) => {
      completions++; assert.equal(nativeExitCode, 7); assert.match(result.stdout, /still managed/);
    },
  }), (error) => error === primary);
  assert.equal(completions, 1);
});

test("Normal retries expose distinct managed attempts and spawn errors fabricate no native exit", async (t) => {
  const { root } = await fixture(t);
  const marker = join(root, "count");
  const attempts: number[] = [];
  const result = await execCommandTemplate(process.execPath, ["-e", `const fs=require('node:fs');const p=${JSON.stringify(marker)};
    const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1;fs.writeFileSync(p,String(n));process.exit(n<3?7:0);`], {
    retry: 3,
    onAttemptManaged: (context) => { attempts.push(context.attempt); },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(attempts, [1, 2, 3]);
  let unknownBirth = false;
  let unknownExit = false;
  const failed = await execCommandTemplate(join(root, "missing-executable"), [], {
    onAttemptManaged: (context) => { unknownBirth = context.process.pid === undefined; },
    onAttemptComplete: (receipt) => { unknownExit = !Object.hasOwn(receipt, "nativeExitCode"); },
  });
  assert.equal(failed.code, 1);
  assert.equal(unknownBirth, true);
  assert.equal(unknownExit, true);
});

});
