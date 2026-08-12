import assert from "node:assert/strict";
import test from "node:test";

import * as Limits from "../lib/limits.ts";
import {
  accumulateTraceCompactionStatistics,
  classifyRunControlRecord,
  computeRunControlCapacity,
  decideRunControlAdmission,
  selectNewestTraceSuffix,
  traceAppendFits,
  traceCompactionMarkerInput,
  TRACE_COMPACTION_KIND,
  TRACE_COMPACTION_VERSION,
  type RunControlAdmissionInput,
  type RunControlStatus,
} from "../lib/run-evidence-policy.ts";

const GENERATION = "generation-a";

function control(
  status: RunControlStatus,
  statusAt: string,
  runInstanceId = GENERATION,
): Record<string, unknown> {
  return {
    action: "pause",
    id: `${status}-${statusAt}`,
    queued_at: statusAt,
    run_instance_id: runInstanceId,
    status,
    ...(status === "delivered" ? { delivered_at: statusAt } : {}),
    ...(status === "claimed" ? { claimed_at: statusAt } : {}),
    ...(status === "handled" ? { handled_at: statusAt } : {}),
    ...(status === "failed" ? { failed_at: statusAt } : {}),
  };
}

function admission(
  overrides: Partial<RunControlAdmissionInput> = {},
): RunControlAdmissionInput {
  return {
    integrity: "valid",
    journalBytes: 0,
    newRecordBytes: 100,
    records: [],
    retainedJournalBytes: 0,
    runInstanceId: GENERATION,
    ...overrides,
  };
}

test("bounded Run evidence limits have one fixed owner", () => {
  assert.deepEqual(
    {
      controlErrorBytes: Limits.RUN_CONTROL_ERROR_MAX_BYTES,
      controlJournalBytes: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES,
      controlPending: Limits.RUN_CONTROL_PENDING_LIMIT,
      controlTerminal: Limits.RUN_CONTROL_TERMINAL_LIMIT,
      traceMaxBytes: Limits.TRACE_JOURNAL_MAX_BYTES,
      traceMaxEvents: Limits.TRACE_JOURNAL_MAX_EVENTS,
      traceTargetBytes: Limits.TRACE_JOURNAL_TARGET_BYTES,
      traceTargetEvents: Limits.TRACE_JOURNAL_TARGET_EVENTS,
    },
    {
      controlErrorBytes: 4 * 1024,
      controlJournalBytes: 1024 * 1024,
      controlPending: 64,
      controlTerminal: 128,
      traceMaxBytes: 4 * 1024 * 1024,
      traceMaxEvents: 2_048,
      traceTargetBytes: 3 * 1024 * 1024,
      traceTargetEvents: 1_536,
    },
  );
});

test("Trace append fit applies both hard thresholds", () => {
  assert.equal(
    traceAppendFits(
      { bytes: Limits.TRACE_JOURNAL_MAX_BYTES - 10, events: 0 },
      10,
    ),
    true,
  );
  assert.equal(
    traceAppendFits(
      { bytes: Limits.TRACE_JOURNAL_MAX_BYTES - 10, events: 0 },
      11,
    ),
    false,
  );
  assert.equal(
    traceAppendFits({ bytes: 0, events: Limits.TRACE_JOURNAL_MAX_EVENTS }, 1),
    false,
  );
  assert.equal(traceAppendFits({ bytes: -1, events: 0 }, 1), false);
});

test("Trace retention selects one newest suffix under target budgets", () => {
  const candidates = Array.from(
    { length: Limits.TRACE_JOURNAL_TARGET_EVENTS + 2 },
    (_, value) => ({ encodedBytes: 1, value }),
  );
  const byCount = selectNewestTraceSuffix(candidates, { events: 2 });
  assert.equal(
    byCount.retainedEvents,
    Limits.TRACE_JOURNAL_TARGET_EVENTS - 2,
  );
  assert.equal(byCount.retained[0]?.value, 4);
  assert.equal(byCount.droppedEvents, 4);

  const byBytes = selectNewestTraceSuffix([
    { encodedBytes: Limits.TRACE_JOURNAL_TARGET_BYTES, value: "old" },
    { encodedBytes: 1, value: "middle" },
    { encodedBytes: 1, value: "new" },
  ]);
  assert.deepEqual(byBytes.retained.map(({ value }) => value), ["middle", "new"]);
  assert.equal(byBytes.retainedBytes, 2);
});

