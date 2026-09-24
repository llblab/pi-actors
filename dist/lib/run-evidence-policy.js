/**
 * Pure bounded Run-evidence policy.
 * Zones: Trace retention, compaction accounting, Control capacity and admission
 * Owns deterministic limits policy; journal I/O, locks, lifecycle authorization, and projection stay in adapters.
 * Trace keeps the newest physical suffix because semantic priority would silently
 * redefine causal history. Admitted Controls never expire: only a real terminal
 * transition or generation replacement proves that durable work is finished.
 */
import * as Limits from "./limits.js";
export const TRACE_COMPACTION_KIND = "runtime.trace_compacted";
export const TRACE_COMPACTION_VERSION = 1;
const PENDING_CONTROL_STATUSES = new Set(["queued", "delivered", "claimed"]);
const TERMINAL_CONTROL_STATUSES = new Set(["handled", "failed"]);
const CONTROL_ADMISSION_NEXT_ACTIONS = [
    "inspect target=run:<id> view=control",
    "inspect target=runtime view=triage",
];
function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function assertCount(value, name) {
    if (!isCount(value))
        throw new RangeError(`${name} must be a non-negative safe integer`);
}
function boundedAdd(left, right) {
    return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
export function traceAppendFits(usage, encodedEventBytes) {
    if (!isCount(usage.events) || !isCount(usage.bytes) || !isCount(encodedEventBytes))
        return false;
    return usage.events + 1 <= Limits.TRACE_JOURNAL_MAX_EVENTS &&
        usage.bytes + encodedEventBytes <= Limits.TRACE_JOURNAL_MAX_BYTES;
}
export function selectNewestTraceSuffix(candidates, reserve = {}) {
    const reservedBytes = reserve.bytes ?? 0;
    const reservedEvents = reserve.events ?? 0;
    assertCount(reservedBytes, "reserved Trace bytes");
    assertCount(reservedEvents, "reserved Trace events");
    const byteBudget = Math.max(0, Limits.TRACE_JOURNAL_TARGET_BYTES - reservedBytes);
    const eventBudget = Math.max(0, Limits.TRACE_JOURNAL_TARGET_EVENTS - reservedEvents);
    let retainedBytes = 0;
    let start = candidates.length;
    while (start > 0 && candidates.length - start < eventBudget) {
        const candidate = candidates[start - 1];
        assertCount(candidate.encodedBytes, "encoded Trace bytes");
        if (retainedBytes + candidate.encodedBytes > byteBudget)
            break;
        retainedBytes += candidate.encodedBytes;
        start -= 1;
    }
    const retained = candidates.slice(start);
    return {
        droppedEvents: candidates.length - retained.length,
        retained,
        retainedBytes,
        retainedEvents: retained.length,
    };
}
export function accumulateTraceCompactionStatistics(previous, delta) {
    for (const [name, value] of Object.entries(delta)) {
        if (name !== "dropped_event_count_exact")
            assertCount(value, name);
    }
    const prior = previous ?? {
        compactions_total: 0,
        dropped_bytes_total: 0,
        dropped_event_count_exact: true,
        dropped_malformed_lines_total: 0,
        dropped_valid_events_total: 0,
    };
    const eventCountOverflow = prior.dropped_valid_events_total +
        delta.dropped_valid_events > Number.MAX_SAFE_INTEGER;
    return {
        version: TRACE_COMPACTION_VERSION,
        compactions_total: boundedAdd(prior.compactions_total, 1),
        dropped_valid_events_total: boundedAdd(prior.dropped_valid_events_total, delta.dropped_valid_events),
        dropped_malformed_lines_total: boundedAdd(prior.dropped_malformed_lines_total, delta.dropped_malformed_lines),
        dropped_bytes_total: boundedAdd(prior.dropped_bytes_total, delta.dropped_bytes),
        dropped_event_count_exact: prior.dropped_event_count_exact &&
            delta.dropped_event_count_exact && !eventCountOverflow,
        retained_events: delta.retained_events,
        retained_bytes: delta.retained_bytes,
        history_complete: false,
    };
}
export function traceCompactionMarkerInput(data) {
    return { data, kind: TRACE_COMPACTION_KIND, level: "warning" };
}
export function classifyRunControlRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const status = value.status;
    if (PENDING_CONTROL_STATUSES.has(status))
        return "pending";
    if (TERMINAL_CONTROL_STATUSES.has(status))
        return "terminal";
    return undefined;
}
export function runControlStatusTimestamp(record, status) {
    if (status === "failed")
        return record.failed_at;
    if (status === "handled")
        return record.handled_at;
    if (status === "claimed")
        return record.claimed_at;
    if (status === "delivered")
        return record.delivered_at;
    return record.queued_at;
}
export function computeRunControlCapacity(records) {
    let oldest;
    let pending = 0;
    for (const value of records) {
        if (classifyRunControlRecord(value) !== "pending")
            continue;
        pending += 1;
        const record = value;
        const timestamp = runControlStatusTimestamp(record, record.status);
        const timestampMs = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
        if (typeof timestamp === "string" && Number.isFinite(timestampMs) &&
            (!oldest || timestampMs < oldest.timestampMs)) {
            oldest = { timestamp, timestampMs };
        }
    }
    return {
        available: Math.max(0, Limits.RUN_CONTROL_PENDING_LIMIT - pending),
        backpressured: pending >= Limits.RUN_CONTROL_PENDING_LIMIT,
        limit: Limits.RUN_CONTROL_PENDING_LIMIT,
        ...(oldest ? { oldest_pending_at: oldest.timestamp } : {}),
        pending,
    };
}
export function decideRunControlAdmission(input) {
    const capacity = input.capacity ?? computeRunControlCapacity(input.records);
    const reject = (reason, integrityReason) => ({
        admitted: false,
        capacity,
        error: {
            reason,
            pending: capacity.pending,
            limit: capacity.limit,
            journal_bytes: input.journalBytes,
            journal_limit: Limits.RUN_CONTROL_JOURNAL_MAX_BYTES,
            ...(capacity.oldest_pending_at ? { oldest_pending_at: capacity.oldest_pending_at } : {}),
            run_instance_id: input.runInstanceId,
            next_actions: [...CONTROL_ADMISSION_NEXT_ACTIONS],
            ...(integrityReason ? { integrity_reason: integrityReason } : {}),
        },
    });
    if (input.integrity !== "valid")
        return reject("control_journal_integrity", input.integrity);
    if (!isCount(input.journalBytes) || !isCount(input.retainedJournalBytes) ||
        !isCount(input.newRecordBytes) ||
        input.journalBytes > Limits.RUN_CONTROL_JOURNAL_MAX_BYTES) {
        return reject("control_journal_integrity", "journal_bytes");
    }
    for (const value of input.records) {
        const classification = classifyRunControlRecord(value);
        if (!classification)
            return reject("control_journal_integrity", "invalid_record");
        if (classification !== "pending")
            continue;
        const record = value;
        const timestamp = runControlStatusTimestamp(record, record.status);
        if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
            return reject("control_journal_integrity", "invalid_status_timestamp");
        }
        if (record.run_instance_id !== input.runInstanceId) {
            return reject("control_journal_integrity", "generation_mismatch");
        }
    }
    if (capacity.backpressured ||
        input.retainedJournalBytes + input.newRecordBytes > Limits.RUN_CONTROL_JOURNAL_MAX_BYTES) {
        return reject("control_backpressure");
    }
    return { admitted: true, capacity };
}
