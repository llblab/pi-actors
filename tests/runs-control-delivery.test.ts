import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deliverRunControl,
  FIFO_ATOMIC_CONTROL_MAX_BYTES,
} from "../lib/runs-control-delivery.ts";
import {
  readRunControlsFromStateDir,
  updateRunControlStatusInStateDir,
} from "../lib/runs-controls.ts";

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

test("FIFO Controls reject payloads above the portable atomic-write bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-control-delivery-"));
  try {
    await writeEndpoint(root, {
      path: join(root, "control.fifo"),
      run_instance_id: "generation-a",
      type: "fifo",
    });
    await assert.rejects(
      deliverRunControl("demo", root, {
        action: "enqueue",
        input: "x".repeat(FIFO_ATOMIC_CONTROL_MAX_BYTES),
        run_instance_id: "generation-a",
      }, { platform: "linux" }),
      /portable atomic-write bound/,
    );
    assert.equal(readRunControlsFromStateDir(root)[0]?.status, "failed");
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
