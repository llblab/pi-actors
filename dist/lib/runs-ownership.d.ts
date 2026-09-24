/**
 * Async run state-directory ownership.
 * Owns: the marker proof required before launch and destructive retention.
 */
export declare const RUN_STATE_OWNERSHIP_FILE = ".pi-actors-run-state.json";
export declare function claimRunStateDirectory(stateDir: string, run: string): string;
export declare function assertOwnedRunStateDirectory(stateDir: string, run: string): string;
