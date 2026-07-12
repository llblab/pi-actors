import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readActorInspectorPreviews,
  readActorInspectorRuns,
  readActorInspectorTurns,
} from "../lib/inspector.ts";

async function writeRun(
  root: string,
  run: string,
  ownerId: string,
): Promise<string> {
  const stateDir = join(root, run);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({ ownerId, run }),
  );
  await writeFile(
    join(stateDir, "progress.json"),
    JSON.stringify({ phase: "done" }),
  );
  return stateDir;
}

test("inspector rejects stale cross-session run selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-owner-"));
  try {
    await writeRun(root, "foreign", "old-owner");
    await writeRun(root, "owned", "new-owner");
    const runs = readActorInspectorRuns(root, "new-owner");
    assert.deepEqual(runs.map((item) => item.run), ["owned"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspector contains manifest session paths beneath owned run sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-path-"));
  try {
    const owned = await writeRun(root, "owned", "owner");
    const foreign = await writeRun(root, "foreign", "other");
    const foreignSession = join(foreign, "sessions", "secret", "session.jsonl");
    await mkdir(join(foreign, "sessions", "secret"), { recursive: true });
    await writeFile(
      foreignSession,
      [
        JSON.stringify({ type: "session", version: 3, id: "secret" }),
        JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "FOREIGN_SECRET" } }),
      ].join("\n"),
    );
    await writeFile(
      join(owned, "review-evidence.json"),
      JSON.stringify({
        commands: [
          {
            id: "escape",
            session_files: ["../foreign/sessions/secret/session.jsonl"],
          },
        ],
      }),
    );
    const output = JSON.stringify(readActorInspectorTurns(owned));
    assert.equal(output, "[]");
    assert.doesNotMatch(output, /FOREIGN_SECRET/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("communication previews redact secret-bearing bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-redact-"));
  try {
    const stateDir = await writeRun(root, "owned", "owner");
    await writeFile(
      join(stateDir, "inbox.jsonl"),
      `${JSON.stringify({
        body: {
          clientSecret: "hidden-client",
          note: '{"private_key":"hidden-key"}',
          token: "hidden-token",
        },
        from: "coordinator",
        received_at: "2026-01-01T00:00:00.000Z",
        to: "run:owned",
        type: "task.assign",
      })}\n`,
    );
    const output = JSON.stringify(
      readActorInspectorPreviews(root, 10, { ownerId: "owner" }),
    );
    assert.doesNotMatch(output, /hidden-client|hidden-key|hidden-token/);
    assert.match(output, /REDACTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
