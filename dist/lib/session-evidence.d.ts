/**
 * Persisted Pi session evidence reader.
 * Zones: subagent turns, active session branches, bounded/redacted previews
 * Owns read-only normalization of session JSONL into inspector-ready turns.
 */
import { type StateReadDiagnostic } from "./state-readers.ts";
interface SessionEntry {
    id?: unknown;
    message?: unknown;
    parentId?: unknown;
    timestamp?: unknown;
    type?: unknown;
    [key: string]: unknown;
}
export interface SessionEvidenceToolCall {
    arguments?: unknown;
    id: string;
    name: string;
    result?: unknown;
    resultError?: boolean;
}
export declare const SESSION_TURN_IDENTITY: unique symbol;
interface SessionTurnIdentity {
    basis: "entry" | "record";
    entryId?: string;
    sessionId?: string;
    role: "assistant" | "user";
    ordinal?: number;
}
export interface SessionEvidenceTurn {
    [SESSION_TURN_IDENTITY]?: Readonly<SessionTurnIdentity>;
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
export declare const SESSION_EVIDENCE_CHRONOLOGY: unique symbol;
export interface SessionChronologyEntry {
    ordinal: number;
    timestamp: string;
    identity: Readonly<SessionTurnIdentity>;
}
export type SessionChronologyReason = "source_unavailable" | "identity_unavailable" | "timestamp_unavailable" | "metadata_too_large";
export type SessionChronology = Readonly<{
    basis: "recorded_branch_metadata";
    entries: readonly Readonly<SessionChronologyEntry>[];
} & ({
    state: "available";
} | {
    state: "unavailable";
    reason: SessionChronologyReason;
})>;
export interface SessionEvidence {
    [SESSION_EVIDENCE_CHRONOLOGY]?: SessionChronology;
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
/** Physical last-leaf ancestry, not current model context or a claim about a live SessionManager leaf. */
export declare function selectLastRecordedSessionBranch(entries: SessionEntry[], path: string, diagnostics: StateReadDiagnostic[]): SessionEntry[];
export declare function readSessionEvidence(path: string, options?: SessionEvidenceReadOptions): SessionEvidence;
export {};
