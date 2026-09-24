/**
 * Actor Inspector actions for concrete Run instances.
 * Owns: exact-session run-action authorization, canonical kill routing, and bounded operator feedback.
 */
export interface ActorInspectorKillResult {
    ok: boolean;
    message: string;
}
export interface ActorInspectorKillDeps {
    getRunStatus: (runOrDir: string) => Record<string, unknown>;
    killRun: (runOrDir: string, expected: {
        ownerId: string;
        runInstanceId: string;
    }) => Record<string, unknown>;
}
export declare function killOwnedRunFromInspector(ownerId: string, run: string, stateRoot: string, expectedRunInstanceId: string, deps: ActorInspectorKillDeps): ActorInspectorKillResult;
