/**
 * Async run state index.
 * Owns: recursive run-state discovery, index rebuild/read, and status filtering.
 */
export interface RunStateIndexEntry {
    ownerId?: string;
    recipe?: string;
    run: string;
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
export declare function rebuildRunStateIndex(stateRoot: string, getRunStatus: RunStatusReader): RunStateIndexEntry[];
export declare function readRunStateIndex(stateRoot: string, readJson: (path: string) => Record<string, unknown> | undefined): RunStateIndexEntry[] | undefined;
export declare function listRuns(stateRoot: string, getRunStatus: RunStatusReader, readJson: (path: string) => Record<string, unknown> | undefined, statusFilter?: string): Array<Record<string, unknown>>;
