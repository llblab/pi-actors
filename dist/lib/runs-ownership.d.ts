/**
 * Async run state-directory ownership.
 * Owns: marker proof for lifecycle/retention and optional bounded readonly identity admission.
 */
export declare const RUN_STATE_OWNERSHIP_FILE = ".pi-actors-run-state.json";
/** Avoid acquiring the same lifecycle resource through a second path while its parent lock is held. */
export declare function assertDistinctRunStateDirectories(parentStateDir: string, childStateDir: string): void;
export declare function claimRunStateDirectory(stateDir: string, run: string): string;
/** Read only the public marker identity, never its private ownership token. */
export declare function readOwnedRunStateDirectory(stateDir: string, options?: {
    maxBytes?: number;
}): {
    run: string;
    stateDir: string;
};
export declare function assertOwnedRunStateDirectory(stateDir: string, run: string): string;
