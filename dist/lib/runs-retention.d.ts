/**
 * Run retirement owner.
 * Owns: lifecycle-serialized manual archive/prune, age-based cleanup and shared ownership/scope fences.
 * Excludes: native closure proof, process actuation and ordinary non-Run temp cleanup.
 */
import { cpSync } from "node:fs";
export type RunRetentionAction = "archive" | "prune";
export type RunRetentionOutcome = "queued" | "handled" | "failed";
export declare const DEFAULT_RUN_MAX_AGE_MS: number;
export interface RunRetentionExpectation {
    onLocked?(): void;
    ownerId?: string;
    runInstanceId?: string;
}
/** Manual API preserves its existing status/expected contract, not a native closure claim. */
export declare function retainRun(stateDir: string, action: RunRetentionAction, expected: RunRetentionExpectation, readStatus: (stateDir: string) => Record<string, unknown>, options?: {
    preserveArtifacts?: boolean;
}): Record<string, unknown>;
/** Filesystem age selects candidates; it grants neither retirement nor native scope authority. */
export declare function cleanupStaleRunEntries(runsDir: string, maxAgeMs?: number, now?: number): Promise<number>;
export declare function appendRunRetentionEvidence(status: Record<string, unknown>, action: RunRetentionAction, outcome: RunRetentionOutcome, options?: {
    error?: string;
    id?: string;
    result?: Record<string, unknown>;
}): string;
export declare function archiveTerminalRun(status: Record<string, unknown>): Record<string, unknown>;
export declare function pruneTerminalRun(status: Record<string, unknown>, options?: {
    preserveArtifacts?: boolean;
}, deps?: {
    copyArtifact?: typeof cpSync;
}): Record<string, unknown>;
