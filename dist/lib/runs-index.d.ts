/**
 * Async run state index.
 * Owns: directory discovery, locked catalog registration/rebuild, same-session location navigation, and legacy inventory.
 * Excludes: launch wiring, model delivery, work/native authority, and retained-generation storage.
 */
import { type RunContextIndexIdentity } from "./runs-context-index.ts";
export interface RunStateIndexEntry {
    ownerId?: string;
    recipe?: string;
    run: string;
    run_instance_id?: string;
    state_dir: string;
    status: string;
    tool?: string;
    updated_at?: string;
}
export type RunStatusReader = (runOrDir: string) => Record<string, unknown>;
export interface RunStateDiscoveryIssue {
    path: string;
    reason: "depth_truncated" | "unreadable";
}
export interface RunStateDiscoveryResult {
    issues: RunStateDiscoveryIssue[];
    stateDirs: string[];
}
export declare function discoverRunStateDirs(stateRoot: string, maxDepth?: number): RunStateDiscoveryResult;
export declare function listRunStateDirs(stateRoot: string): string[];
/** Kernel metadata registration only; never a producer, work or visibility capability. */
export declare function registerRunStateDirectory(stateRoot: string, stateDir: string, status: Record<string, unknown>): void;
export declare function rebuildRunStateIndex(stateRoot: string, getRunStatus: RunStatusReader): RunStateIndexEntry[];
export interface RunNavigationFile {
    readonly role: string;
    readonly format_hint: "json" | "jsonl" | "text";
    readonly state: "present" | "missing" | "unavailable";
    readonly path: string | null;
    readonly bytes_total?: number;
    readonly mutable: true;
}
export interface RunNavigationItem {
    readonly run: string;
    readonly run_instance_id: string | null;
    readonly state: "available" | "unavailable";
    readonly directory: string | null;
    readonly depth: number;
    readonly files: readonly Readonly<RunNavigationFile>[];
    readonly reason?: string;
}
export interface RunNavigationPriority {
    readonly root_order: "latest_registration" | "failed_subtrees_first";
    /** Observed data for ordering only; exact map identity admission remains independent. */
    readonly failed: readonly Readonly<RunContextIndexIdentity & {
        state_dir: string;
    }>[];
}
export type RunSessionNavigation = {
    readonly state: "unavailable";
    readonly reason: "session_unavailable" | "catalog_unavailable" | "response_too_large";
} | {
    readonly state: "available";
    readonly session_id: string;
    readonly content_scope: "file_locations_only";
    readonly lineage_scope: "direct_session_owned_rows";
    readonly file_inventory_scope: "canonical_starting_locations";
    readonly priority?: Readonly<{
        root_order: RunNavigationPriority["root_order"];
        basis: "observed_failed_rows";
    }>;
    readonly items: readonly Readonly<RunNavigationItem>[];
    readonly shown: number;
    readonly omitted: number;
    readonly total: number;
};
export type RunDirectoryNavigation = {
    readonly state: "unavailable";
    readonly reason: "session_unavailable" | "session_mismatch" | "session_changed" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "navigation_unavailable" | "response_too_large";
} | {
    readonly state: "available";
    readonly content_scope: "file_locations_only";
    readonly file_inventory_scope: "canonical_starting_locations";
    readonly run: string;
    readonly run_instance_id: string;
    readonly directory: string;
    readonly files: readonly Readonly<RunNavigationFile>[];
};
/** Pure data decoder for frozen location packets; schema validity never grants read/publication/work authority. */
export declare function decodeRunDirectoryNavigation(value: unknown): Readonly<RunDirectoryNavigation>;
/** One exact current-session Run's physical starting locations; no catalog/body reads or authority recovery. */
export declare function readRunDirectoryNavigation(stateDir: string, expected: unknown, sessionId: string | undefined): Readonly<RunDirectoryNavigation>;
/** Current Kernel session selection only; no body reads, scans, producer key or old manager retention. */
export declare function readRunSessionNavigation(stateRoot: string, sessionId: string, priority?: RunNavigationPriority): Readonly<RunSessionNavigation>;
export declare function readRunStateIndex(stateRoot: string, readJson: (path: string) => Record<string, unknown> | undefined): RunStateIndexEntry[] | undefined;
export declare function listRuns(stateRoot: string, getRunStatus: RunStatusReader, readJson: (path: string) => Record<string, unknown> | undefined, statusFilter?: string): Array<Record<string, unknown>>;
