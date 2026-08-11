import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRuntimeControl,
  RUNTIME_CONTROL_STALE_AFTER_MS,
} from "../lib/runtime-triage.ts";

const NOW_MS = Date.parse("2026-01-01T00:10:00.000Z");
const RUNNING = {
  run: "demo",
  runInstanceId: "generation-a",
  status: "running",
};

function timestamp(ageMs: number): string {
  return new Date(NOW_MS - ageMs).toISOString();
}

function pendingRecord(
  status: "queued" | "delivered" | "claimed",
  ageMs: number,
): Record<string, unknown> {
  return {
    id: `${status}-1`,
    action: "pause",
    run_instance_id: "generation-a",
    status,
    queued_at: timestamp(ageMs + (status === "queued" ? 0 : 2)),
    ...(status === "delivered" ? { delivered_at: timestamp(ageMs) } : {}),
    ...(status === "claimed"
      ? { delivered_at: timestamp(ageMs + 1), claimed_at: timestamp(ageMs) }
      : {}),
  };
}

test("runtime triage admits queued, delivered, and claimed Controls as pending", () => {
  for (const status of ["queued", "delivered", "claimed"] as const) {
    const classified = classifyRuntimeControl(
      RUNNING,
      pendingRecord(status, RUNTIME_CONTROL_STALE_AFTER_MS - 1),
      NOW_MS,
    );
    assert.equal(classified.diagnostic, undefined);
    assert.equal(classified.stale, undefined);
    assert.equal(classified.pending?.action, "pause");
    assert.equal(classified.pending?.age_ms, RUNTIME_CONTROL_STALE_AFTER_MS - 1);
    assert.equal(classified.pending?.id, `${status}-1`);
    assert.equal(classified.pending?.reason, "within_age_threshold");
    assert.equal(classified.pending?.run, "demo");
    assert.equal(classified.pending?.run_instance_id, "generation-a");
    assert.equal(classified.pending?.status, status);
    assert.equal(
      classified.pending?.status_at,
      timestamp(RUNTIME_CONTROL_STALE_AFTER_MS - 1),
    );
  }
});

test("runtime triage applies the stale threshold at the exact boundary", () => {
  const before = classifyRuntimeControl(
    RUNNING,
    pendingRecord("queued", RUNTIME_CONTROL_STALE_AFTER_MS - 1),
    NOW_MS,
  );
  const at = classifyRuntimeControl(
    RUNNING,
    pendingRecord("queued", RUNTIME_CONTROL_STALE_AFTER_MS),
    NOW_MS,
  );
  const after = classifyRuntimeControl(
    RUNNING,
    pendingRecord("queued", RUNTIME_CONTROL_STALE_AFTER_MS + 1),
    NOW_MS,
  );
  assert.equal(before.stale, undefined);
  assert.equal(at.stale?.age_ms, RUNTIME_CONTROL_STALE_AFTER_MS);
  assert.equal(at.stale?.reason, "age_threshold_reached");
  assert.equal(after.stale?.age_ms, RUNTIME_CONTROL_STALE_AFTER_MS + 1);
  assert.equal(after.stale?.reason, "age_threshold_reached");
});

test("terminal and replaced Runs make pending Controls stale immediately", () => {
  const fresh = pendingRecord("delivered", 0);
  const terminal = classifyRuntimeControl(
    { ...RUNNING, status: "done" },
    fresh,
    NOW_MS,
  );
  const replaced = classifyRuntimeControl(
    { ...RUNNING, runInstanceId: "generation-b" },
    fresh,
    NOW_MS,
  );
  const missingGeneration = classifyRuntimeControl(
    { run: "demo", status: "running" },
    fresh,
    NOW_MS,
  );
  assert.equal(terminal.stale?.reason, "run_terminal");
  assert.equal(terminal.stale?.age_ms, 0);
  assert.equal(replaced.stale?.reason, "run_generation_replaced");
  assert.equal(replaced.stale?.run_instance_id, "generation-a");
  assert.equal(missingGeneration.stale?.reason, "run_generation_unavailable");
});

test("malformed Controls remain diagnostic and never become pending", () => {
  for (const [value, reason] of [
    [null, "invalid_record"],
    [{ status: "queued" }, "invalid_control_id"],
    [{ id: "c", status: "mystery" }, "invalid_status"],
    [{ status: "handled" }, "invalid_control_id"],
    [{ id: "c", status: "queued", action: "pause", run_instance_id: "generation-a", queued_at: "not-a-time" }, "invalid_status_timestamp"],
  ] as const) {
    const classified = classifyRuntimeControl(RUNNING, value, NOW_MS);
    assert.equal(classified.pending, undefined);
    assert.equal(classified.stale, undefined);
    assert.equal(classified.diagnostic?.reason, reason);
  }
  for (const status of ["handled", "failed"] as const) {
    assert.deepEqual(
      classifyRuntimeControl(
        RUNNING,
        {
          id: `${status}-1`,
          action: "pause",
          run_instance_id: "generation-a",
          status,
          queued_at: timestamp(2),
          [`${status}_at`]: timestamp(0),
        },
        NOW_MS,
      ),
      {},
    );
  }
});
