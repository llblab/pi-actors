import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mutationLockPath } from "../lib/file-state.ts";
import * as Limits from "../lib/limits.ts";
import {
  appendRunControlInStateDir,
  claimRunControlByIdInStateDir,
  claimRunControlInStateDir,
  processRunControlsInStateDir,
  readRunControlJournalFromStateDir,
  readRunControlsFromStateDir,
  runControlsFile,
  RUN_CONTROL_TERMINAL_LIMIT,
  updateRunControlStatusInStateDir,
} from "../lib/runs-controls.ts";

const admissionWorker = fileURLToPath(
  new URL("./fixtures/control-admission-worker.ts", import.meta.url),
);

function runAdmissionWorker(stateDir: string, worker: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      admissionWorker,
      stateDir,
      String(worker),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === 2 && stderr.includes("control_backpressure")) resolve(false);
      else reject(new Error(`Control worker exited ${code}: ${stderr}`));
    });
  });
}

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

test("Run Control exact-id claims stay fenced to one generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    const first = appendRunControlInStateDir(root, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    const second = appendRunControlInStateDir(root, {
      action: "resume",
      run_instance_id: "generation-a",
    });
    assert.equal(claimRunControlByIdInStateDir(root, "generation-b", second.id), undefined);
    assert.equal(claimRunControlByIdInStateDir(root, "generation-a", "missing"), undefined);
    const claimed = claimRunControlByIdInStateDir(root, "generation-a", second.id);
    assert.equal(claimed?.id, second.id);
    assert.equal(claimed?.status, "claimed");
    assert.equal(typeof claimed?.claimed_at, "string");
    assert.equal(claimRunControlInStateDir(root, "generation-a")?.id, first.id);
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

