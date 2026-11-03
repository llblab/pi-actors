/**
 * Async run process control primitives.
 * Owns: platform signalling, stop-request admission, evidence-only member/preparation recovery, and terminal control markers.
 * Excludes: deadline eligibility and proof of complete owned-scope termination.
 */
import { spawnSync } from "node:child_process";
import { type RunDescendantLaunchIntent, type RunDescendantLaunchRequest } from "./runs-descendant-launches.ts";
import { type RunNativeLaunchAbsenceSettlement, type RunNativeLaunchSettlement } from "./runs-native-launches.ts";
import { type RunStopClaim, type RunStopReason } from "./runs-outcomes.ts";
import { type RunProcessExitDeps, type RunProcessIdentity, type RunProcessIdentityResult } from "./runs-process.ts";
export interface RunProcessSignalPlan {
    args?: string[];
    command?: string;
    signalTarget: "processGroup" | "process" | "processTree";
}
export declare function getRunProcessSignalPlan(pid: number, signal: NodeJS.Signals, runtimePlatform?: NodeJS.Platform): RunProcessSignalPlan;
export interface RunProcessSignalDeps {
    killProcess?: typeof process.kill;
    runtimePlatform?: NodeJS.Platform;
    spawnProcess?: typeof spawnSync;
    verifyIdentity?: (pid: number, expected: RunProcessIdentity, runtimePlatform: NodeJS.Platform) => RunProcessIdentityResult;
}
export declare function signalOwnedRunProcess(pid: number, signal: NodeJS.Signals, expectedIdentity?: RunProcessIdentity, deps?: RunProcessSignalDeps): RunProcessSignalPlan;
export interface RunStopClaimRequest {
    runInstanceId: string;
    ownerId?: string;
    reason: RunStopReason;
}
export type RunStopClaimResult = {
    status: "stop_requested";
    stopped: false;
    reused: boolean;
    claim: Readonly<RunStopClaim>;
} | {
    status: "already_terminal";
    terminal_status: "done" | "failed";
} | {
    status: "rejected";
    code: string;
};
/**
 * Requests only: no signal, handled marker, or claim of physical termination.
 * The supervisor owns deadline eligibility; this owner revalidates configuration and identity.
 * Legacy producers cannot participate until they bind the serialized outcome protocol.
 */
export declare function claimRunStop(stateDir: string, request: RunStopClaimRequest, deps?: RunProcessSignalDeps & {
    onLockContention?: () => void;
}): RunStopClaimResult;
export interface RunNativeMemberRecoveryRequest {
    runInstanceId: string;
    ownerId?: string;
    intentId: string;
}
export type RunNativeMemberRecoveryResult = {
    status: "recorded";
    settlement: Readonly<RunNativeLaunchAbsenceSettlement>;
} | {
    status: "already_recorded";
    settlement: Readonly<RunNativeLaunchSettlement>;
} | {
    status: "unproven";
    reason: string;
} | {
    status: "rejected";
    code: string;
};
/** Evidence only after producer exit; never repair birth, dispatch signals, reopen work, or finalize a scope. */
export declare function recoverRunNativeMemberExit(stateDir: string, request: RunNativeMemberRecoveryRequest, deps?: RunProcessExitDeps & {
    onLockContention?: () => void;
}): RunNativeMemberRecoveryResult;
export interface RunDescendantPreparationRecoveryRequest {
    runInstanceId: string;
    ownerId?: string;
    child: RunDescendantLaunchRequest;
}
export interface RunDescendantRecoveryCleanupFailure {
    readonly status: "release_unproven";
    readonly error_code: string;
}
export type RunDescendantPreparationRecoveryResult = ({
    status: "recorded" | "already_recorded";
    intent: Readonly<RunDescendantLaunchIntent>;
} | {
    status: "unproven";
    reason: string;
} | {
    status: "rejected";
    code: string;
}) & {
    readonly cleanup?: Readonly<RunDescendantRecoveryCleanupFailure>;
};
/** Post-producer metadata evidence only; never recreate a producer, launch work, invent exits, or release scope guards. */
export declare function recoverRunDescendantPreparation(stateDir: string, request: RunDescendantPreparationRecoveryRequest, deps?: RunProcessExitDeps & {
    onLockContention?: () => void;
}): Readonly<RunDescendantPreparationRecoveryResult>;
export declare function markTerminalHandled(stateDir: string, details: Record<string, unknown>): void;
export declare function buildTerminalProgress(existing: Record<string, unknown> | undefined, phase: "cancelled" | "killed"): Record<string, unknown>;
