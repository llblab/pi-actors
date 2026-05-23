import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRoomMessage,
  ensureDefaultRoom,
  readCommunicationSnapshot,
  readRoomContacts,
  readRoomMessagePreviews,
  readRoomMessages,
  readRoomRoster,
  writeCommunicationSnapshot,
} from "../lib/actor-rooms.ts";

test("Actor rooms persist timelines, rosters, and communication snapshots", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    ensureDefaultRoom(stateDir, "demo");
    appendRoomMessage(stateDir, "main", {
      body: { caps: ["review"], claim: "Check risk", role: "reviewer" },
      from: "branch:demo/reviewer",
      summary: "Reviewer joined",
      to: "room:demo",
      type: "actor.join",
    });

    const roster = readRoomRoster(stateDir, "main");
    assert.equal(roster["run:demo"].role, "run");
    assert.equal(roster["branch:demo/reviewer"].role, "reviewer");
    assert.deepEqual(roster["branch:demo/reviewer"].caps, ["review"]);

    const messages = readRoomMessages(stateDir, "main");
    assert.equal(messages.length, 2);
    assert.equal(messages[1].type, "actor.join");
    assert.match(messages[1].received_at, /\d{4}-\d{2}-\d{2}T/);

    const snapshot = readCommunicationSnapshot(stateDir);
    assert.equal(snapshot?.root, "run:demo");
    assert.equal(snapshot?.self, "run:demo");
    assert.equal(snapshot?.rooms[0].address, "room:demo");
    assert.equal(snapshot?.rooms[0].members?.length, 2);
    assert.equal(snapshot?.contacts?.[0].address, "branch:demo/reviewer");
    assert.equal(snapshot?.parent, undefined);

    const branchSnapshot = JSON.parse(
      await readFile(join(stateDir, "branches", "reviewer", "communication.json"), "utf8"),
    );
    assert.equal(branchSnapshot.self, "branch:demo/reviewer");
    assert.equal(branchSnapshot.parent, "run:demo");
    assert.equal(branchSnapshot.contacts[0].address, "run:demo");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms remove members on actor.leave", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    appendRoomMessage(stateDir, "main", {
      from: "branch:demo/builder",
      to: "room:demo",
      type: "chat.message",
    });
    appendRoomMessage(stateDir, "main", {
      from: "branch:demo/builder",
      to: "room:demo",
      type: "actor.leave",
    });

    const roster = readRoomRoster(stateDir, "main");
    assert.equal(roster["branch:demo/builder"], undefined);
    assert.equal(readRoomMessages(stateDir, "main").length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms expose TUI-ready message previews", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    appendRoomMessage(stateDir, "main", {
      body: { text: "hello preview" },
      from: "branch:demo/reviewer",
      summary: "Preview me",
      to: "room:demo",
      type: "chat.message",
    });

    const previews = readRoomMessagePreviews(stateDir, "main");
    assert.equal(previews[0].from, "branch:demo/reviewer");
    assert.equal(previews[0].summary, "Preview me");
    assert.equal(previews[0].body_preview, '{"text":"hello preview"}');
    assert.match(previews[0].timestamp, /\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms expose contacts without the current actor", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    ensureDefaultRoom(stateDir, "demo");
    appendRoomMessage(stateDir, "main", {
      body: { role: "reviewer" },
      from: "branch:demo/reviewer",
      to: "room:demo",
      type: "actor.join",
    });

    const contacts = readRoomContacts(stateDir, "main", "branch:demo/reviewer");
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].address, "run:demo");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor communication snapshot can be written without room members", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    const snapshot = writeCommunicationSnapshot(stateDir, "empty");
    assert.equal(snapshot.root, "run:empty");
    assert.equal(snapshot.rooms[0].address, "room:empty");
    assert.equal(snapshot.rooms[0].members, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
