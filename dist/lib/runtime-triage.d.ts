/**
 * Pure runtime Control triage policy.
 * Zones: pending admission, status-age classification, terminal/replacement staleness
 * Owns Control triage decisions; journal reads and owner filtering stay in adapters, while safe fields come from control-projection.
 */
import * as ControlProjection from "./control-projection.ts";
export declare const RUNTIME_CONTROL_STALE_AFTER_MS: number;
export interface RuntimeTriageRun {
    run: string;
    runInstanceId?: string;
    status: string;
}
export interface RuntimePendingControl extends ControlProjection.ProjectedRunControl {
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
export declare function classifyRuntimeControl(run: RuntimeTriageRun, value: unknown, nowMs: number): RuntimeControlClassification;
