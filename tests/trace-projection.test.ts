import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TRACE_JOURNAL_MAX_BYTES } from "../lib/limits.ts";
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

test("Trace projection uses physical source order for equal timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-order-"));
  const ts = "2026-01-01T00:00:00.000Z";
  try {
    await writeFile(join(root, "trace.jsonl"), [
      { id: "z-trace-first", ts, kind: "run.start" },
      { id: "a-trace-second", ts, kind: "run.progress" },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    await writeFile(join(root, "controls.jsonl"), [
      { id: "z-control-first", run_instance_id: "g", action: "pause", status: "queued", queued_at: ts },
      { id: "a-control-second", run_instance_id: "g", action: "resume", status: "queued", queued_at: ts },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const sessionDir = join(root, "sessions", "command-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(root, "execution.json"), JSON.stringify({
      commands: [{ id: "command-1", session_files: ["sessions/command-1/session.jsonl"] }],
    }));
    await writeFile(join(sessionDir, "session.jsonl"), [
      { type: "session", version: 3, id: "session" },
      { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "first user" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: "first agent" } },
      { type: "message", id: "u2", parentId: "a1", timestamp: ts, message: { role: "user", content: "second user" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: ts, message: { role: "assistant", content: "second agent" } },
    ].map((value) => JSON.stringify(value)).join("\n"));
    assert.deepEqual(
      projectRunTrace(root, { source: "lifecycle" }).map(({ id }) => id),
      ["a-trace-second", "z-trace-first"],
    );
    assert.deepEqual(
      projectRunTrace(root, { source: "control" }).map(({ id }) => id),
      ["control:a-control-second", "control:z-control-first"],
    );
    assert.deepEqual(
      projectRunTrace(root, { source: "agent" }).map(({ summary }) => summary),
      ["second agent", "first agent"],
    );
    const expected = [
      "a-trace-second",
      "z-trace-first",
      "control:a-control-second",
      "control:z-control-first",
      "agent:command-1:sessions/command-1/session.jsonl:2",
      "agent:command-1:sessions/command-1/session.jsonl:1",
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(projectRunTrace(root).map(({ id }) => id), expected);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection preserves rich owned agent turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    const sessionDir = join(root, "sessions", "command-001");
    const minimalSessionDir = join(root, "sessions", "command-002");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(minimalSessionDir, { recursive: true });
    await writeFile(join(root, "outside.jsonl"), "OUTSIDE_SESSION_SECRET\n");
    await writeFile(
      join(root, "execution.json"),
      JSON.stringify({
        commands: [
          {
            id: "command-001",
            session_files: [
              "sessions/command-001/session.jsonl",
              "outside.jsonl",
            ],
            stage: "reviewer",
          },
          {
            id: "command-002",
            session_files: ["sessions/command-002/session.jsonl"],
            stage: "worker",
          },
        ],
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
            errorMessage: "authorization=AGENT_ERROR_SECRET unavailable",
            model: "test/model",
            provider: "test",
            stopReason: "toolUse",
            usage: { input: 12, output: 7, token: "AGENT_USAGE_SECRET" },
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
            content: [{ type: "text", text: "Result token=AGENT_RESULT_SECRET" }],
            isError: true,
          },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(minimalSessionDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "minimal" }),
        JSON.stringify({
          type: "message",
          id: "u2",
          parentId: null,
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "Run check" },
        }),
        JSON.stringify({
          type: "message",
          id: "a2",
          parentId: "u2",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "assistant", content: "Check complete" },
        }),
      ].join("\n"),
    );
    const items = projectRunTrace(root, { source: "agent" });
    assert.equal(items.length, 2);
    assert.equal(items.every((item) => item.kind === "agent.turn"), true);
    const rich = items.find((item) =>
      (item.detail as Record<string, unknown>).commandId === "command-001"
    )?.detail as Record<string, any>;
    assert.equal(rich.userText, "Audit Trace");
    assert.equal(rich.assistantText, "Audit complete");
    assert.equal(rich.thinking, "Persisted thought");
    assert.deepEqual(rich.usage, { input: 12, output: 7, token: "[REDACTED]" });
    assert.match(rich.error, /\[REDACTED\]/);
    assert.equal(rich.toolCalls[0].name, "read");
    assert.equal(rich.toolCalls[0].resultError, true);
    assert.match(JSON.stringify(rich.toolCalls[0].result), /\[REDACTED\]/);
    assert.equal(rich.sessionFile, "sessions/command-001/session.jsonl");
    const minimal = items.find((item) =>
      (item.detail as Record<string, unknown>).commandId === "command-002"
    )?.detail as Record<string, any>;
    assert.equal(minimal.userText, "Run check");
    assert.equal(minimal.assistantText, "Check complete");
    assert.deepEqual(minimal.toolCalls, []);
    for (const absent of ["thinking", "usage", "error"]) {
      assert.equal(Object.hasOwn(minimal, absent), false);
    }
    const exposed = JSON.stringify(items);
    assert.doesNotMatch(exposed, /AGENT_.*_SECRET|OUTSIDE_SESSION_SECRET/);
    assert.doesNotMatch(exposed, new RegExp(root.replaceAll("\\", "\\\\")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection filters sources and keeps malformed evidence diagnosable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    await writeFile(
      join(root, "controls.jsonl"),
      `{"input":{"token":"MALFORMED_CONTROL_SECRET"\n${JSON.stringify({ id: "control-1", run_instance_id: "generation-a", action: "pause", status: "failed", queued_at: "2026-01-01T00:00:00.000Z", failed_at: "2026-01-01T00:00:01.000Z", error: "not ready" })}\n`,
    );
    const controls = projectRunTrace(root, { source: "control" });
    assert.equal(controls.length, 1);
    assert.equal(controls[0]?.kind, "control.failed");
    const runtime = projectRunTrace(root, { source: "runtime" });
    assert.equal(runtime.length, 1);
    assert.equal(runtime[0]?.kind, "state.read_error");
    assert.equal(
      (runtime[0]?.detail as Record<string, unknown>).reason,
      "invalid_control_json",
    );
    assert.doesNotMatch(JSON.stringify(runtime), /MALFORMED_CONTROL_SECRET/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection exposes compaction and legacy history loss without new fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-history-"));
  try {
    const marker = {
      id: "marker-1",
      ts: "2026-01-01T00:00:01.000Z",
      kind: "runtime.trace_compacted",
      level: "warning",
      data: {
        version: 1,
        compactions_total: 1,
        dropped_valid_events_total: 2,
        dropped_malformed_lines_total: 0,
        dropped_bytes_total: 80,
        dropped_event_count_exact: true,
        retained_events: 2,
        retained_bytes: 240,
        history_complete: false,
      },
    };
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify({ id: "event-1", ts: "2026-01-01T00:00:00.000Z", kind: "runtime.note" })}\n${JSON.stringify(marker)}\n`,
    );
    const compacted = projectRunTrace(root, { source: "runtime" });
    const projectedMarker = compacted.find(({ kind }) => kind === marker.kind)!;
    assert.equal(projectedMarker.level, "warning");
    assert.deepEqual((projectedMarker.detail as Record<string, unknown>).data, marker.data);
    assert.deepEqual(Object.keys(projectedMarker).sort(), [
      "detail", "id", "kind", "level", "source", "summary", "ts",
    ]);
    assert.equal(
      compacted.some(({ kind }) => kind === "runtime.trace_history_incomplete"),
      false,
    );
    const prefix = Buffer.alloc(TRACE_JOURNAL_MAX_BYTES + 17, 0x61);
    const suffix = `${JSON.stringify({
      id: "legacy-event",
      ts: "2026-01-02T00:00:00.000Z",
      kind: "runtime.note",
    })}\n`;
    await writeFile(
      join(root, "trace.jsonl"),
      Buffer.concat([prefix, Buffer.from(`\n${suffix}`)]),
    );
    const legacy = projectRunTrace(root, { source: "runtime" });
    const incomplete = legacy.filter(
      ({ kind }) => kind === "runtime.trace_history_incomplete",
    );
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]?.level, "warning");
    assert.ok(
      Number((incomplete[0]?.detail as Record<string, unknown>).omitted_prefix_bytes) >
        TRACE_JOURNAL_MAX_BYTES,
    );
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
