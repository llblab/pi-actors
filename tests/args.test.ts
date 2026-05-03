/**
 * Argument parsing regression tests
 * Covers arg/default parsing, normalized duplicate rejection, stored config normalization, and formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatArgs, normalizeStoredArgs, parseArgs } from "../lib/args.ts";
import {
  normalizeArgName,
  normalizeToolName,
  sanitizeFilePart,
} from "../lib/identity.ts";

test("Identifier helpers normalize tool and argument names", () => {
  assert.equal(normalizeToolName("Transcribe Groq!"), "transcribe_groq");
  assert.equal(normalizeArgName("1 File Path"), "arg_1_file_path");
  assert.equal(sanitizeFilePart("../bad name"), "bad_name");
});

test("Arg parser supports defaults and normalized duplicate rejection", () => {
  assert.deepEqual(parseArgs("file, lang=ru, model=voxtral-mini"), {
    args: ["file", "lang", "model"],
    defaults: { lang: "ru", model: "voxtral-mini" },
  });
  assert.deepEqual(parseArgs("file,file-path,file_path"), {
    args: [],
    defaults: {},
    error: "Duplicate argument name(s): file_path",
  });
});

test("Stored arg normalization preserves defaults and removes repeated args", () => {
  assert.deepEqual(
    normalizeStoredArgs(["file", "lang=en", "lang"], { lang: "ru" }),
    { args: ["file", "lang"], defaults: { lang: "ru" } },
  );
});

test("Arg formatter uses none for empty arg lists", () => {
  assert.equal(formatArgs([]), "none");
  assert.equal(formatArgs(["file", "lang"]), "file, lang");
});
