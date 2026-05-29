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

test("Failure formatter includes stderr and stdout sections", () => {
  const output = formatFailureOutput("tool", 2, false, "partial", "boom");
  assert.equal(output.truncated, false);
  assert.match(output.text, /Exit code 2/);
  assert.match(output.text, /stderr:\nboom/);
  assert.match(output.text, /stdout:\npartial/);
});

test("Tail truncation reports byte truncation", () => {
  const truncation = truncateTailContent("x".repeat(60 * 1024));
  assert.equal(truncation.truncated, true);
  assert.equal(truncation.outputBytes <= Limits.TOOL_OUTPUT_MAX_BYTES, true);
});

test("Output and inspect limits are centralized", () => {
  assert.equal(Limits.DEFAULT_INSPECT_LINES, 40);
  assert.equal(Limits.TOOL_OUTPUT_MAX_LINES, 2_000);
  assert.equal(Limits.INSPECTOR_BODY_PREVIEW_CHARS, Limits.ROOM_MESSAGE_PREVIEW_CHARS);
});
