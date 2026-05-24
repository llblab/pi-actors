import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, access, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendBranchInboxMessage,
  appendRoomMessage,
  ensureDefaultRoom,
  getRoomStatus,
  readBranchInboxMessages,
  readCommunicationSnapshot,
  readRoomContacts,
  readRoomMessagePreviews,
  readRoomMessages,
  readRoomRoster,
  updateBranchInboxMessageStatus,
  writeCommunicationSnapshot,
} from "../lib/actor-rooms.ts";

const execFileAsync = promisify(execFile);

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

test("Actor rooms mark members inactive on actor.leave", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    appendRoomMessage(stateDir, "main", {
      body: { display: "Builder", role: "implementer" },
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
    assert.equal(roster["branch:demo/builder"].status, "left");
    assert.equal(roster["branch:demo/builder"].display, "Builder");
    assert.equal(roster["branch:demo/builder"].role, "implementer");
    assert.equal(readRoomMessages(stateDir, "main").length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms track branch inbox handling state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    appendRoomMessage(stateDir, "main", {
      from: "branch:demo/a",
      to: "room:demo",
      type: "actor.join",
    });
    appendBranchInboxMessage(stateDir, "demo", "branch:demo/a", {
      from: "branch:demo/b",
      to: "branch:demo/a",
      type: "task.assign",
    });
    const [queued] = readBranchInboxMessages(stateDir, "demo", "branch:demo/a");
    assert.equal(queued.status, "queued");
    assert.ok(queued.id);
    assert.equal(
      updateBranchInboxMessageStatus(
        stateDir,
        "demo",
        "branch:demo/a",
        queued.id!,
        "claimed",
        { claimed_by: "worker-a" },
      ),
      true,
    );
    const [claimed] = readBranchInboxMessages(stateDir, "demo", "branch:demo/a");
    assert.equal(claimed.status, "claimed");
    const claimedRecord: Record<string, unknown> = { ...claimed };
    assert.equal(claimedRecord.claimed_by, "worker-a");
    assert.match(String(claimedRecord.claimed_at ?? ""), /\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms debounce roster rewrites when only last_seen changes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  const previous = process.env.PI_ACTORS_ROOM_ROSTER_MIN_MS;
  process.env.PI_ACTORS_ROOM_ROSTER_MIN_MS = "10000";
  try {
    appendRoomMessage(stateDir, "main", {
      body: { role: "reviewer" },
      from: "branch:demo/a",
      to: "room:demo",
      type: "chat.message",
    });
    const rosterFile = join(stateDir, "rooms", "main", "roster.json");
    const firstMtime = (await stat(rosterFile)).mtimeMs;
    appendRoomMessage(stateDir, "main", {
      from: "branch:demo/a",
      to: "room:demo",
      type: "chat.message",
    });
    assert.equal((await stat(rosterFile)).mtimeMs, firstMtime);
    appendRoomMessage(stateDir, "main", {
      body: { role: "implementer" },
      from: "branch:demo/a",
      to: "room:demo",
      type: "chat.message",
    });
    assert.notEqual((await stat(rosterFile)).mtimeMs, firstMtime);
    assert.equal(readRoomRoster(stateDir, "main")["branch:demo/a"].role, "implementer");
  } finally {
    if (previous === undefined) delete process.env.PI_ACTORS_ROOM_ROSTER_MIN_MS;
    else process.env.PI_ACTORS_ROOM_ROSTER_MIN_MS = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms debounce bursty communication snapshot writes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  const previous = process.env.PI_ACTORS_COMMUNICATION_SNAPSHOT_MIN_MS;
  process.env.PI_ACTORS_COMMUNICATION_SNAPSHOT_MIN_MS = "10000";
  try {
    appendRoomMessage(stateDir, "main", {
      from: "branch:demo/a",
      to: "room:demo",
      type: "chat.message",
    });
    const branchSnapshot = join(stateDir, "branches", "a", "communication.json");
    const firstMtime = (await stat(branchSnapshot)).mtimeMs;
    appendRoomMessage(stateDir, "main", {
      from: "branch:demo/a",
      to: "room:demo",
      type: "chat.message",
    });
    const secondMtime = (await stat(branchSnapshot)).mtimeMs;
    assert.equal(secondMtime, firstMtime);
  } finally {
    if (previous === undefined) delete process.env.PI_ACTORS_COMMUNICATION_SNAPSHOT_MIN_MS;
    else process.env.PI_ACTORS_COMMUNICATION_SNAPSHOT_MIN_MS = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms preserve concurrent branch inbox appends", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-branch-inbox-concurrent-"));
  try {
    const script = `
      import { appendBranchInboxMessage } from ${JSON.stringify(join(process.cwd(), "lib", "actor-rooms.ts"))};
      appendBranchInboxMessage(process.argv[1], "demo", "branch:demo/worker", {
        body: { index: Number(process.argv[2]) },
        from: "branch:demo/sender-" + process.argv[2],
        to: "branch:demo/worker",
        type: "task.assign"
      });
    `;
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, stateDir, String(index)]),
      ),
    );
    const messages = readBranchInboxMessages(stateDir, "demo", "branch:demo/worker", 20);
    assert.equal(messages.length, 12);
    assert.deepEqual(new Set(messages.map((message) => message.status)), new Set(["queued"]));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms compact long room timelines", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  const previous = process.env.PI_ACTORS_ROOM_MAX_MESSAGES;
  process.env.PI_ACTORS_ROOM_MAX_MESSAGES = "3";
  try {
    for (let index = 0; index < 5; index += 1) {
      appendRoomMessage(stateDir, "main", {
        body: { index },
        from: `branch:demo/a${index}`,
        to: "room:demo",
        type: "chat.message",
      });
    }
    const messages = readRoomMessages(stateDir, "main", 10);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.map((message) => (message.body as { index: number }).index), [2, 3, 4]);
    await access(join(stateDir, "rooms", "main", "compaction.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_ACTORS_ROOM_MAX_MESSAGES;
    else process.env.PI_ACTORS_ROOM_MAX_MESSAGES = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms read bounded message tails", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    for (let index = 0; index < 75; index += 1) {
      appendRoomMessage(stateDir, "main", {
        body: { index },
        from: `branch:demo/worker-${index}`,
        to: "room:demo",
        type: "chat.message",
      });
    }
    const messages = readRoomMessages(stateDir, "main", 5);
    assert.equal(messages.length, 5);
    assert.deepEqual(
      messages.map((message) => (message.body as { index: number }).index),
      [70, 71, 72, 73, 74],
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor rooms read room status without losing count or last message metadata", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-state-"));
  try {
    for (let index = 0; index < 75; index += 1) {
      appendRoomMessage(stateDir, "main", {
        body: { index },
        from: `branch:demo/worker-${index}`,
        summary: `message ${index}`,
        to: "room:demo",
        type: "chat.message",
      });
    }
    const status = getRoomStatus(stateDir, "main");
    assert.equal(status.message_count, 75);
    assert.equal(status.last_message_from, "branch:demo/worker-74");
    assert.equal(status.last_message_summary, "message 74");
    assert.equal(status.last_message_type, "chat.message");
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

test("Actor rooms preserve concurrent multi-process appends", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-room-concurrent-"));
  try {
    const script = `
      import { appendRoomMessage } from ${JSON.stringify(join(process.cwd(), "lib", "actor-rooms.ts"))};
      appendRoomMessage(process.argv[1], "main", {
        body: { index: Number(process.argv[2]) },
        from: "branch:demo/worker-" + process.argv[2],
        to: "room:demo",
        type: "actor.join"
      });
    `;
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, stateDir, String(index)]),
      ),
    );
    const messages = readRoomMessages(stateDir, "main", 20);
    const roster = readRoomRoster(stateDir, "main");
    const snapshot = readCommunicationSnapshot(stateDir);
    assert.equal(messages.length, 12);
    assert.equal(Object.keys(roster).length, 12);
    assert.equal(snapshot?.rooms[0].members?.length, 12);
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
