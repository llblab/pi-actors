import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeActorMessage, parseActorAddress } from "../lib/actor-messages.ts";
import {
  appendRoomMessage,
  readRoomMessages,
  readRoomRoster,
} from "../lib/actor-rooms.ts";
import {
  createInspectToolDefinition,
  createSpawnToolDefinition,
} from "../lib/tools.ts";

const MESSAGE_ENVELOPE_EXAMPLE = {
  to: "run:review",
  from: "coordinator",
  type: "control.approve",
  summary: "Approve checkpoint",
  body: "approve",
  reply_to: "msg_123",
  correlation_id: "task_456",
  metadata: {},
};

const ROOM_JOIN_EXAMPLE = {
  to: "room:review",
  from: "branch:review/security",
  type: "actor.join",
  summary: "Security reviewer joined",
  body: {
    role: "reviewer",
    caps: ["security-review", "risk-analysis"],
    claim: "Review auth boundary risks",
  },
};

const ROOM_LEAVE_EXAMPLE = {
  to: "room:review",
  from: "branch:review/security",
  type: "actor.leave",
};

const MAILBOX_CONTRACT_EXAMPLE = {
  mailbox: {
    accepts: [
      "control.continue",
      "control.revise",
      "control.approve",
      "control.stop",
    ],
    emits: ["checkpoint.needs_scope", "branch.done", "run.done"],
  },
};

const SPAWN_EXAMPLE = {
  recipe: "subagents-prompts.json",
  as: "run:review",
  values: {},
  artifacts: { report: "{state_dir}/report.md" },
};

const INSPECT_EXAMPLE = {
  target: "run:review",
  view: "status",
};

test("public protocol examples normalize and parse", () => {
  const envelope = normalizeActorMessage(MESSAGE_ENVELOPE_EXAMPLE);
  assert.equal(envelope.to, "run:review");
  assert.equal(parseActorAddress(envelope.to).kind, "run");
  assert.equal(parseActorAddress(String(envelope.from)).kind, "coordinator");

  const join = normalizeActorMessage(ROOM_JOIN_EXAMPLE);
  assert.equal(parseActorAddress(join.to).kind, "room");
  assert.equal(parseActorAddress(String(join.from)).kind, "branch");

  const leave = normalizeActorMessage(ROOM_LEAVE_EXAMPLE);
  assert.equal(leave.type, "actor.leave");

  assert.deepEqual(MAILBOX_CONTRACT_EXAMPLE.mailbox.accepts, [
    "control.continue",
    "control.revise",
    "control.approve",
    "control.stop",
  ]);
});

test("public room join and leave examples execute against room state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-protocol-examples-"));
  try {
    appendRoomMessage(stateDir, "main", normalizeActorMessage(ROOM_JOIN_EXAMPLE));
    let roster = readRoomRoster(stateDir, "main");
    assert.equal(roster["branch:review/security"].role, "reviewer");
    assert.deepEqual(roster["branch:review/security"].caps, [
      "security-review",
      "risk-analysis",
    ]);
    assert.equal(roster["branch:review/security"].claim, "Review auth boundary risks");

    appendRoomMessage(stateDir, "main", normalizeActorMessage(ROOM_LEAVE_EXAMPLE));
    roster = readRoomRoster(stateDir, "main");
    assert.equal(roster["branch:review/security"].status, "left");
    assert.deepEqual(
      readRoomMessages(stateDir, "main").map((message) => message.type),
      ["actor.join", "actor.leave"],
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("public spawn and inspect examples stay within tool schemas", () => {
  const spawn = createSpawnToolDefinition();
  const inspect = createInspectToolDefinition();
  const spawnProps = spawn.parameters.properties as Record<string, unknown>;
  const inspectProps = inspect.parameters.properties as Record<string, unknown>;
  for (const key of Object.keys(SPAWN_EXAMPLE)) {
    assert.equal(Object.hasOwn(spawnProps, key), true, `spawn property ${key}`);
  }
  for (const key of Object.keys(INSPECT_EXAMPLE)) {
    assert.equal(Object.hasOwn(inspectProps, key), true, `inspect property ${key}`);
  }
  assert.equal(parseActorAddress(SPAWN_EXAMPLE.as).kind, "run");
  assert.equal(parseActorAddress(INSPECT_EXAMPLE.target).kind, "run");
});
