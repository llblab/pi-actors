/**
 * Command-template regression tests
 * Covers shell-free splitting, executable expansion, defaults, inline placeholder resolution, and composition expansion
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandTemplateInvocation,
  execCommandTemplate,
  expandCommandTemplateConfigs,
  getCommandTemplateRiskLabels,
  getCommandTemplateWarnings,
  resolveInheritedDefaultReferences,
  splitCommandTemplate,
} from "../lib/command-templates.ts";

test("Command templates split shell-like words without invoking a shell", () => {
  assert.deepEqual(
    splitCommandTemplate("tool 'literal words' --name hello\\ world"),
    ["tool", "literal words", "--name", "hello world"],
  );
});

test("Command templates accept shorthand string configs", () => {
  const invocation = buildCommandTemplateInvocation(
    "./tts --text {text} --lang {lang=ru}",
    { text: "hello world" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/tts",
    args: ["--text", "hello world", "--lang", "ru"],
  });
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
    command: "/work/tts",
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
  });
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

test("Command template retry succeeds on second attempt", async () => {
  const counterFile = `/tmp/ct-retry-${process.pid}.txt`;
  const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(counterFile, "0");
  const script = `
    const fs = require("fs");
    const p = "${counterFile}";
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
