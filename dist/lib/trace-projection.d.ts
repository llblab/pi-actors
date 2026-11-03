/**
 * Unified bounded Run Trace projection.
 * Zones: causal evidence merge, source filtering, redaction, deterministic ordering
 * Owns public Trace items; source journals and session parsing remain in their domains.
 */
import { type RunArtifactDeclaration } from "./runs-artifacts.ts";
import * as RunsTrace from "./runs-trace.ts";
export type TraceSource = "lifecycle" | "control" | "process" | "agent" | "artifact" | "runtime";
export type TraceSourceFilter = TraceSource | "all";
export declare const TRACE_ITEM_SEQUENCE: unique symbol;
export declare const TRACE_ITEM_CHRONOLOGY: unique symbol;
export type TraceChronologyReason = "history_incomplete" | "control_history_unproven" | "metadata_unavailable" | "metadata_private" | "metadata_too_large" | "metadata_ambiguous" | "timestamp_unavailable";
export type TraceChronology = Readonly<{
    basis: "recorded_observations";
} & ({
    state: "available";
    ordinal: number;
    total: number;
} | {
    state: "unavailable";
    reason: TraceChronologyReason;
})>;
export interface TraceItem {
    id: string;
    ts: string;
    [TRACE_ITEM_SEQUENCE]?: number;
    [TRACE_ITEM_CHRONOLOGY]?: TraceChronology;
    source: TraceSource;
    kind: string;
    summary: string;
    level?: "info" | "warning" | "error";
    detail: unknown;
}
/** Data-only canonical-journal projection; captured Recipe context supplies privacy, never lifecycle/work authority. */
export declare function projectRunTraceJournal(read: RunsTrace.RunTraceJournalRead, options?: {
    limit?: number;
    recipe?: Record<string, unknown>;
    redactEvidence?: (value: unknown) => unknown;
}): TraceItem[];
export declare function projectRunTrace(stateDir: string, options?: {
    artifacts?: Record<string, RunArtifactDeclaration>;
    limit?: number;
    source?: TraceSourceFilter;
}): TraceItem[];
