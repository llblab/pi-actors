/**
 * Run result-producer admission and natural terminal publication.
 * Owns: producer authority, work/scoped evidence admission, first-result source bindings and natural-acceptance timing eligibility.
 * Excludes: workload execution, stop-request admission, process/tree proof, and delivery.
 */
import type { ChildProcess } from "node:child_process";
import { type CommandTemplateAttemptReceipt, type CommandTemplateManagedAttempt } from "./command-templates.ts";
import { type RunDescendantLaunchIntent, type RunDescendantLaunchRequest } from "./runs-descendant-launches.ts";
import { type RunNativeLaunchBirth, type RunNativeLaunchIntent, type RunNativeLaunchRequest, type RunNativeLaunchCloseSettlement } from "./runs-native-launches.ts";
import { type RunResultDiagnosticCandidate, type RunResultDiagnosticsBinding, type RunPrimaryTextBinding, type RunArtifactInventoryBinding } from "./runs-outcomes.ts";
import { type SpawnIdentityCaptureDeps } from "./runs-process.ts";
import { type AppendTraceEventInput } from "./runs-trace.ts";
export interface RunResultProducer {
    readonly run: string;
    readonly runInstanceId: string;
    readonly ownerId?: string;
    readonly pid: number;
    readonly processIdentityDigest?: string;
}
/** Immutable admission capture, copied on read. Metadata cannot reconstruct its genuine producer key. */
export declare function readRunProducerCapturedMetadata(producer: RunResultProducer, maxBytes: number): Record<string, unknown> | undefined;
export interface RunProducerCleanupFailure {
    readonly status: "release_unproven";
    readonly error_code: string;
}
/** Runtime-local diagnostics only; absence is not proof that a lifecycle lock was released. */
export declare function readRunProducerCleanupFailure(producer: RunResultProducer): Readonly<RunProducerCleanupFailure> | undefined;
/** Kernel lifecycle composition only; a child preparation's cleanup failure fences its genuine parent producer. */
export declare function reportRunProducerCleanupFailure(producer: RunResultProducer, error: unknown): void;
/** Opaque, synchronous first-result source admission; copied markers cannot recreate it. */
export interface RunResultDiagnosticsAdmission {
    readonly kernel_only: true;
}
/** Runtime-local timing eligibility only; the marker/serialized data is not authority. */
export interface RunNaturalResultTimingAdmission {
    readonly kernel_only: true;
}
export interface RunNaturalResultTimingAcceptance {
    readonly state: "available";
    readonly identity: Readonly<{
        run: string;
        run_instance_id: string;
        ownerId?: string;
    }>;
    readonly code: number;
    readonly recorded_status: "done" | "failed";
    readonly completed_at: string;
    readonly acceptance: "natural";
    readonly timing: "not_asserted";
}
export type RunNaturalResultTimingAcceptanceReading = Readonly<RunNaturalResultTimingAcceptance> | {
    readonly state: "unavailable";
    readonly reason: "admission_invalid" | "admission_mismatch";
};
export interface RunResultPublicationOptions {
    /** Invocation-local trusted kernel port; source preparation/publication must already be complete. */
    primaryText?: () => Readonly<RunPrimaryTextBinding>;
    /** Kernel-captured metadata source, prepared before result admission; never an actor result field. */
    artifactInventory?: () => Readonly<RunArtifactInventoryBinding>;
    /** First-winner source publication only, with a runtime-local candidate admission under the existing lock. */
    resultDiagnostics?: (admission: RunResultDiagnosticsAdmission) => Readonly<RunResultDiagnosticsBinding>;
    /** Natural-only postcommit event, before Trace. No clock/origin/sample, body, work or frozen timing authority. */
    naturalResultTiming?: (admission: RunNaturalResultTimingAdmission) => void;
    /** Synchronous evidence updates, only after producer and first-result admission. */
    prepare?: (context: {
        stopping: boolean;
    }) => void;
    trace?: AppendTraceEventInput;
    /** Contention instrumentation must not mutate Run state before revalidation. */
    onLockContention?: () => void;
}
export declare function admitRunResultProducer(stateDir: string): {
    meta: Record<string, unknown>;
    producer: RunResultProducer;
};
/** Revalidate only inside this producer's exact synchronous work callback; never a new work permission. */
export declare function revalidateRunWorkAdmission(stateDir: string, producer: RunResultProducer): void;
/**
 * Synchronous kernel preparation/native launch only. Never await workload or inference under this lock.
 * Runtime-local authority retains its native fingerprint without OS reprobes; a live self-PID cannot recycle.
 * Separate child-Run admission and complete owned-scope receipts remain with their lifecycle owners.
 */
