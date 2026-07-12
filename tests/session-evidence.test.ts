import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readSessionEvidence,
  redactSessionEvidenceValue,
} from "../lib/session-evidence.ts";

function entry(value: unknown): string {
  return JSON.stringify(value);
}

test("session evidence follows the latest active branch and correlates tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-session-evidence-"));
  const file = join(root, "session.jsonl");
  try {
    await writeFile(
      file,
      [
        entry({ type: "session", version: 3, id: "session", cwd: "/repo" }),
        entry({ type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "review" } }),
        entry({ type: "message", id: "old", parentId: "u1", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "discarded branch" }] } }),
        entry({ type: "message", id: "old-user", parentId: "old", timestamp: "3", message: { role: "user", content: "discarded" } }),
        entry({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "4",
          message: {
            role: "assistant",
            provider: "test",
            model: "model",
            stopReason: "toolUse",
            usage: { totalTokens: 12 },
            content: [
              { type: "thinking", thinking: "host-visible thought" },
              { type: "text", text: "checking" },
              { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a", token: "hide" } },
              { type: "toolCall", id: "call-b", name: "bash", arguments: { command: "echo ok" } },
            ],
          },
        }),
        entry({ type: "message", id: "r-b", parentId: "a1", timestamp: "5", message: { role: "toolResult", toolCallId: "call-b", toolName: "bash", content: [{ type: "text", text: "b" }], isError: false } }),
        entry({ type: "message", id: "r-a", parentId: "r-b", timestamp: "6", message: { role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "token=secret-value" }], isError: true } }),
        entry({ type: "message", id: "orphan", parentId: "r-a", timestamp: "7", message: { role: "toolResult", toolCallId: "missing", toolName: "read", content: [], isError: false } }),
        "{malformed",
      ].join("\n"),
    );
    const evidence = readSessionEvidence(file);
    assert.equal(evidence.activeLeafId, "orphan");
    assert.equal(evidence.totalTurns, 1);
    assert.equal(evidence.turns[0].userText, "review");
    assert.equal(evidence.turns[0].assistantText, "checking");
    assert.equal(evidence.turns[0].thinking, "host-visible thought");
    assert.equal(evidence.turns[0].provider, "test");
    assert.equal(evidence.turns[0].model, "model");
    assert.equal(evidence.turns[0].toolCalls[0].name, "read");
    assert.deepEqual(evidence.turns[0].toolCalls[0].arguments, {
      path: "a",
      token: "[REDACTED]",
    });
    assert.deepEqual(evidence.turns[0].toolCalls[0].result, [
      { type: "text", text: "token=[REDACTED]" },
    ]);
    assert.equal(evidence.turns[0].toolCalls[0].resultError, true);
    assert.equal(evidence.turns[0].toolCalls[1].resultError, false);
    assert.equal(evidence.turns[0].unmatchedToolResults, 1);
    assert.equal(evidence.diagnostics.length, 1);
    assert.doesNotMatch(JSON.stringify(evidence), /discarded branch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session evidence remains bounded and reports incomplete parent chains", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-session-bounds-"));
  const file = join(root, "session.jsonl");
  try {
    await writeFile(
      file,
      [
        entry({ type: "session", version: 3, id: "session" }),
        entry({ type: "message", id: "u1", parentId: "missing", message: { role: "user", content: "first secret=hidden" } }),
        entry({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "123456789" }] } }),
        entry({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "second" } }),
      ].join("\n"),
    );
    const evidence = readSessionEvidence(file, { maxTextChars: 5, maxTurns: 1 });
    assert.equal(evidence.totalTurns, 2);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.turns.length, 1);
    assert.equal(evidence.turns[0].index, 2);
    assert.equal(evidence.turns[0].userText, "seco…");
    assert.match(evidence.diagnostics[0].message, /missing parent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session evidence redaction handles nested values and circular objects", () => {
  const circular: Record<string, unknown> = {
    authorization: "Bearer secret",
    clientSecret: "client-secret",
    private_key: "private-secret",
    safeCount: 7,
    serialized: '{"token":"quoted-secret"}',
  };
  circular.self = circular;
  assert.deepEqual(redactSessionEvidenceValue(circular), {
    authorization: "[REDACTED]",
    clientSecret: "[REDACTED]",
    private_key: "[REDACTED]",
    safeCount: 7,
    serialized: '{"token":"[REDACTED]"}',
    self: "[CIRCULAR]",
  });
});
