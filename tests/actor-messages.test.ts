import assert from "node:assert/strict";
import test from "node:test";

import {
  formatActorAddress,
  normalizeActorMessage,
  parseActorAddress,
} from "../lib/actor-messages.ts";

test("Actor addresses parse and format supported endpoint kinds", () => {
  assert.deepEqual(parseActorAddress("coordinator"), { kind: "coordinator" });
  assert.deepEqual(parseActorAddress("run:review"), {
    kind: "run",
    value: "review",
  });
  assert.deepEqual(parseActorAddress("branch:review/2"), {
    branch: "2",
    kind: "branch",
    value: "review",
  });
  assert.deepEqual(parseActorAddress("room:review"), {
    kind: "room",
    room: "main",
    value: "review",
  });
  assert.equal(
    formatActorAddress({ branch: "2", kind: "branch", value: "review" }),
    "branch:review/2",
  );
  assert.equal(
    formatActorAddress({ kind: "room", room: "main", value: "review" }),
    "room:review",
  );
});

test("Actor addresses reject transport-shaped or ambiguous values", () => {
  assert.throws(() => parseActorAddress("review"), /must include kind/);
  assert.throws(() => parseActorAddress("run:"), /run address is required/);
  assert.throws(() => parseActorAddress("branch:review"), /branch id is required/);
  assert.throws(
    () => parseActorAddress("room:review/side"),
    /Task rooms do not support named subrooms/,
  );
  assert.throws(() => parseActorAddress("file:/tmp/outbox.jsonl"), /Unsupported actor address kind/);
});

test("Actor messages normalize one symmetric envelope", () => {
  assert.deepEqual(
    normalizeActorMessage({
      body: "approve",
      from: "coordinator",
      metadata: { urgent: true },
      reply_to: "msg_1",
      summary: "Approve checkpoint",
      to: "run:review",
      type: "control.approve",
    }),
    {
      body: "approve",
      from: "coordinator",
      metadata: { urgent: true },
      reply_to: "msg_1",
      summary: "Approve checkpoint",
      to: "run:review",
      type: "control.approve",
    },
  );
});

test("Actor messages validate required address and type", () => {
  assert.throws(() => normalizeActorMessage({ type: "control.approve" }), /message.to is required/);
  assert.throws(() => normalizeActorMessage({ to: "run:review" }), /message.type is required/);
  assert.throws(
    () => normalizeActorMessage({ to: "run:review", type: "control approve" }),
    /message.type contains unsupported characters/,
  );
});

test("Actor messages leave delivery to routing policy", () => {
  assert.deepEqual(
    normalizeActorMessage({ to: "coordinator", type: "checkpoint.ready" }),
    { to: "coordinator", type: "checkpoint.ready" },
  );
  assert.deepEqual(
    normalizeActorMessage({ to: "run:review", type: "control.approve" }),
    { to: "run:review", type: "control.approve" },
  );
  assert.deepEqual(
    normalizeActorMessage({ to: "room:review", type: "actor.join" }),
    { to: "room:review", type: "actor.join" },
  );
});
