import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as Limits from "../lib/limits.ts";
import {
  deliverRunControl,
  encodeRunControlWire,
} from "../lib/runs-control-delivery.ts";
import {
  readRunControlsFromStateDir,
  updateRunControlStatusInStateDir,
} from "../lib/runs-controls.ts";

const MAX_ACTION = "a".repeat(Limits.CONTROL_ACTION_MAX_LENGTH);
const MAX_INPUT = "x".repeat(Limits.CONTROL_INPUT_MAX_BYTES - 2);
const WIRE_ID = "00000000-0000-4000-8000-000000000000";

async function writeEndpoint(
  stateDir: string,
  endpoint: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(stateDir, "control-endpoint.json"),
    `${JSON.stringify(endpoint)}\n`,
  );
}

test("Named-pipe Control sends the exact actor-local wire envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  let sent = "";
  try {
    await writeEndpoint(root, {
      path: "named-pipe-test",
      run_instance_id: "generation-a",
      type: "named-pipe",
    });
    const receipt = await deliverRunControl(
      "demo",
      root,
      { action: "revise", input: { scope: "docs" }, run_instance_id: "generation-a" },
      {
        namedPipeSend: async (_path, payload) => {
          sent = payload;
          return Buffer.byteLength(payload);
        },
      },
    );
    const record = readRunControlsFromStateDir(root)[0]!;
    assert.deepEqual(JSON.parse(sent), {
      action: "revise",
      id: record.id,
      input: { scope: "docs" },
    });
    assert.equal(receipt.delivery, "delivered");
    assert.equal(record.status, "delivered");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Control delivery retains exact transport causes without exposing them through ordinary serialization", async () => {
  const formattingError = new Error("controlled failure-text formatting error");
  const unprintable = { toString() { throw formattingError; } };
  for (const primary of [Object.assign(new AggregateError([new Error("inner cause")], "transport fault", { cause: new Error("root cause") }),
    { details: { private: "PRIVATE_TRANSPORT_DETAIL" } }), "primitive transport fault", undefined, unprintable]) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-control-causes-"));
    let id: string | undefined; let sends = 0;
    try {
      await writeEndpoint(root, { path: "controlled-no-socket", run_instance_id: "generation-a", type: "named-pipe" });
      await assert.rejects(deliverRunControl("demo", root, { action: "pause", run_instance_id: "generation-a" },
        { namedPipeSend: async (_path, payload) => { sends++; id = JSON.parse(payload).id; throw primary; } }), (error: any) => {
        assert.equal(error.cause, primary);
        assert.equal(Object.hasOwn(error, "cause"), true);
        assert.equal(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable, false);
        assert.equal(error.reason, "delivery_failed"); assert.equal(error.control_id, id);
        assert.equal(error.run_instance_id, "generation-a");
        assert.equal(error.message, "Run Control delivery failed: " + (primary === unprintable ? "failure text unavailable" : primary instanceof Error ? primary.message : String(primary)));
        if (primary === unprintable) assert.deepEqual(error.errors, [unprintable, formattingError]);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_TRANSPORT_DETAIL|inner cause|root cause/);
        return true;
      });
      assert.equal(sends, 1);
      assert.equal(readRunControlsFromStateDir(root)[0]?.status, "failed");
    } finally { await rm(root, { force: true, recursive: true }); }
  }
});

test("Admitted Control failures preserve primary and later status-write errors with exact correlation", async () => {
  const originalWrite = fs.writeFileSync;
  for (const mode of ["transport", "endpoint", "delivered"] as const) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-control-recording-causes-"));
    const primary = Object.assign(new Error(mode + " primary"), { details: "PRIVATE_PRIMARY" });
    const later = Object.assign(new Error("failed status persistence"), { details: "PRIVATE_RECORDING" });
    let id: string | undefined; let sends = 0;
    try {
      if (mode !== "endpoint") await writeEndpoint(root, { path: "controlled-no-socket", run_instance_id: "generation-a", type: "named-pipe" });
      fs.writeFileSync = ((file, data, ...args) => {
        if (String(file).startsWith(join(root, "controls.jsonl") + ".") && typeof data === "string") {
          if (data.includes('"status":"failed"')) throw later;
          if (mode === "delivered" && data.includes('"status":"delivered"')) throw primary;
        }
        return Reflect.apply(originalWrite, fs, [file, data, ...args]);
      }) as typeof fs.writeFileSync;
      syncBuiltinESMExports();
      await assert.rejects(deliverRunControl("demo", root, { action: "pause", run_instance_id: "generation-a" },
        { namedPipeSend: async (_path, payload) => { sends++; id = JSON.parse(payload).id;
          if (mode === "transport") throw primary; return Buffer.byteLength(payload); } }), (error: any) => {
        assert.ok(error instanceof AggregateError);
        const context = error as AggregateError & Record<string, unknown>;
        const records = readRunControlsFromStateDir(root);
        assert.equal(context.control_id, records[0]?.id);
        assert.equal(context.run_instance_id, "generation-a");
        assert.equal(context.reason, mode === "endpoint" ? "endpoint_not_ready" : "delivery_failed");
        const first = error.errors[0];
        if (mode === "endpoint") { assert.equal(first.message, "Run Control endpoint is not ready."); assert.equal(first.control_id, records[0]?.id); }
        else { assert.equal(first, primary); assert.equal(context.control_id, id); }
        assert.equal(error.cause, first);
        assert.equal(error.errors[1], later); assert.equal(error.errors.length, 2);
        assert.equal(Object.getOwnPropertyDescriptor(error, "errors")?.enumerable, false);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PRIMARY|PRIVATE_RECORDING|failed status persistence/);
        return true;
      });
      assert.equal(sends, mode === "endpoint" ? 0 : 1);
      assert.equal(readRunControlsFromStateDir(root)[0]?.status, "queued");
    } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); await rm(root, { force: true, recursive: true }); }
  }
});

