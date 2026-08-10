import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mutationLockPath } from "../lib/file-state.ts";
import {
  appendRunControlInStateDir,
  claimRunControlInStateDir,
  processRunControlsInStateDir,
  readRunControlsFromStateDir,
  runControlsFile,
  RUN_CONTROL_TERMINAL_LIMIT,
  updateRunControlStatusInStateDir,
} from "../lib/runs-controls.ts";

test("Run Control journal appends canonical generation-bound records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    const record = appendRunControlInStateDir(root, {
      action: "pause",
      input: { reason: "operator" },
      run_instance_id: "generation-a",
    });
    assert.equal(record.status, "queued");
    assert.equal(typeof record.id, "string");
    assert.equal(typeof record.queued_at, "string");
    assert.deepEqual(readRunControlsFromStateDir(root), [record]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control claims stay fenced to one generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    appendRunControlInStateDir(root, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    assert.equal(claimRunControlInStateDir(root, "generation-b"), undefined);
    const claimed = claimRunControlInStateDir(root, "generation-a");
    assert.equal(claimed?.status, "claimed");
    assert.equal(typeof claimed?.claimed_at, "string");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control delivery evidence never regresses claimed or terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    const deliveredFirst = appendRunControlInStateDir(root, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    updateRunControlStatusInStateDir(root, deliveredFirst.id, "delivered");
    assert.equal(claimRunControlInStateDir(root, "generation-a")?.status, "claimed");
    assert.equal(
      updateRunControlStatusInStateDir(
        root,
        deliveredFirst.id,
        "failed",
        { error: "late transport failure" },
        ["queued", "delivered"],
      ),
      false,
    );
    updateRunControlStatusInStateDir(root, deliveredFirst.id, "handled");

    const handledFirst = appendRunControlInStateDir(root, {
      action: "resume",
      run_instance_id: "generation-a",
    });
    assert.equal(claimRunControlInStateDir(root, "generation-a")?.id, handledFirst.id);
    updateRunControlStatusInStateDir(root, handledFirst.id, "handled");
    updateRunControlStatusInStateDir(root, handledFirst.id, "delivered");
    const handled = readRunControlsFromStateDir(root).find(
      (control) => control.id === handledFirst.id,
    )!;
    assert.equal(handled.status, "handled");
    assert.equal(typeof handled.delivered_at, "string");
    assert.equal(typeof handled.claimed_at, "string");
    assert.equal(typeof handled.handled_at, "string");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control processing records handled and failed outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    appendRunControlInStateDir(root, { action: "pause", run_instance_id: "generation-a" });
    appendRunControlInStateDir(root, { action: "revise", run_instance_id: "generation-a" });
    const result = await processRunControlsInStateDir(
      root,
      "generation-a",
      (control) => {
        if (control.action === "revise") throw new Error("revision rejected");
      },
      2,
    );
    assert.deepEqual(result, { claimed: 2, failed: 1, handled: 1 });
    const records = readRunControlsFromStateDir(root);
    assert.equal(records[0]?.status, "handled");
    assert.equal(records[1]?.status, "failed");
    assert.equal(records[1]?.error, "revision rejected");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control compaction keeps every active record and a bounded terminal tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    for (let index = 0; index < RUN_CONTROL_TERMINAL_LIMIT + 5; index += 1) {
      const record = appendRunControlInStateDir(root, {
        action: "status",
        run_instance_id: "generation-a",
      });
      claimRunControlInStateDir(root, "generation-a");
      updateRunControlStatusInStateDir(root, record.id, "handled");
    }
    const active = appendRunControlInStateDir(root, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    const records = readRunControlsFromStateDir(root);
    assert.equal(records.length, RUN_CONTROL_TERMINAL_LIMIT + 1);
    assert.equal(records.some((record) => record.id === active.id), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control journal recovers a stale lock and ignores malformed lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    const lock = mutationLockPath(runControlsFile(root));
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, token: "abandoned" })}\n`,
    );
    const record = appendRunControlInStateDir(root, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    await writeFile(join(root, "controls.jsonl"), `{bad json}\n${JSON.stringify(record)}\n`);
    assert.deepEqual(readRunControlsFromStateDir(root), [record]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
