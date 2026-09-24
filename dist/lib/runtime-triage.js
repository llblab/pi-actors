/**
 * Pure runtime Control triage policy.
 * Zones: pending admission, status-age classification, terminal/replacement staleness
 * Owns Control triage decisions; journal reads and owner filtering stay in adapters, while safe fields come from control-projection.
 */
import * as ControlProjection from "./control-projection.js";
import { classifyRunControlRecord, runControlStatusTimestamp, } from "./run-evidence-policy.js";
export const RUNTIME_CONTROL_STALE_AFTER_MS = 5 * 60 * 1_000;
function diagnostic(run, reason) {
    return { diagnostic: { reason, run } };
}
export function classifyRuntimeControl(run, value, nowMs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return diagnostic(run.run, "invalid_record");
    }
    const record = value;
    const status = record.status;
    const recordClass = classifyRunControlRecord(record);
    if (!recordClass)
        return diagnostic(run.run, "invalid_status");
    if (typeof record.id !== "string" || !record.id) {
        return diagnostic(run.run, "invalid_control_id");
    }
    if (typeof record.action !== "string" || !record.action) {
        return diagnostic(run.run, "invalid_action");
    }
    if (typeof record.run_instance_id !== "string" || !record.run_instance_id) {
        return diagnostic(run.run, "invalid_generation");
    }
    const timestamp = runControlStatusTimestamp(record, status);
    const timestampMs = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(timestampMs)) {
        return diagnostic(run.run, "invalid_status_timestamp");
    }
    if (recordClass === "terminal")
        return {};
    const ageMs = Math.max(0, Math.floor(nowMs - timestampMs));
    const staleReason = !run.runInstanceId
        ? "run_generation_unavailable"
        : record.run_instance_id !== run.runInstanceId
            ? "run_generation_replaced"
            : run.status !== "running"
                ? "run_terminal"
                : ageMs >= RUNTIME_CONTROL_STALE_AFTER_MS
                    ? "age_threshold_reached"
                    : undefined;
    const projected = ControlProjection.projectRunControl(record);
    const pending = {
        ...projected,
        age_ms: ageMs,
        reason: staleReason ?? "within_age_threshold",
        run: run.run,
        status: status,
        status_at: runControlStatusTimestamp(projected, status),
    };
    return {
        pending,
        ...(staleReason ? { stale: pending } : {}),
    };
}
