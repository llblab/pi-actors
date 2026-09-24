/**
 * Persisted Pi session evidence reader.
 * Zones: subagent turns, active session branches, bounded/redacted previews
 * Owns read-only normalization of session JSONL into inspector-ready turns.
 */
import { type StateReadDiagnostic } from "./state-readers.ts";
export interface SessionEvidenceToolCall {
    arguments?: unknown;
    id: string;
    name: string;
    result?: unknown;
    resultError?: boolean;
}
export interface SessionEvidenceTurn {
    assistantEntryId?: string;
    assistantText?: string;
    error?: string;
    index: number;
    model?: string;
    provider?: string;
    stopReason?: string;
    thinking?: string;
    timestamp?: string;
    toolCalls: SessionEvidenceToolCall[];
    unmatchedToolResults: number;
    usage?: unknown;
    userEntryId?: string;
    userText?: string;
}
export interface SessionEvidence {
    activeLeafId?: string;
    diagnostics: StateReadDiagnostic[];
    path: string;
    session?: Record<string, unknown>;
    totalTurns: number;
    truncated: boolean;
    turns: SessionEvidenceTurn[];
}
export interface SessionEvidenceReadOptions {
    maxBytes?: number;
    maxTextChars?: number;
    maxToolCalls?: number;
    maxTurns?: number;
}
export type ActiveSessionEntryMatch = "present" | "conflict" | undefined;
export interface ActiveSessionEntryEvidence {
    examinedBytes: number;
    examinedEntries: number;
    reason?: string;
    status: "present" | "absent" | "conflict" | "unknown";
}
export interface ActiveSessionEntryEvidenceInput {
    getEntry(id: string): unknown;
    leaf: unknown;
    match(entry: Record<string, unknown>): ActiveSessionEntryMatch;
    maxBytes?: number;
    maxEntries?: number;
}
/** Walk only the active parent chain under exact entry and byte ceilings. */
export declare function inspectBoundedActiveSessionEntries(input: ActiveSessionEntryEvidenceInput): ActiveSessionEntryEvidence;
export declare function redactSessionEvidenceValue(value: unknown, maxTextChars?: number, seen?: WeakSet<object>): unknown;
export declare function readSessionEvidence(path: string, options?: SessionEvidenceReadOptions): SessionEvidence;
