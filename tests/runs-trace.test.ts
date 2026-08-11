import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TRACE_EVENT_MAX_BYTES, TRACE_EVENT_MAX_READ } from "../lib/limits.ts";
import {
  appendRunTraceEvent,
  readRunTraceEvents,
  runTraceFile,
} from "../lib/runs-trace.ts";

test("Run Trace appends canonical structured events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-"));
  try {
    const event = appendRunTraceEvent(root, {
      attention: "followup",
      data: { checkpoint: 2 },
      kind: "checkpoint.ready",
      level: "info",
      summary: "Ready for operator review",
    });
    assert.equal(typeof event.id, "string");
    assert.equal(typeof event.ts, "string");
    assert.deepEqual(readRunTraceEvents(root), [event]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Trace rejects addressed-message fields and malformed values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-"));
  try {
    assert.throws(
      () => appendRunTraceEvent(root, { kind: "checkpoint.ready", to: "coordinator" } as never),
      /fields are removed: to/,
    );
    assert.throws(
      () => appendRunTraceEvent(root, { kind: "Checkpoint Ready" }),
      /lowercase semantic token/,
    );
    assert.throws(
      () => appendRunTraceEvent(root, { attention: "broadcast", kind: "checkpoint.ready" } as never),
      /attention must be notify or followup/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Trace rejects cyclic and oversized data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-"));
  try {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(
      () => appendRunTraceEvent(root, { data: cyclic, kind: "runtime.note" }),
      /JSON-serializable/,
    );
    assert.throws(
      () =>
        appendRunTraceEvent(root, {
          data: "x".repeat(TRACE_EVENT_MAX_BYTES),
          kind: "runtime.note",
        }),
      /exceeds 65536 bytes/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Trace reads a bounded resilient tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-"));
  try {
    const events = Array.from({ length: TRACE_EVENT_MAX_READ + 5 }, (_, index) => ({
      id: `event-${index}`,
      kind: "runtime.note",
      ts: new Date(index).toISOString(),
    }));
    await writeFile(
      runTraceFile(root),
      `{bad json}\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const read = readRunTraceEvents(root, TRACE_EVENT_MAX_READ + 100);
    assert.equal(read.length, TRACE_EVENT_MAX_READ);
    assert.equal(read[0]?.id, "event-5");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
