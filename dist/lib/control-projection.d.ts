/**
 * Model-facing Run Control projection.
 * Zones: structured redaction, bounded Control input/error, decision-useful evidence
 * Owns safe Control reads; durable journals and lifecycle transitions remain in runs-controls.
 */
import type { RunControlRecord, RunControlStatus } from "./runs-controls.ts";
export interface ProjectedRunControl {
    action: string;
    claimed_at?: string;
    delivered_at?: string;
    error?: string;
    failed_at?: string;
    handled_at?: string;
    id: string;
    input?: unknown;
    queued_at: string;
    run_instance_id: string;
    status: RunControlStatus;
}
export declare function projectRunControl(control: RunControlRecord): ProjectedRunControl;