test("Run Control processing bounds UTF-8 failure text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    appendRunControlInStateDir(root, { action: "pause", run_instance_id: "generation-a" });
    appendRunControlInStateDir(root, { action: "revise", run_instance_id: "generation-a" });
    const oversized = "💥".repeat(Limits.RUN_CONTROL_ERROR_MAX_BYTES);
    const result = await processRunControlsInStateDir(
      root,
      "generation-a",
      (control) => {
        if (control.action === "revise") throw new Error(oversized);
      },
      2,
    );
    assert.deepEqual(result, { claimed: 2, failed: 1, handled: 1 });
    const records = readRunControlsFromStateDir(root);
    assert.equal(records[0]?.status, "handled");
    assert.equal(records[1]?.status, "failed");
    assert.ok(Buffer.byteLength(records[1]!.error!) <= Limits.RUN_CONTROL_ERROR_MAX_BYTES);
    assert.ok(Buffer.byteLength(records[1]!.error!) >= Limits.RUN_CONTROL_ERROR_MAX_BYTES - 3);
    assert.match(records[1]!.error!, /… \[truncated\]$/);
    assert.doesNotMatch(records[1]!.error!, /�/);
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

test("Run Control admission is atomic at the exact pending limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-race-"));
  try {
    const results = await Promise.all(
      Array.from({ length: Limits.RUN_CONTROL_PENDING_LIMIT + 12 }, (_, index) =>
        runAdmissionWorker(root, index)),
    );
    assert.equal(results.filter(Boolean).length, Limits.RUN_CONTROL_PENDING_LIMIT);
    assert.equal(results.filter((value) => !value).length, 12);
    const journal = readRunControlJournalFromStateDir(root);
    assert.equal(journal.diagnostics.length, 0);
    assert.equal(journal.records.length, Limits.RUN_CONTROL_PENDING_LIMIT);
    assert.ok((await stat(runControlsFile(root))).size <= Limits.RUN_CONTROL_JOURNAL_MAX_BYTES);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control terminal completion frees one deterministic admission slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-capacity-"));
  try {
    const records = Array.from({ length: Limits.RUN_CONTROL_PENDING_LIMIT }, (_, index) =>
      appendRunControlInStateDir(root, {
        action: "pause",
        input: { index },
        run_instance_id: "generation-a",
      }));
    assert.throws(
      () => appendRunControlInStateDir(root, {
        action: "pause",
        run_instance_id: "generation-a",
      }),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).reason, "control_backpressure");
        return true;
      },
    );
    updateRunControlStatusInStateDir(root, records[0]!.id, "claimed");
    updateRunControlStatusInStateDir(root, records[0]!.id, "handled");
    const admitted = appendRunControlInStateDir(root, {
      action: "resume",
      run_instance_id: "generation-a",
    });
    assert.equal(admitted.status, "queued");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control concurrent consumers free capacity without duplicate claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-consumers-"));
  try {
    const records = Array.from({ length: Limits.RUN_CONTROL_PENDING_LIMIT }, (_, index) =>
      appendRunControlInStateDir(root, {
        action: "pause", input: { index }, run_instance_id: "generation-a",
      }));
    const claimed = (await Promise.all(Array.from({ length: 8 }, () =>
      processRunControlsInStateDir(root, "generation-a", () => {}, 8))))
      .reduce((total, result) => total + result.handled, 0);
    assert.equal(claimed, Limits.RUN_CONTROL_PENDING_LIMIT);
    const terminal = readRunControlsFromStateDir(root);
    assert.equal(terminal.length, records.length);
    assert.equal(new Set(terminal.map(({ id }) => id)).size, records.length);
    assert.equal(terminal.every(({ status }) => status === "handled"), true);
    const admitted = await Promise.all(Array.from({ length: Limits.RUN_CONTROL_PENDING_LIMIT },
      (_, index) => runAdmissionWorker(root, 1_000 + index)));
    assert.equal(admitted.every(Boolean), true);
    assert.equal(readRunControlsFromStateDir(root)
      .filter(({ status }) => status === "queued").length, Limits.RUN_CONTROL_PENDING_LIMIT);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control admission fails closed for malformed, stale, and oversized journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-integrity-"));
  try {
    for (const [content, integrity] of [
      ["{bad json}\n", "malformed"],
      [`${JSON.stringify({ id: "bad", status: "queued" })}\n`, "invalid_record"],
      [`${JSON.stringify({ id: "stale", action: "pause", run_instance_id: "generation-b", status: "queued", queued_at: new Date().toISOString() })}\n`, "generation_mismatch"],
    ] as const) {
      await writeFile(runControlsFile(root), content);
      assert.throws(
        () => appendRunControlInStateDir(root, {
          action: "pause",
          run_instance_id: "generation-a",
        }),
        (error: unknown) => {
          assert.equal((error as Record<string, unknown>).reason, "control_journal_integrity");
          assert.equal((error as Record<string, unknown>).integrity_reason, integrity);
          return true;
        },
      );
      assert.equal(await stat(runControlsFile(root)).then(({ size }) => size), Buffer.byteLength(content));
    }
    const oversized = Buffer.alloc(Limits.RUN_CONTROL_JOURNAL_MAX_BYTES + 1, 0x61);
    await writeFile(runControlsFile(root), oversized);
    assert.throws(
      () => appendRunControlInStateDir(root, {
        action: "pause",
        run_instance_id: "generation-a",
      }),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).integrity_reason, "journal_bytes");
        return true;
      },
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control worst-case canonical state stays below the journal cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-bound-"));
  try {
    for (let index = 0; index < Limits.RUN_CONTROL_TERMINAL_LIMIT; index += 1) {
      const record = appendRunControlInStateDir(root, {
        action: "x".repeat(Limits.CONTROL_ACTION_MAX_LENGTH),
        input: "x".repeat(Limits.CONTROL_INPUT_MAX_BYTES - 2),
        run_instance_id: "g".repeat(128),
      });
      claimRunControlByIdInStateDir(root, "g".repeat(128), record.id);
      updateRunControlStatusInStateDir(root, record.id, "failed", {
        error: "e".repeat(Limits.RUN_CONTROL_ERROR_MAX_BYTES + 1),
      }, ["claimed"]);
    }
    for (let index = 0; index < Limits.RUN_CONTROL_PENDING_LIMIT; index += 1) {
      appendRunControlInStateDir(root, {
        action: "x".repeat(Limits.CONTROL_ACTION_MAX_LENGTH),
        input: "x".repeat(Limits.CONTROL_INPUT_MAX_BYTES - 2),
        run_instance_id: "g".repeat(128),
      });
    }
    const size = (await stat(runControlsFile(root))).size;
    assert.ok(size < Limits.RUN_CONTROL_JOURNAL_MAX_BYTES, `${size}`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control transitions fail closed for invalid journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-invalid-"));
  try {
    const record = appendRunControlInStateDir(root, {
      action: "pause", run_instance_id: "generation-a",
    });
    for (const content of [
      "{bad json}\n",
      `${JSON.stringify({ ...record, status: "mystery" })}\n`,
    ]) {
      await writeFile(runControlsFile(root), content);
      assert.equal(claimRunControlByIdInStateDir(root, "generation-a", record.id), undefined);
      assert.equal(updateRunControlStatusInStateDir(root, record.id, "failed"), false);
      assert.equal((await stat(runControlsFile(root))).size, Buffer.byteLength(content));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run Control journal reclaims a stale lock before admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-controls-"));
  try {
    const lock = mutationLockPath(runControlsFile(root));
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, token: "abandoned" })}\n`);
    const record = appendRunControlInStateDir(root, {
      action: "pause",
      run_instance_id: "generation-a",
    });
    assert.deepEqual(readRunControlsFromStateDir(root), [record]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
