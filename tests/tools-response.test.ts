import assert from "node:assert/strict";
import test from "node:test";

import {
  spaceToolError,
  spaceToolResult,
  withLeadingBlankLine,
} from "../lib/tools-response.ts";

test("tool output starts after one blank line", () => {
  assert.equal(withLeadingBlankLine("result"), "\n\nresult");
  assert.equal(withLeadingBlankLine("\nresult"), "\n\nresult");
  assert.equal(withLeadingBlankLine("\n\nresult"), "\n\nresult");
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
        { type: "text", text: "\n\nresult" },
        { type: "image", data: "unchanged" },
      ],
      details: { ok: true },
    },
  );
});

test("tool errors start after one blank line", () => {
  const error = new Error("failure");
  assert.equal(spaceToolError(error), error);
  assert.equal(error.message, "\n\nfailure");
  const repeated = spaceToolError(error) as Error;
  assert.equal(repeated.message, "\n\nfailure");
  assert.equal((spaceToolError("failure") as Error).message, "\n\nfailure");
});
