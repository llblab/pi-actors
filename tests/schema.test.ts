/**
 * Auto-tools schema regression tests
 * Covers registry arg declarations, forgiving persisted normalization, and placeholder-derived tool args
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatToolArgs,
  getToolArgNames,
  normalizeStoredToolArgDeclarations,
  parseToolArgDeclarations,
} from "../lib/schema.ts";

test("Tool arg declarations parse defaults and reject duplicates", () => {
  assert.deepEqual(
    parseToolArgDeclarations("file, lang=ru, model=voxtral-mini"),
    {
      args: ["file", "lang", "model"],
      defaults: { lang: "ru", model: "voxtral-mini" },
    },
  );
  assert.deepEqual(parseToolArgDeclarations("file,file"), {
    args: [],
    defaults: {},
    error: "Duplicate argument name(s): file",
  });
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
  assert.equal(formatToolArgs([]), "none");
  assert.equal(formatToolArgs(["file", "lang"]), "file, lang");
});
