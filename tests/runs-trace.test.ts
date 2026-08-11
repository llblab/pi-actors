import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mutationLockPath } from "../lib/file-state.ts";
import { TRACE_EVENT_MAX_BYTES, TRACE_EVENT_MAX_READ } from "../lib/limits.ts";
import {
  appendRunTraceEvent,
  readRunTraceEvents,
  runTraceFile,
} from "../lib/runs-trace.ts";

const worker = fileURLToPath(
  new URL("./fixtures/trace-append-worker.ts", import.meta.url),
);

function runTraceWorker(
  stateDir: string,
  workerIndex: number,
  count: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        worker,
        stateDir,
        String(workerIndex),
        String(count),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Trace append worker exited ${code}: ${stderr}`));
    });
  });
}

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

test("Run Trace serializes sibling-process appends without loss or corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-stress-"));
  const workerCount = 8;
  const eventsPerWorker = 25;
  try {
    await Promise.all(
      Array.from({ length: workerCount }, (_, index) =>
        runTraceWorker(root, index, eventsPerWorker),
      ),
    );
    const lines = (await readFile(runTraceFile(root), "utf8"))
      .trim()
      .split("\n");
    const records = lines.map((line) => JSON.parse(line));
    assert.equal(records.length, workerCount * eventsPerWorker);
    assert.equal(new Set(records.map((event) => event.id)).size, records.length);
    assert.equal(
      new Set(records.map((event) => `${event.data.worker}:${event.data.index}`)).size,
      records.length,
    );
    assert.equal(records.every((event) => event.kind === "stress.append"), true);
    assert.equal(
      readRunTraceEvents(root, workerCount * eventsPerWorker).length,
      records.length,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Trace reclaims an abandoned mutation lock before append", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-reclaim-"));
  const lockPath = mutationLockPath(runTraceFile(root));
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: "abandoned" }),
    );
    await utimes(lockPath, new Date(0), new Date(0));
    const event = appendRunTraceEvent(root, { kind: "runtime.recovered" });
    assert.deepEqual(readRunTraceEvents(root), [event]);
  } finally {
    await rm(lockPath, { force: true, recursive: true });
    await rm(`${lockPath}.reclaim`, { force: true, recursive: true });
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
    const retained = appendRunTraceEvent(root, { kind: "runtime.valid" });
    assert.deepEqual(readRunTraceEvents(root), [retained]);
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
