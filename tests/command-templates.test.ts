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
    },
    {
      template: "ffmpeg -i {mp3} {ogg} {codec}",
      args: ["text", "lang", "mp3", "ogg"],
      defaults: { lang: "en", codec: "opus" },
      timeout: 123,
    },
  ]);
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

test("Command templates report missing required placeholders", () => {
  assert.throws(
    () => buildCommandTemplateInvocation("tool {missing}", {}, "/work"),
    /Missing command template value: missing/,
  );
});
