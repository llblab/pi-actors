/**
 * Pure runtime Control triage policy.
 * Zones: pending admission, status-age classification, terminal/replacement staleness
 * Owns Control triage decisions; journal reads and owner filtering stay in adapters, while safe fields come from control-projection.
 */

import * as ControlProjection from "./control-projection.ts";
import {
  classifyRunControlRecord,
  runControlStatusTimestamp,
  type RunControlStatus,
} from "./run-evidence-policy.ts";
import type { RunControlRecord } from "./runs-controls.ts";

export const RUNTIME_CONTROL_STALE_AFTER_MS = 5 * 60 * 1_000;

export interface RuntimeTriageRun {
  run: string;
  runInstanceId?: string;
  status: string;
}

export interface RuntimePendingControl
  extends ControlProjection.ProjectedRunControl {
  age_ms: number;
  reason: "age_threshold_reached" | "run_generation_replaced" | "run_generation_unavailable" | "run_terminal" | "within_age_threshold";
  run: string;
  status: "queued" | "delivered" | "claimed";
  status_at: string;
}

export interface RuntimeControlDiagnostic {
  reason: "invalid_action" | "invalid_control_id" | "invalid_generation" | "invalid_record" | "invalid_status" | "invalid_status_timestamp";
  run: string;
}

export interface RuntimeControlClassification {
  diagnostic?: RuntimeControlDiagnostic;
  pending?: RuntimePendingControl;
  stale?: RuntimePendingControl;
}

function diagnostic(
  run: string,
  reason: RuntimeControlDiagnostic["reason"],
): RuntimeControlClassification {
  return { diagnostic: { reason, run } };
}

export function classifyRuntimeControl(
  run: RuntimeTriageRun,
  value: unknown,
  nowMs: number,
): RuntimeControlClassification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return diagnostic(run.run, "invalid_record");
  }
  const record = value as Record<string, unknown>;
  const status = record.status as RunControlStatus;
  const recordClass = classifyRunControlRecord(record);
  if (!recordClass) return diagnostic(run.run, "invalid_status");
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
  if (recordClass === "terminal") return {};
  const ageMs = Math.max(0, Math.floor(nowMs - timestampMs));
  const staleReason: RuntimePendingControl["reason"] | undefined =
    !run.runInstanceId
      ? "run_generation_unavailable"
      : record.run_instance_id !== run.runInstanceId
        ? "run_generation_replaced"
        : run.status !== "running"
          ? "run_terminal"
          : ageMs >= RUNTIME_CONTROL_STALE_AFTER_MS
            ? "age_threshold_reached"
            : undefined;
  const projected = ControlProjection.projectRunControl(
    record as unknown as RunControlRecord,
  );
  const pending: RuntimePendingControl = {
    ...projected,
    age_ms: ageMs,
    reason: staleReason ?? "within_age_threshold",
    run: run.run,
    status: status as RuntimePendingControl["status"],
    status_at: runControlStatusTimestamp(
      projected as unknown as Record<string, unknown>,
      status,
    ) as string,
  };
  return {
    pending,
    ...(staleReason ? { stale: pending } : {}),
  };
}
