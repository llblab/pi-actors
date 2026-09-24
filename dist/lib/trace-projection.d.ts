/**
 * Unified bounded Run Trace projection.
 * Zones: causal evidence merge, source filtering, redaction, deterministic ordering
 * Owns public Trace items; source journals and session parsing remain in their domains.
 */
import { type RunArtifactDeclaration } from "./runs-artifacts.ts";
export type TraceSource = "lifecycle" | "control" | "process" | "agent" | "artifact" | "runtime";
export type TraceSourceFilter = TraceSource | "all";
export declare const TRACE_ITEM_SEQUENCE: unique symbol;
export interface TraceItem {
    id: string;
    ts: string;
    [TRACE_ITEM_SEQUENCE]?: number;
    source: TraceSource;
    kind: string;
    summary: string;
    level?: "info" | "warning" | "error";
    detail: unknown;
}
export declare function projectRunTrace(stateDir: string, options?: {
    artifacts?: Record<string, RunArtifactDeclaration>;
    limit?: number;
    source?: TraceSourceFilter;
}): TraceItem[];
