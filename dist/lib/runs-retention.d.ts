/**
 * Async run retention operations.
 * Owns: terminal-run archive and prune filesystem behavior.
 */
import { cpSync } from "node:fs";
export type RunRetentionAction = "archive" | "prune";
export type RunRetentionOutcome = "queued" | "handled" | "failed";
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
