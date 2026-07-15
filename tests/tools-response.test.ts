import assert from "node:assert/strict";
import test from "node:test";

import {
  spaceToolError,
  spaceToolResult,
  withLeadingLineBreak,
} from "../lib/tools-response.ts";

test("tool output contributes exactly one leading line break", () => {
  assert.equal(withLeadingLineBreak("result"), "\nresult");
  assert.equal(withLeadingLineBreak("\nresult"), "\nresult");
  assert.equal(withLeadingLineBreak("\n\nresult"), "\nresult");
  assert.equal(`header\n${withLeadingLineBreak("\n\nresult")}`, "header\n\nresult");
  assert.deepEqual(
    spaceToolResult({
      content: [
        { type: "text", text: "result" },
        { type: "image", data: "unchanged" },
      ],
      details: { ok: true },
    }),
    {
      content: [
        { type: "text", text: "\nresult" },
        { type: "image", data: "unchanged" },
      ],
      details: { ok: true },
    },
  );
});

test("tool errors contribute exactly one leading line break", () => {
  const error = new Error("failure");
  assert.equal(spaceToolError(error), error);
  assert.equal(error.message, "\nfailure");
  const repeated = spaceToolError(error) as Error;
  assert.equal(repeated.message, "\nfailure");
  assert.equal((spaceToolError("failure") as Error).message, "\nfailure");
});
