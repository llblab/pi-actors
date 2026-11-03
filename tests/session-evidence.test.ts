import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as SessionEvidence from "../lib/session-evidence.ts";

import {
  inspectBoundedActiveSessionEntries,
  readSessionEvidence,
  redactSessionEvidenceValue,
} from "../lib/session-evidence.ts";

function entry(value: unknown): string {
  return JSON.stringify(value);
}

test("Session chronology retains only bounded metadata before the visible turn tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-session-chronology-"));
  const file = join(root, "session.jsonl");
  const source = (count: number, sessionId = "session", privateId = false, validTime = true) => [
    entry({ type: "session", version: 3, id: sessionId }),
    ...Array.from({ length: count }, (_, index) => entry({ type: "message", id: privateId ? "token=HIDDEN" : `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null, timestamp: validTime ? new Date(index).toISOString() : "unknown",
      message: { role: "assistant", content: "BODY_CANARY_NEVER_IN_METADATA" } }))
  ].join("\n") + "\n";
  try {
    await writeFile(file, source(101));
    const evidence = readSessionEvidence(file);
    const frame = evidence[SessionEvidence.SESSION_EVIDENCE_CHRONOLOGY];
    assert.ok(frame);
    assert.equal(frame.state, "available");
    assert.equal(frame.basis, "recorded_branch_metadata");
    assert.equal(frame.entries.length, 101);
    assert.equal(evidence.turns.length, 100);
    assert.equal(evidence.turns[0].index, 2);
    assert.equal(frame.entries[0].ordinal, 1);
    assert.equal(frame.entries[100].ordinal, 101);
    assert.equal(frame.entries[1].identity, evidence.turns[0][SessionEvidence.SESSION_TURN_IDENTITY]);
    assert.doesNotMatch(JSON.stringify(frame), /BODY_CANARY|assistantText|userText|thinking|toolCalls|usage/);
    assert.doesNotMatch(JSON.stringify(evidence), /recorded_branch_metadata/);
    assert.equal(Object.getOwnPropertyDescriptor(evidence, SessionEvidence.SESSION_EVIDENCE_CHRONOLOGY)?.enumerable, false);
    assert.ok(Object.isFrozen(frame) && Object.isFrozen(frame.entries) && Object.isFrozen(frame.entries[0]));
    assert.equal(readSessionEvidence(file, { maxTurns: 1 })[SessionEvidence.SESSION_EVIDENCE_CHRONOLOGY]?.entries.length, 101);
    for (const [text, reason] of [[source(1, "session", true), "identity_unavailable"], [source(1, "session", false, false), "timestamp_unavailable"],
      [source(1100, "s".repeat(4000)), "metadata_too_large"], [source(520, "🌍".repeat(2000)), "metadata_too_large"],
      ["malformed JSON\n", "source_unavailable"]] as const) {
      await writeFile(file, text);
      const result = readSessionEvidence(file);
      const unavailable = result[SessionEvidence.SESSION_EVIDENCE_CHRONOLOGY]!;
      assert.equal(unavailable.state, "unavailable");
      if (unavailable.state === "unavailable") assert.equal(unavailable.reason, reason);
      assert.deepEqual(unavailable.entries, []);
      if (reason === "metadata_too_large") assert.equal(result.turns.length, 100, "Metadata budget is not a body/work quota");
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});

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

test("session evidence rejects oversized files before materializing JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-session-oversized-"));
  const file = join(root, "session.jsonl");
  try {
    await writeFile(
      file,
      `${entry({ type: "session", version: 3, id: "session" })}\n${"x".repeat(4_096)}`,
    );
    const evidence = readSessionEvidence(file, { maxBytes: 128 });
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.totalTurns, 0);
    assert.deepEqual(evidence.turns, []);
    assert.match(evidence.diagnostics[0].message, /exceeds bounded read limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded active session evidence distinguishes presence absence and uncertainty", () => {
  const entries = new Map<string, Record<string, unknown>>([
    ["root", { id: "root", parentId: null, type: "message" }],
    ["batch", { id: "batch", parentId: "root", type: "custom_message" }],
    ["leaf", { id: "leaf", parentId: "batch", type: "message" }],
  ]);
  const inspect = (matchId: string, maxEntries = 10) =>
    inspectBoundedActiveSessionEntries({
      getEntry: (id) => entries.get(id),
      leaf: entries.get("leaf"),
      match: (item) => item.id === matchId ? "present" : undefined,
      maxEntries,
    });
  assert.deepEqual(inspect("batch").status, "present");
  assert.deepEqual(inspect("missing").status, "absent");
  assert.deepEqual(inspect("root", 1).status, "unknown");
  assert.match(inspectBoundedActiveSessionEntries({
    getEntry: () => undefined,
    leaf: { content: "x".repeat(10_000), id: "large", parentId: null },
    match: () => undefined,
    maxBytes: 128,
  }).reason ?? "", /inspection bound/);

  entries.set("batch", { id: "batch", parentId: "missing" });
  assert.match(inspect("missing").reason ?? "", /parent is unavailable/);
  entries.set("batch", { id: "batch", parentId: "leaf" });
  assert.match(inspect("missing").reason ?? "", /cycle/);
  assert.equal(inspectBoundedActiveSessionEntries({
    getEntry: () => undefined,
    leaf: { id: "conflict", parentId: null },
    match: () => "conflict",
  }).status, "conflict");
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
