/**
 * Run Trace event journal.
 * Zones: structured event validation, bounded atomic retention, resilient reads
 * Owns canonical Run-local Trace persistence; lifecycle projection and owner attention delivery stay in adapters.
 */
import type { StateReadDiagnostic } from "./state-readers.ts";
export interface TraceEvent {
    id: string;
    ts: string;
    kind: string;
    summary?: string;
    data?: unknown;
    level?: "info" | "warning" | "error";
    attention?: "notify" | "followup" | "steer";
}
export interface AppendTraceEventInput {
    kind: string;
    summary?: string;
    data?: unknown;
    level?: TraceEvent["level"];
    attention?: TraceEvent["attention"];
}
export interface RunTraceReadEvent {
    event: TraceEvent;
    ordinal: number;
}
export interface RunTraceJournalRead {
    diagnostics: StateReadDiagnostic[];
    events: RunTraceReadEvent[];
    fileBytes: number;
    omittedPrefixBytes: number;
    readBytes: number;
}
export interface RunTraceSummary {
    compacted: boolean;
    compactions_total: number;
    dropped_bytes: number;
    dropped_event_count_exact: boolean;
    dropped_events: number;
    history_complete: boolean;
    retained_bytes: number;
    retained_events: number;
}
export declare function runTraceFile(stateDir: string): string;
export declare function appendRunTraceEvent(stateDir: string, input: AppendTraceEventInput): TraceEvent;
export declare function readRunTraceJournal(stateDir: string): RunTraceJournalRead;
export declare function summarizeRunTraceJournal(read: RunTraceJournalRead): RunTraceSummary;
export declare function readRunTraceEvents(stateDir: string, limit?: number): TraceEvent[];
