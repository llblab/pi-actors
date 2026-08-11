import assert from "node:assert/strict";
import test from "node:test";

import { normalizeControlRequest } from "../lib/control.ts";
import * as Limits from "../lib/limits.ts";

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
  assert.deepEqual(
    normalizeControlRequest({
      target: "run:review",
      action: "pause",
      input: { keep: true, omitted: undefined },
    }),
    { target: "run:review", action: "pause", input: { keep: true } },
  );
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

test("Control action and serialized input use portable boundaries", () => {
  const action = "a".repeat(Limits.CONTROL_ACTION_MAX_LENGTH);
  assert.equal(
    normalizeControlRequest({ target: "run:review", action }).action,
    action,
  );
  assert.throws(
    () => normalizeControlRequest({ target: "run:review", action: `${action}a` }),
    /exceeds 64 ASCII characters/,
  );

  const validInputs = [
    "x".repeat(378),
    "é".repeat(189),
    '"'.repeat(189),
    { data: "x".repeat(369) },
    ["x".repeat(376)],
  ];
  for (const input of validInputs) {
    assert.equal(Buffer.byteLength(JSON.stringify(input)), Limits.CONTROL_INPUT_MAX_BYTES);
    assert.deepEqual(
      normalizeControlRequest({ target: "run:review", action: "pause", input }).input,
      input,
    );
  }
  assert.throws(
    () => normalizeControlRequest({
      target: "run:review",
      action: "pause",
      input: "x".repeat(379),
    }),
    /exceeds 380 serialized bytes/,
  );
  assert.throws(
    () => normalizeControlRequest({
      target: "run:review",
      action: "pause",
      input: "é".repeat(190),
    }),
    /exceeds 380 serialized bytes/,
  );
});

test("Control input rejects cyclic values and remains optional", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => normalizeControlRequest({ target: "run:review", action: "pause", input: cyclic }),
    /JSON-serializable/,
  );
  assert.deepEqual(
    normalizeControlRequest({ target: "run:review", action: "pause" }),
    { target: "run:review", action: "pause" },
  );
});
