import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
