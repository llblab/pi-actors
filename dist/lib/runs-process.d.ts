/**
 * Async run process identity helpers.
 * Owns: cross-platform liveness, stable runner identity, and single-process exit observations.
 * Excludes: stop claims, signal dispatch, descendant/group cleanup, and lifecycle finalization.
 */
import { type ChildProcess } from "node:child_process";
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
export type ProcessLiveness = "alive" | "dead" | "unknown";
type ProcessLivenessProbe = (pid: number, signal: 0) => boolean;
export declare function readProcessLiveness(pid: number, probe?: ProcessLivenessProbe): ProcessLiveness;
/** POSIX group presence only: neither ownership, membership completeness, nor whole-Run stop proof. */
export declare function readProcessGroupLiveness(processGroupId: number, runtimePlatform?: NodeJS.Platform, probe?: ProcessLivenessProbe): ProcessLiveness;
/** Unknown liveness must retain active-state guards, never authorize state reuse. */
export declare function isAlive(pid: number): boolean;
export declare const WINDOWS_IDENTITY_QUERY_PID_LIMIT = 64;
/** One bounded, complete CIM observation; undefined means query failure, never process absence. */
export declare function readWindowsProcessIdentities(pids: readonly number[]): Map<number, RunProcessIdentity> | undefined;
export declare function readProcessIdentity(pid: number, runtimePlatform?: NodeJS.Platform): RunProcessIdentity | undefined;
export declare function runProcessIdentityDigest(value: unknown): string | undefined;
export declare function captureRunProcessIdentity(pid: number, cwd: string, stateDir: string, runnerPath: string, runtimePlatform?: NodeJS.Platform, reader?: ProcessIdentityReader): RunProcessIdentity | undefined;
export interface SpawnIdentityCaptureDeps {
    runtimePlatform?: NodeJS.Platform;
    readIdentity?: ProcessIdentityReader;
    now?: () => number;
    wait?: (milliseconds: number) => void;
}
/** Fresh spawn only, while its lifecycle lock/child handle is retained and workload is not admitted. */
export declare function captureSpawnedRunProcessIdentity(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">, cwd: string, stateDir: string, runnerPath: string, deps?: SpawnIdentityCaptureDeps): RunProcessIdentity | undefined;
/** Immediate managed-native callback only; this observation is not complete membership or termination authority. */
export declare function captureSpawnedNativeProcessIdentity(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">, deps?: SpawnIdentityCaptureDeps): RunProcessIdentity | undefined;
export declare function verifyRunProcessIdentity(pid: number, expected: RunProcessIdentity | undefined, runtimePlatform?: NodeJS.Platform, reader?: ProcessIdentityReader, alive?: (pid: number) => boolean): RunProcessIdentityResult;
export interface RunProcessExitObservation {
    status: "exited" | "running" | "unproven";
    process_identity_status: RunProcessIdentityStatus;
}
export interface RunProcessExitDeps {
    probe?: ProcessLivenessProbe;
    readIdentity?: ProcessIdentityReader;
    runtimePlatform?: NodeJS.Platform;
}
/** Observes one captured process only; signal dispatch and descendant cleanup are separate facts. */
export declare function observeRunProcessExit(pid: number, expected: RunProcessIdentity | undefined, deps?: RunProcessExitDeps): RunProcessExitObservation;
export declare function isWithinRunnerIdentityGrace(meta: Record<string, unknown>, graceMs: number): boolean;
export {};