test("Portable Control wire admits canonical maxima and rejects one byte over", () => {
  assert.equal(
    Buffer.byteLength(JSON.stringify(MAX_INPUT)),
    Limits.CONTROL_INPUT_MAX_BYTES,
  );
  const canonical = encodeRunControlWire({
    id: WIRE_ID,
    action: MAX_ACTION,
    input: MAX_INPUT,
  });
  assert.equal(canonical.bytes, 511);
  assert.equal(canonical.payload.endsWith("\n"), true);
  assert.equal(
    encodeRunControlWire({
      id: "i".repeat(37),
      action: MAX_ACTION,
      input: MAX_INPUT,
    }).bytes,
    Limits.CONTROL_WIRE_MAX_BYTES,
  );
  assert.throws(
    () => encodeRunControlWire({
      id: "i".repeat(38),
      action: MAX_ACTION,
      input: MAX_INPUT,
    }),
    /exceeds the 512-byte portable bound/,
  );
});

test("Windows named-pipe path accepts the largest admitted Control", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  let sent = "";
  try {
    await writeEndpoint(root, {
      path: "named-pipe-test",
      run_instance_id: "generation-a",
      type: "named-pipe",
    });
    const receipt = await deliverRunControl(
      "demo",
      root,
      { action: MAX_ACTION, input: MAX_INPUT, run_instance_id: "generation-a" },
      {
        platform: "win32",
        namedPipeSend: async (_path, payload) => {
          sent = payload;
          return Buffer.byteLength(payload);
        },
      },
    );
    assert.equal(receipt.bytes, 511);
    assert.equal(Buffer.byteLength(sent), 511);
    assert.equal(JSON.parse(sent).input, MAX_INPUT);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Unix FIFO path accepts the largest admitted Control", {
  skip: process.platform === "win32" ? "requires a Unix FIFO" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  const fifo = join(root, "control.fifo");
  let fd: number | undefined;
  try {
    execFileSync("mkfifo", [fifo]);
    fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    await writeEndpoint(root, {
      path: fifo,
      run_instance_id: "generation-a",
      type: "fifo",
    });
    const receipt = await deliverRunControl("demo", root, {
      action: MAX_ACTION,
      input: MAX_INPUT,
      run_instance_id: "generation-a",
    });
    const buffer = Buffer.alloc(Limits.CONTROL_WIRE_MAX_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, null);
    assert.equal(receipt.bytes, 511);
    assert.equal(bytes, 511);
    assert.equal(JSON.parse(buffer.subarray(0, bytes).toString()).input, MAX_INPUT);
    const originalWrite = fs.writeSync, originalClose = fs.closeSync;
    const writeError = new Error("controlled FIFO failure after one byte");
    const closeError = new Error("controlled FIFO close failure after actual close");
    let closeTarget: number | undefined;
    fs.writeSync = ((target, payload: unknown) => {
      assert.ok(typeof payload === "string");
      originalWrite(target, payload.slice(0, 1)); closeTarget = target; throw writeError;
    }) as typeof fs.writeSync;
    fs.closeSync = ((target) => {
      originalClose(target);
      if (target === closeTarget) { closeTarget = undefined; throw closeError; }
    }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(deliverRunControl("demo", root, { action: "pause", run_instance_id: "generation-a" }), (error: any) => {
        assert.equal(error.reason, "delivery_failed");
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, [writeError, closeError]);
        assert.equal(error.cause.cause, writeError);
        assert.equal(error.control_id, readRunControlsFromStateDir(root)[1]?.id);
        return true;
      });
      const partial = Buffer.alloc(1);
      assert.equal(readSync(fd, partial, 0, 1, null), 1);
      assert.equal(partial.toString(), "{", "A failed write/close report cannot erase an already-written byte");
    } finally { fs.writeSync = originalWrite; fs.closeSync = originalClose; syncBuiltinESMExports(); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    await rm(root, { force: true, recursive: true });
  }
});

