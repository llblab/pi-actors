/**
 * Native launch evidence persistence.
 * Owns: generation-bound intent/birth/settlement records and unresolved-scope mutation fences.
 * Excludes: runtime-local admission/acquisition, complete membership, termination, and restart execution.
 */
import { type RunProcessIdentity } from "./runs-process.ts";
export declare const RUN_NATIVE_LAUNCH_FILE = "native-launches.json";
declare const SCHEMA = "run-native-launches-v1";
export interface RunNativeLaunchOwner {
    readonly run: string;
    readonly runInstanceId: string;
    readonly ownerId?: string;
    readonly pid: number;
    readonly processIdentityDigest?: string;
}
export interface RunNativeLaunchRequest {
    readonly commandId: string;
    readonly attempt: number;
}
export interface RunNativeLaunchBirth {
    readonly pid: number;
    readonly observed_at: string;
    readonly process_identity: Readonly<RunProcessIdentity>;
}
export interface RunNativeLaunchCloseSettlement {
    readonly basis?: never;
    readonly observed_at: string;
    readonly native_exit_code: number | null;
    readonly native_signal: NodeJS.Signals | null;
}
export interface RunNativeLaunchAbsenceSettlement {
    readonly basis: "verified_absence";
    readonly observed_at: string;
}
export type RunNativeLaunchSettlement = RunNativeLaunchCloseSettlement | RunNativeLaunchAbsenceSettlement;
export interface RunNativeLaunchIntent {
    readonly intent_id: string;
    readonly command_id: string;
    readonly attempt: number;
    readonly admitted_at: string;
    readonly birth?: RunNativeLaunchBirth;
    readonly settlement?: RunNativeLaunchSettlement;
}
export interface RunNativeLaunchLedger {
    readonly schema: typeof SCHEMA;
    readonly run: string;
    readonly run_instance_id: string;
    readonly ownerId?: string;
    readonly runner_pid: number;
    readonly runner_identity_digest: string | null;
    readonly intents: readonly RunNativeLaunchIntent[];
}
export type RunNativeLaunchReading = {
    state: "absent" | "invalid";
} | {
    state: "available";
    ledger: RunNativeLaunchLedger;
};
/** Even every recorded member's settlement is not complete-scope closure or mutation authority. */
export declare function assertNoRetainedNativeLaunchScope(stateDir: string): void;
/** Absence or an available admission list never proves no child was born or complete scope membership. */
export declare function readRunNativeLaunchLedger(stateDir: string, owner: RunNativeLaunchOwner): RunNativeLaunchReading;
/** Storage only: caller must hold lifecycle admission and supply a kernel-acquired birth, never replayed runtime authority. */
export declare function recordRunNativeLaunchBirthUnderLock(stateDir: string, owner: RunNativeLaunchOwner, intent: Readonly<RunNativeLaunchIntent>, birth: RunNativeLaunchBirth): Readonly<RunNativeLaunchBirth>;
/** Storage only: exact retained birth plus admitted native-close or verified-absence evidence, never work authority. */
export declare function recordRunNativeLaunchSettlementUnderLock<T extends RunNativeLaunchSettlement>(stateDir: string, owner: RunNativeLaunchOwner, update: {
    intent: Readonly<RunNativeLaunchIntent>;
    birth: RunNativeLaunchBirth;
    settlement: T;
}): Readonly<T>;
/** Kernel storage only: caller must hold lifecycle/work admission. No reset or rollback of existing intents. */
export declare function recordRunNativeLaunchIntentUnderLock(stateDir: string, owner: RunNativeLaunchOwner, request: RunNativeLaunchRequest): Readonly<RunNativeLaunchIntent>;
export {};
