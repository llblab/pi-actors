/**
 * Parent-session actor teardown.
 * Owns: exact-owner running-run selection, kill revalidation, bounded outcomes, and partial-failure continuation.
 */
export interface ParentRunTeardownCandidate {
    ownerId: string;
    run: string;
    runInstanceId?: string;
    stateDir: string;
}
export type ParentRunTeardownOutcome = "killed" | "skipped" | "failed";
export interface ParentRunTeardownAttempt extends ParentRunTeardownCandidate {
    outcome: ParentRunTeardownOutcome;
    reason?: string;
}
export interface ParentRunTeardownDiscoveryFailure {
    path: string;
    reason: string;
}
export interface ParentRunTeardownResult {
    attempted: number;
    discoveryFailed: number;
    discoveryFailures: ParentRunTeardownDiscoveryFailure[];
    failed: number;
    killed: number;
    skipped: number;
    attempts: ParentRunTeardownAttempt[];
}
export interface ParentRunTeardownSummary extends ParentRunTeardownResult {
    attemptsOmitted: number;
    discoveryFailuresOmitted: number;
    ownerId: string;
    trigger: string;
    ts: string;
    version: 1;
}
export declare function buildBoundedParentTeardownSummary(result: ParentRunTeardownResult, ownerId: string, trigger: string, ts: string): ParentRunTeardownSummary;
export interface ParentRunTeardownDeps {
    getRunStatus: (stateDir: string) => Record<string, unknown>;
    killRun: (stateDir: string, expected: {
        ownerId: string;
        runInstanceId: string;
    }) => Record<string, unknown>;
    listRunStatuses: () => Array<Record<string, unknown>> | {
        failures: ParentRunTeardownDiscoveryFailure[];
        statuses: Array<Record<string, unknown>>;
    };
    recordAttempt: (attempt: ParentRunTeardownAttempt) => void;
}
export declare function selectParentRunTeardownCandidates(ownerId: string | undefined, statuses: Array<Record<string, unknown>>): ParentRunTeardownCandidate[];
export declare function teardownParentRuns(ownerId: string | undefined, deps: ParentRunTeardownDeps): ParentRunTeardownResult;
