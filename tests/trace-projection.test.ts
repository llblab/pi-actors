import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectRunTrace } from "../lib/trace-projection.ts";

test("Trace projection merges causal Run evidence newest-first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", "report.md"), "report\n");
    await writeFile(join(root, "stdout.log"), "hello\n");
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify({ id: "trace-1", ts: "2026-01-01T00:00:01.000Z", kind: "run.start", data: { pid: 1 } })}\n`,
    );
    await writeFile(
      join(root, "controls.jsonl"),
      `${JSON.stringify({ id: "control-1", run_instance_id: "generation-a", action: "pause", input: { apiKey: "secret" }, status: "handled", queued_at: "2026-01-01T00:00:02.000Z", handled_at: "2026-01-01T00:00:03.000Z" })}\n`,
    );
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({ code: 0, completedAt: "2026-01-01T00:00:04.000Z" }),
    );
    const items = projectRunTrace(root, {
      artifacts: { report: join(root, "artifacts", "report.md") },
    });
    assert.deepEqual(
      items.map((item) => item.ts),
      items.map((item) => item.ts).toSorted().reverse(),
    );
    assert.equal(items.some((item) => item.kind === "process.result"), true);
    assert.equal(items.some((item) => item.kind === "run.start"), true);
    assert.equal(items.some((item) => item.kind === "control.handled"), true);
    assert.equal(items.some((item) => item.kind === "process.stdout"), true);
    assert.equal(items.some((item) => item.kind === "artifact.ready"), true);
    assert.equal(JSON.stringify(items).includes("secret"), false);
    assert.equal(JSON.stringify(items).includes("[REDACTED]"), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection preserves rich owned agent turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    const sessionDir = join(root, "sessions", "command-001");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(root, "execution.json"),
      JSON.stringify({
        commands: [{
          id: "command-001",
          session_files: ["sessions/command-001/session.jsonl"],
          stage: "reviewer",
        }],
      }),
    );
    await writeFile(
      join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "session" }),
        JSON.stringify({
          type: "message",
          id: "u",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "Audit Trace" },
        }),
        JSON.stringify({
          type: "message",
          id: "a",
          parentId: "u",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            model: "test/model",
            stopReason: "toolUse",
            content: [
              { type: "thinking", thinking: "Persisted thought" },
              { type: "text", text: "Audit complete" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { apiKey: "secret" } },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "r",
          parentId: "a",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "Result" }],
          },
        }),
      ].join("\n"),
    );
    const items = projectRunTrace(root, { source: "agent" });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "agent.turn");
    const detail = items[0]?.detail as Record<string, unknown>;
    assert.equal(detail.thinking, "Persisted thought");
    assert.equal((detail.toolCalls as unknown[]).length, 1);
    assert.equal(JSON.stringify(detail).includes("secret"), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection filters sources and keeps malformed evidence diagnosable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    await writeFile(
      join(root, "controls.jsonl"),
      `{bad json}\n${JSON.stringify({ id: "control-1", run_instance_id: "generation-a", action: "pause", status: "failed", queued_at: "2026-01-01T00:00:00.000Z", failed_at: "2026-01-01T00:00:01.000Z", error: "not ready" })}\n`,
    );
    const controls = projectRunTrace(root, { source: "control" });
    assert.equal(controls.length, 1);
    assert.equal(controls[0]?.kind, "control.failed");
    const runtime = projectRunTrace(root, { source: "runtime" });
    assert.equal(runtime.length, 1);
    assert.equal(runtime[0]?.kind, "state.read_error");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection applies a deterministic global bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    const events = Array.from({ length: 20 }, (_, index) => ({
      id: `trace-${index}`,
      ts: new Date(index).toISOString(),
      kind: "runtime.note",
    }));
    await writeFile(
      join(root, "trace.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const items = projectRunTrace(root, { limit: 3 });
    assert.deepEqual(items.map((item) => item.id), ["trace-19", "trace-18", "trace-17"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
