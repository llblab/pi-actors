/**
 * Resilient state readers.
 * Zones: file-backed actor state, JSON/JSONL diagnostics, inspect safety
 * Owns best-effort JSON and JSONL parsing helpers for operator-facing state reads.
 */
export interface StateReadDiagnostic {
    line?: number;
    message: string;
    path: string;
}
export interface JsonReadResult<T> {
    diagnostics: StateReadDiagnostic[];
    value: T;
}
export interface JsonlReadResult<T> {
    diagnostics: StateReadDiagnostic[];
    records: T[];
    truncated?: boolean;
}
export interface JsonlReadOptions {
    maxBytes?: number;
}
export declare function readJsonFileResilient<T>(path: string, fallback: T): JsonReadResult<T>;
export declare function readJsonlFileResilient<T>(path: string, options?: JsonlReadOptions): JsonlReadResult<T>;
export declare function formatStateReadDiagnostics(diagnostics: StateReadDiagnostic[], limit?: number): string[];
