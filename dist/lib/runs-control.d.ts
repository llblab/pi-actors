/**
 * Async run process control primitives.
 * Owns: platform signal planning, owned-process signalling, and terminal control markers.
 */
import { spawnSync } from "node:child_process";
import { type RunProcessIdentity, type RunProcessIdentityResult } from "./runs-process.ts";
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
export declare function markTerminalHandled(stateDir: string, details: Record<string, unknown>): void;
export declare function buildTerminalProgress(existing: Record<string, unknown> | undefined, phase: "cancelled" | "killed"): Record<string, unknown>;
