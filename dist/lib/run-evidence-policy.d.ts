/**
 * Pure bounded Run-evidence policy.
 * Zones: Trace retention, compaction accounting, Control capacity and admission
 * Owns deterministic limits policy; journal I/O, locks, lifecycle authorization, and projection stay in adapters.
 * Trace keeps the newest physical suffix because semantic priority would silently
 * redefine causal history. Admitted Controls never expire: only a real terminal
 * transition or generation replacement proves that durable work is finished.
 */
export declare const TRACE_COMPACTION_KIND = "runtime.trace_compacted";
export declare const TRACE_COMPACTION_VERSION = 1;
export type TraceJournalUsage = {
    bytes: number;
    events: number;
};
export type TraceRetentionCandidate<T> = {
    encodedBytes: number;
    value: T;
};
export type TraceRetentionSelection<T> = {
    droppedEvents: number;
    retained: TraceRetentionCandidate<T>[];
    retainedBytes: number;
    retainedEvents: number;
};
export interface TraceCompactionData {
    version: typeof TRACE_COMPACTION_VERSION;
    compactions_total: number;
    dropped_valid_events_total: number;
    dropped_malformed_lines_total: number;
    dropped_bytes_total: number;
    dropped_event_count_exact: boolean;
    retained_events: number;
    retained_bytes: number;
    history_complete: false;
}
export interface TraceCompactionDelta {
    dropped_valid_events: number;
    dropped_malformed_lines: number;
    dropped_bytes: number;
    dropped_event_count_exact: boolean;
    retained_events: number;
    retained_bytes: number;
}
export type RunControlStatus = "queued" | "delivered" | "claimed" | "handled" | "failed";
export type RunControlCapacity = {
    available: number;
    backpressured: boolean;
    limit: number;
    oldest_pending_at?: string;
    pending: number;
};
export type RunControlAdmissionIntegrity = "valid" | "unreadable" | "malformed" | "noncanonical" | "invalid_record" | "invalid_status_timestamp" | "generation_mismatch" | "journal_bytes";
export interface RunControlAdmissionErrorDetails {
    reason: "control_backpressure" | "control_journal_integrity";
    pending: number;
    limit: number;
    journal_bytes: number;
    journal_limit: number;
    oldest_pending_at?: string;
    run_instance_id: string;
    next_actions: string[];
    integrity_reason?: string;
}
export type RunControlAdmissionDecision = {
    admitted: true;
    capacity: RunControlCapacity;
} | {
    admitted: false;
    capacity: RunControlCapacity;
    error: RunControlAdmissionErrorDetails;
};
export type RunControlAdmissionInput = {
    integrity: RunControlAdmissionIntegrity;
    journalBytes: number;
    newRecordBytes: number;
    records: readonly unknown[];
    retainedJournalBytes: number;
    runInstanceId: string;
    capacity?: RunControlCapacity;
};
export declare function traceAppendFits(usage: TraceJournalUsage, encodedEventBytes: number): boolean;
export declare function selectNewestTraceSuffix<T>(candidates: readonly TraceRetentionCandidate<T>[], reserve?: {
    bytes?: number;
    events?: number;
}): TraceRetentionSelection<T>;
export declare function accumulateTraceCompactionStatistics(previous: TraceCompactionData | undefined, delta: TraceCompactionDelta): TraceCompactionData;
export declare function traceCompactionMarkerInput(data: TraceCompactionData): {
    data: TraceCompactionData;
    kind: typeof TRACE_COMPACTION_KIND;
    level: "warning";
};
export declare function classifyRunControlRecord(value: unknown): "pending" | "terminal" | undefined;
export declare function runControlStatusTimestamp(record: Record<string, unknown>, status: RunControlStatus): unknown;
export declare function computeRunControlCapacity(records: readonly unknown[]): RunControlCapacity;
export declare function decideRunControlAdmission(input: RunControlAdmissionInput): RunControlAdmissionDecision;
