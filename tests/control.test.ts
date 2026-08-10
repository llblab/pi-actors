import assert from "node:assert/strict";
import test from "node:test";

import { normalizeControlRequest } from "../lib/control.ts";
import { CONTROL_INPUT_MAX_BYTES } from "../lib/limits.ts";

test("Control requests normalize the exact public shape", () => {
  assert.deepEqual(
    normalizeControlRequest({
      action: "review.retry",
      input: { scope: "draft" },
      target: "runtime",
      verbose: false,
    }),
    {
      action: "review.retry",
      input: { scope: "draft" },
      target: "runtime",
      verbose: false,
    },
  );
  assert.deepEqual(normalizeControlRequest({ target: " run:review ", action: " pause " }), {
    action: "pause",
    target: "run:review",
  });
});

test("Control requests reject removed fields and targets with migration guidance", () => {
  assert.throws(
    () => normalizeControlRequest({ to: "run:review", type: "control.pause" }),
    /actor-message fields are removed: to, type; use target, action, input, verbose/,
  );
  for (const target of [
    "tool:demo",
    "branch:review/worker",
    "room:review",
    "coordinator",
    "session:demo",
    "session:all",
  ]) {
    assert.throws(
      () => normalizeControlRequest({ target, action: "pause" }),
      /use run:<id> or runtime/,
    );
  }
});

test("Control requests reject unknown fields and malformed values", () => {
  assert.throws(() => normalizeControlRequest(null), /must be an object/);
  assert.throws(() => normalizeControlRequest({ action: "pause" }), /target is required/);
  assert.throws(
    () => normalizeControlRequest({ target: "run:review" }),
    /action is required/,
  );
  assert.throws(
    () => normalizeControlRequest({ target: "run:review", action: "Control.Pause" }),
    /invalid control action/,
  );
  assert.throws(
    () => normalizeControlRequest({ target: "run:review", action: "pause", extra: true }),
    /unsupported control fields: extra/,
  );
  assert.throws(
    () => normalizeControlRequest({ target: "run:review", action: "pause", verbose: "yes" }),
    /verbose must be a boolean/,
  );
});

test("Control input stays JSON-serializable and bounded", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => normalizeControlRequest({ target: "run:review", action: "pause", input: cyclic }),
    /JSON-serializable/,
  );
  assert.throws(
    () =>
      normalizeControlRequest({
        target: "run:review",
        action: "pause",
        input: "x".repeat(CONTROL_INPUT_MAX_BYTES),
      }),
    /exceeds 65536 bytes/,
  );
});
