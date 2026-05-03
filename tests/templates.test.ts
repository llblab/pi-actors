/**
 * Command-template regression tests
 * Covers split-first placeholder substitution, quoting, embedded placeholders, defaults, and command expansion
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTemplateInvocation,
  resolveTemplateCommand,
  splitShellWords,
} from "../lib/templates.ts";

test("Template splitter honors simple quotes and escapes", () => {
  assert.deepEqual(
    splitShellWords("cmd 'literal words' \"more words\" a\\ b"),
    ["cmd", "literal words", "more words", "a b"],
  );
});

test("Template invocation substitutes placeholders after splitting", () => {
  const invocation = buildTemplateInvocation(
    "~/bin/transcribe {file} {lang} {model}",
    { file: "/tmp/voice one.ogg", lang: "ru" },
    ["file", "lang", "model"],
    { model: "voxtral-mini-latest" },
  );
  assert.deepEqual(invocation, {
    command: "~/bin/transcribe",
    args: ["/tmp/voice one.ogg", "ru", "voxtral-mini-latest"],
  });
});

test("Template invocation preserves embedded placeholder values as one argv item", () => {
  const invocation = buildTemplateInvocation(
    "tool --file={file} --label '{literal label}' {missing}",
    { file: "/tmp/a b.ogg" },
    ["file", "missing"],
    {},
  );
  assert.deepEqual(invocation, {
    command: "tool",
    args: ["--file=/tmp/a b.ogg", "--label", "{literal label}", ""],
  });
});

test("Template command resolver expands only home-prefixed commands", () => {
  assert.equal(
    resolveTemplateCommand("~/bin/tool"),
    join(homedir(), "bin/tool"),
  );
  assert.equal(resolveTemplateCommand("tool"), "tool");
  assert.equal(resolveTemplateCommand("./tool"), "./tool");
});