export declare function withRunWorkAdmission<T>(stateDir: string, producer: RunResultProducer, admit: () => T, options?: Pick<RunResultPublicationOptions, "onLockContention">): T;
/**
 * Declared intent only, not a child-start capability or membership receipt.
 * Run synchronous kernel preparation after persistence; never await workload/inference here.
 */
export declare function withRunDescendantIntentAdmission<T>(stateDir: string, producer: RunResultProducer, request: RunDescendantLaunchRequest, prepare: (intent: Readonly<RunDescendantLaunchIntent>) => T, options?: Pick<RunResultPublicationOptions, "onLockContention">): T;
export interface RunDescendantReconciliationResult {
    readonly status: "recorded" | "already_recorded";
    readonly intent: Readonly<RunDescendantLaunchIntent>;
}
/** Same-runtime evidence repair only: never spawn, reconstruct a producer, reopen work, or release scope fences. */
export declare function reconcileRunDescendantPreparation(stateDir: string, producer: RunResultProducer, request: RunDescendantLaunchRequest, options?: Pick<RunResultPublicationOptions, "onLockContention">): Readonly<RunDescendantReconciliationResult>;
/** Called only by the executor's synchronous managed observer inside this native launch admission. */
export declare function bindRunNativeLaunchProcess(stateDir: string, producer: RunResultProducer, intent: Readonly<RunNativeLaunchIntent>, context: CommandTemplateManagedAttempt, deps?: SpawnIdentityCaptureDeps): Readonly<RunNativeLaunchBirth>;
/** Actual direct-process close only; recording while stopping never grants whole-scope terminal authority. */
export declare function recordRunNativeLaunchSettlement(stateDir: string, producer: RunResultProducer, intent: Readonly<RunNativeLaunchIntent>, receipt: CommandTemplateAttemptReceipt, options?: Pick<RunResultPublicationOptions, "onLockContention">): Readonly<RunNativeLaunchCloseSettlement>;
/**
 * Private native launch primitive: retain admission before invoking the synchronous factory.
 * Journal writes precede the factory; lifecycle cleanup failure is retained separately, never replacing its outcome.
 * A throw retains uncertainty, never rollback or proof that no child was born.
 * Runner wiring requires crash/reuse fences and birth/member proof; this receipt alone grants no stop authority.
 */
export declare function withRunNativeLaunchAdmission(stateDir: string, producer: RunResultProducer, request: RunNativeLaunchRequest, start: (intent: Readonly<RunNativeLaunchIntent>) => ChildProcess, options?: Pick<RunResultPublicationOptions, "onLockContention">): ChildProcess;
/** Synchronous evidence writes only, including while stopping; this never grants work or terminal authority. */
export declare function withRunProducerEvidence<T>(stateDir: string, producer: RunResultProducer, record: (context: {
    readonly status: "running" | "stopping" | "done" | "failed";
}) => T, options?: Pick<RunResultPublicationOptions, "onLockContention">): T;
/** Evidence only within the exact active first-result callback, never nested lock/work/result authority. */
export declare function withRunResultDiagnosticsAdmission<T>(stateDir: string, producer: RunResultProducer, admission: RunResultDiagnosticsAdmission, record: (candidate: RunResultDiagnosticCandidate) => T): T;
/** Exact active first-natural callback only; never reacquires the already-held lifecycle lock. */
export declare function withRunNaturalResultTimingAdmission<T>(stateDir: string, producer: RunResultProducer, admission: RunNaturalResultTimingAdmission, record: (acceptance: Readonly<RunNaturalResultTimingAcceptance>) => T): T;
/** Pure historical acceptance receipt, not a current-file/status fence, elapsed sample or timing authority. */
export declare function readRunNaturalResultTimingAcceptance(stateDir: string, producer: RunResultProducer, admission: unknown): Readonly<RunNaturalResultTimingAcceptanceReading>;
export declare function publishRunResult(stateDir: string, producer: RunResultProducer, result: Record<string, unknown>, options?: RunResultPublicationOptions): boolean;