test("Delivery completion preserves a Control handled by a fast consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  try {
    await writeEndpoint(root, {
      path: "named-pipe-test",
      run_instance_id: "generation-a",
      type: "named-pipe",
    });
    await deliverRunControl(
      "demo",
      root,
      { action: "resume", run_instance_id: "generation-a" },
      {
        namedPipeSend: async (_path, payload) => {
          const { id } = JSON.parse(payload);
          updateRunControlStatusInStateDir(root, id, "claimed");
          updateRunControlStatusInStateDir(root, id, "handled");
          return Buffer.byteLength(payload);
        },
      },
    );
    const record = readRunControlsFromStateDir(root)[0]!;
    assert.equal(record.status, "handled");
    assert.equal(typeof record.delivered_at, "string");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("A handled Control remains handled when its controlled transport subsequently throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  let sends = 0, admittedId: string | undefined;
  const transportError = new Error("controlled transport fault after handling");
  try {
    await writeEndpoint(root, { path: "controlled-no-socket", run_instance_id: "generation-a", type: "named-pipe" });
    await assert.rejects(deliverRunControl("demo", root,
      { action: "resume", run_instance_id: "generation-a" },
      { namedPipeSend: async (_path, payload) => {
        sends++;
        admittedId = JSON.parse(payload).id;
        assert.equal(typeof admittedId, "string");
        updateRunControlStatusInStateDir(root, admittedId!, "claimed");
        updateRunControlStatusInStateDir(root, admittedId!, "handled");
        throw transportError;
      } }), (error: Error & { control_id?: string; reason?: string; run_instance_id?: string }) => {
        assert.equal(error.reason, "delivery_failed");
        assert.equal(error.cause, transportError);
        assert.equal(error.control_id, admittedId);
        assert.equal(error.run_instance_id, "generation-a");
        return true;
      });
    const records = readRunControlsFromStateDir(root);
    assert.equal(sends, 1, "The failure does not automatically replay transport");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, admittedId);
    assert.equal(records[0]!.status, "handled", "Delivery failure cannot regress completed handling");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Partial endpoint writes fail the durable Control attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  try {
    await writeEndpoint(root, {
      path: "named-pipe-test",
      run_instance_id: "generation-a",
      type: "named-pipe",
    });
    await assert.rejects(
      deliverRunControl(
        "demo",
        root,
        { action: "pause", run_instance_id: "generation-a" },
        { namedPipeSend: async (_path, payload) => Buffer.byteLength(payload) - 1 },
      ),
      /endpoint wrote \d+ of \d+ bytes/,
    );
    assert.equal(readRunControlsFromStateDir(root)[0]?.status, "failed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Invalid Control envelopes fail before journal or transport admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  let sends = 0;
  try {
    await writeEndpoint(root, {
      path: "named-pipe-test",
      run_instance_id: "generation-a",
      type: "named-pipe",
    });
    const options = {
      namedPipeSend: async () => {
        sends += 1;
        return 0;
      },
    };
    await assert.rejects(
      deliverRunControl(
        "demo",
        root,
        {
          action: `${MAX_ACTION}a`,
          run_instance_id: "generation-a",
        },
        options,
      ),
      /exceeds 64 ASCII characters/,
    );
    await assert.rejects(
      deliverRunControl(
        "demo",
        root,
        {
          action: "enqueue",
          input: "x".repeat(379),
          run_instance_id: "generation-a",
        },
        options,
      ),
      /exceeds 380 serialized bytes/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(
      deliverRunControl(
        "demo",
        root,
        { action: "enqueue", input: cyclic, run_instance_id: "generation-a" },
        options,
      ),
      /JSON-serializable/,
    );
    assert.equal(sends, 0);
    assert.deepEqual(readRunControlsFromStateDir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Control endpoint generation mismatch fails the durable attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  try {
    await writeEndpoint(root, {
      path: join(root, "controls.jsonl"),
      run_instance_id: "generation-b",
      type: "mailbox",
    });
    await assert.rejects(
      deliverRunControl("demo", root, {
        action: "pause",
        run_instance_id: "generation-a",
      }),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).reason, "endpoint_not_ready");
        return true;
      },
    );
    const record = readRunControlsFromStateDir(root)[0]!;
    assert.equal(record.run_instance_id, "generation-a");
    assert.equal(record.status, "failed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Native Windows FIFO rejection records a distinct delivery failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  try {
    await writeEndpoint(root, {
      path: join(root, "control.fifo"),
      run_instance_id: "generation-a",
      type: "fifo",
    });
    await assert.rejects(
      deliverRunControl(
        "demo",
        root,
        { action: "pause", run_instance_id: "generation-a" },
        { platform: "win32" },
      ),
      /FIFO Control delivery is unsupported on native Windows/,
    );
    assert.equal(readRunControlsFromStateDir(root)[0]?.status, "failed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
