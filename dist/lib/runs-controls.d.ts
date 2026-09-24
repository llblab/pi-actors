/**
 * Run Control journal.
 * Zones: durable records, atomic admission, claims, transitions, compaction
 * Owns Run-local Control persistence; lifecycle authorization and transport stay in adapters.
 */
import { type RunControlStatus } from "./run-evidence-policy.ts";
import type { JsonlReadResult } from "./state-readers.ts";
export { RUN_CONTROL_TERMINAL_LIMIT } from "./limits.ts";
export type { RunControlStatus } from "./run-evidence-policy.ts";
export interface RunControlRecord {
    id: string;
    run_instance_id: string;
    action: string;
    input?: unknown;
    status: RunControlStatus;
    queued_at: string;
    delivered_at?: string;
    claimed_at?: string;
    handled_at?: string;
    failed_at?: string;
    error?: string;
}
export interface ProcessRunControlsResult {
    claimed: number;
    failed: number;
    handled: number;
}
export declare function runControlsFile(stateDir: string): string;
export declare function readRunControlJournalFromStateDir(stateDir: string): JsonlReadResult<unknown>;
export declare function readRunControlsFromStateDir(stateDir: string): RunControlRecord[];
export declare function appendRunControlInStateDir(stateDir: string, request: {
    run_instance_id: string;
    action: string;
    input?: unknown;
}): RunControlRecord;
export declare function updateRunControlStatusInStateDir(stateDir: string, id: string, nextStatus: RunControlStatus, metadata?: Pick<RunControlRecord, "error">, expectedStatuses?: readonly RunControlStatus[]): boolean;
export declare function claimRunControlInStateDir(stateDir: string, runInstanceId: string): RunControlRecord | undefined;
export declare function claimRunControlByIdInStateDir(stateDir: string, runInstanceId: string, controlId: string): RunControlRecord | undefined;
export declare function processRunControlsInStateDir(stateDir: string, runInstanceId: string, handler: (control: RunControlRecord) => Promise<void> | void, limit?: number): Promise<ProcessRunControlsResult>;
