/**
 * Registered tool execution output regression tests
 * Covers no-output formatting, failure formatting, and truncation notices
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as Limits from "../lib/limits.ts";
import {
  formatFailureOutput,
  formatOutput,
  formatToolText,
  trimToTailBytes,
  truncateTailContent,
} from "../lib/execution-output.ts";

test("Tool text formatter prefixes exactly one newline", () => {
  assert.equal(formatToolText("hello"), "\nhello");
  assert.equal(formatToolText("\nhello"), "\nhello");
});

test("Output formatter returns no-output marker for empty stdout", () => {
  assert.deepEqual(formatOutput("tool", "stdout", ""), {
    text: "\n(no output)",
    truncated: false,
  });
});

test("Failure formatter puts exit facts in a YAML header and keeps both stream bodies", () => {
  const output = formatFailureOutput("tool", 2, false, "partial", "boom");
  assert.equal(output.truncated, false);
  assert.equal(output.text, "\n---\nexit_code: 2\nkilled: false\n---\nstderr:\nboom\n\nstdout:\npartial");
});

test("Failure formatter stays metadata-only bare YAML when no stream text was selected", () => {
  assert.deepEqual(formatFailureOutput("tool", 2, true, "", " \n "), {
    text: "\nexit_code: 2\nkilled: true\n",
    truncated: false,
  });
});

test("Tail truncation preserves genuine replacement characters and exact byte counts at its budget boundary", () => {
  const tail = "\uFFFD\uFFFD" + "x".repeat(Limits.TOOL_OUTPUT_MAX_BYTES - 6);
  const content = "prefix-" + tail;
  const truncation = truncateTailContent(content);
  assert.equal(truncation.content, tail);
  assert.equal(truncation.truncated, true);
  assert.equal(truncation.outputBytes, Limits.TOOL_OUTPUT_MAX_BYTES);
  assert.equal(truncation.totalBytes, Buffer.byteLength(content));
  assert.equal(truncation.outputLines, 1);
  assert.equal(truncation.totalLines, 1);
});

test("Byte tails are maximal scalar-boundary UTF-8 suffixes, not replacement-character repair", () => {
  for (const value of ["", "ASCII", "a\uFFFD", "🙂\uFFFD\uFFFDtail", "A界é🙂e\u0301\r\n\uFFFDZ"]) {
    const points = [...value];
    const suffixes = points.map((_, index) => points.slice(index).join("")).concat("");
    for (let budget = 0; budget <= Buffer.byteLength(value) + 1; budget += 0.5) {
      const expected = suffixes.find(suffix => Buffer.byteLength(suffix) <= budget);
      assert.equal(trimToTailBytes(value, budget), expected, JSON.stringify({ value, budget }));
    }
  }
});

test("Output and inspect limits are centralized", () => {
  assert.equal(Limits.DEFAULT_INSPECT_LINES, 40);
  assert.equal(Limits.TOOL_OUTPUT_MAX_LINES, 2_000);
  assert.equal(Limits.INSPECTOR_BODY_PREVIEW_CHARS, 320);
});
