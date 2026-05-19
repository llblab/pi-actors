/**
 * Auto-tools schema regression tests
 * Covers registry arg declarations, forgiving persisted normalization, and placeholder-derived tool args
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatToolArgs,
  getToolArgNames,
  getTemplateArgTypes,
  normalizeRuntimeValues,
  normalizeStoredToolArgDeclarations,
  parseToolArgDeclarations,
} from "../lib/schema.ts";

test("Tool arg declarations parse defaults and reject duplicates", () => {
  const parsed = parseToolArgDeclarations("file, lang=ru, model=voxtral-mini");
  assert.deepEqual(parsed.args, ["file", "lang", "model"]);
  assert.deepEqual(parsed.defaults, { lang: "ru", model: "voxtral-mini" });
  assert.deepEqual(parsed.declarations, ["file", "lang", "model"]);
  assert.deepEqual(parseToolArgDeclarations("file,file"), {
    args: [],
    argTypes: {},
    declarations: [],
    defaults: {},
    error: "Duplicate argument name(s): file",
  });
});

test("Tool arg declarations parse progressive compact types", () => {
  const parsed = parseToolArgDeclarations(
    "file:path, out_dir:path, timeout:int=60000, speed:number=1.5, dry_run:bool=true, prompts:array, mode:enum(check,fix)=check",
  );
  assert.deepEqual(parsed.args, [
    "file",
    "out_dir",
    "timeout",
    "speed",
    "dry_run",
    "prompts",
    "mode",
  ]);
  assert.deepEqual(parsed.declarations, [
    "file:path",
    "out_dir:path",
    "timeout:int",
    "speed:number",
    "dry_run:bool",
    "prompts:array",
    "mode:enum(check,fix)",
  ]);
  assert.deepEqual(parsed.defaults, {
    dry_run: "true",
    mode: "check",
    speed: "1.5",
    timeout: "60000",
  });
  assert.deepEqual(parsed.argTypes.mode, {
    kind: "enum",
    values: ["check", "fix"],
  });
});

test("Typed runtime values normalize and reject invalid values", () => {
  const parsed = parseToolArgDeclarations(
    "timeout:int, speed:number, dry_run:bool, mode:enum(check,fix), prompts:array",
  );
  assert.deepEqual(
    normalizeRuntimeValues(
      {
        timeout: 42,
        speed: 1.5,
        dry_run: false,
        mode: "fix",
        prompts: '["a","b"]',
      },
      parsed.argTypes,
    ),
    {
      timeout: "42",
      speed: "1.5",
      dry_run: "false",
      mode: "fix",
      prompts: ["a", "b"],
    },
  );
  assert.throws(
    () => normalizeRuntimeValues({ mode: "delete" }, parsed.argTypes),
    /must be one of: check, fix/,
  );
});

test("Stored tool arg declarations normalize forgiving input", () => {
  const normalized = normalizeStoredToolArgDeclarations(
    ["file", "lang=en", "lang"],
    { lang: "ru" },
  );
  assert.deepEqual(normalized.args, ["file", "lang"]);
  assert.deepEqual(normalized.defaults, { lang: "ru" });
  assert.equal(normalized.provided, true);
});

test("Tool arg names are derived from placeholders when args are omitted", () => {
  assert.deepEqual(
    getToolArgNames("tool {file} {lang=ru} {model-name=default}"),
    ["file", "lang", "model-name"],
  );
  assert.deepEqual(
    getToolArgNames(
      "tool {file:path} {timeout:int=60000} {speed:number=1.5} {mode:enum(check,fix)=check}",
    ),
    ["file", "timeout", "speed", "mode"],
  );
  assert.deepEqual(
    getTemplateArgTypes(
      "tool {file:path} {timeout:int=60000} {speed:number=1.5}",
    ),
    {
      file: { kind: "path" },
      speed: { kind: "number" },
      timeout: { kind: "int" },
    },
  );
  assert.deepEqual(
    getToolArgNames({
      recover: "cleanup {work_dir}",
      template: "run {scope}",
    }),
    ["scope", "work_dir"],
  );
  assert.equal(formatToolArgs([]), "none");
  assert.equal(formatToolArgs(["file", "lang"]), "file, lang");
});