test("Trace compaction statistics accumulate into one warning marker", () => {
  const first = accumulateTraceCompactionStatistics(undefined, {
    dropped_bytes: 20,
    dropped_event_count_exact: true,
    dropped_malformed_lines: 1,
    dropped_valid_events: 2,
    retained_bytes: 300,
    retained_events: 3,
  });
  const second = accumulateTraceCompactionStatistics(first, {
    dropped_bytes: 40,
    dropped_event_count_exact: false,
    dropped_malformed_lines: 2,
    dropped_valid_events: 4,
    retained_bytes: 500,
    retained_events: 5,
  });
  assert.deepEqual(second, {
    version: TRACE_COMPACTION_VERSION,
    compactions_total: 2,
    dropped_valid_events_total: 6,
    dropped_malformed_lines_total: 3,
    dropped_bytes_total: 60,
    dropped_event_count_exact: false,
    retained_events: 5,
    retained_bytes: 500,
    history_complete: false,
  });
  const marker = traceCompactionMarkerInput(second);
  assert.equal(marker.kind, TRACE_COMPACTION_KIND);
  assert.equal(marker.level, "warning");
  assert.equal(Object.hasOwn(marker, "attention"), false);
  assert.deepEqual(Object.keys(marker.data), [
    "version",
    "compactions_total",
    "dropped_valid_events_total",
    "dropped_malformed_lines_total",
    "dropped_bytes_total",
    "dropped_event_count_exact",
    "retained_events",
    "retained_bytes",
    "history_complete",
  ]);
});

test("Control policy classifies records and computes pending capacity", () => {
  const oldest = "2026-01-01T00:00:00.000Z";
  const newer = "2026-01-01T00:01:00.000Z";
  const records = [
    control("queued", newer),
    control("delivered", oldest),
    control("claimed", newer),
    control("handled", newer),
    control("failed", newer),
  ];
  assert.deepEqual(
    records.map((record) => classifyRunControlRecord(record)),
    ["pending", "pending", "pending", "terminal", "terminal"],
  );
  assert.equal(classifyRunControlRecord({ status: "mystery" }), undefined);
  assert.deepEqual(computeRunControlCapacity(records), {
    available: Limits.RUN_CONTROL_PENDING_LIMIT - 3,
    backpressured: false,
    limit: Limits.RUN_CONTROL_PENDING_LIMIT,
    oldest_pending_at: oldest,
    pending: 3,
  });
});

test("Control admission accepts valid capacity and rejects saturation before admission", () => {
  const pending = Array.from(
    { length: Limits.RUN_CONTROL_PENDING_LIMIT },
    (_, index) => control("queued", new Date(index).toISOString()),
  );
  assert.equal(
    decideRunControlAdmission(admission({ records: pending.slice(0, -1) })).admitted,
    true,
  );
  const rejected = decideRunControlAdmission(admission({ records: pending }));
  assert.equal(rejected.admitted, false);
  if (rejected.admitted) return;
  assert.deepEqual(rejected.error, {
    reason: "control_backpressure",
    pending: Limits.RUN_CONTROL_PENDING_LIMIT,
    limit: Limits.RUN_CONTROL_PENDING_LIMIT,
    journal_bytes: 0,
    journal_limit: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES,
    oldest_pending_at: new Date(0).toISOString(),
    run_instance_id: GENERATION,
    next_actions: [
      "inspect target=run:<id> view=control",
      "inspect target=runtime view=triage",
    ],
  });
});

test("Control admission distinguishes byte pressure from journal integrity", () => {
  const bytePressure = decideRunControlAdmission(admission({
    newRecordBytes: 2,
    retainedJournalBytes: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES - 1,
  }));
  assert.equal(bytePressure.admitted, false);
  if (!bytePressure.admitted) {
    assert.equal(bytePressure.error.reason, "control_backpressure");
  }

  for (const [input, integrityReason] of [
    [admission({ integrity: "malformed" }), "malformed"],
    [admission({ records: [{ status: "unknown" }] }), "invalid_record"],
    [admission({
      records: [control("queued", new Date(0).toISOString(), "generation-b")],
    }), "generation_mismatch"],
    [admission({ journalBytes: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES + 1 }), "journal_bytes"],
  ] as const) {
    const rejected = decideRunControlAdmission(input);
    assert.equal(rejected.admitted, false);
    if (rejected.admitted) continue;
    assert.equal(rejected.error.reason, "control_journal_integrity");
    assert.equal(rejected.error.integrity_reason, integrityReason);
  }
});
