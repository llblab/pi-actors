/**
 * Run-owned execution session evidence.
 * Zones: execution manifest session discovery, canonical containment, rich turn correlation
 * Owns reusable agent-turn loading; Trace and TUI projection stay in their adapters.
 */
import * as SessionEvidence from "./session-evidence.ts";
export interface ExecutionTurnItem extends SessionEvidence.SessionEvidenceTurn {
    commandId: string;
    diagnostics: string[];
    promptBytes?: number;
    promptFile?: string;
    recipeContext?: unknown;
    sessionFile: string;
    sessionTruncated: boolean;
    stage?: string;
}
export declare const EXECUTION_CHRONOLOGY: unique symbol;
export interface ExecutionChronologyEntry extends SessionEvidence.SessionChronologyEntry {
    commandId: string;
    sessionFile: string;
    sessionOrdinal: number;
}
export type ExecutionChronology = Readonly<{
    basis: "recorded_execution_metadata";
    entries: readonly Readonly<ExecutionChronologyEntry>[];
} & ({
    state: "available";
} | {
    state: "unavailable";
    reason: SessionEvidence.SessionChronologyReason | "source_changed" | "namespace_unavailable";
})>;
export type ExecutionTurnCollection = ExecutionTurnItem[] & {
    readonly [EXECUTION_CHRONOLOGY]?: ExecutionChronology;
};
export declare function readExecutionTurns(stateDir: string): ExecutionTurnCollection;
