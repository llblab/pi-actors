/**
 * Async run process identity helpers.
 * Owns: cross-platform liveness and stable runner process identity proofs.
 */
export interface RunProcessIdentity {
    command: string;
    cwd?: string;
    platform: NodeJS.Platform;
    start_time: string;
}
export type RunProcessIdentityStatus = "valid" | "dead_pid" | "owner_mismatch" | "unsupported_proof";
export interface RunProcessIdentityResult {
    status: RunProcessIdentityStatus;
    valid: boolean;
}
type ProcessIdentityReader = (pid: number, runtimePlatform: NodeJS.Platform) => RunProcessIdentity | undefined;
export declare function isAlive(pid: number): boolean;
export declare function readProcessIdentity(pid: number, runtimePlatform?: NodeJS.Platform): RunProcessIdentity | undefined;
export declare function captureRunProcessIdentity(pid: number, cwd: string, stateDir: string, runnerPath: string, runtimePlatform?: NodeJS.Platform, reader?: ProcessIdentityReader): RunProcessIdentity | undefined;
export declare function verifyRunProcessIdentity(pid: number, expected: RunProcessIdentity | undefined, runtimePlatform?: NodeJS.Platform, reader?: ProcessIdentityReader, alive?: (pid: number) => boolean): RunProcessIdentityResult;
export declare function isWithinRunnerIdentityGrace(meta: Record<string, unknown>, graceMs: number): boolean;
export {};
