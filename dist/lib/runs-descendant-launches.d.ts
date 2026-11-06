/**
 * Descendant Run launch-intent evidence.
 * Owns: declared/prepared parent-child generation facts, strict persistence, and unresolved-scope mutation fences.
 * Excludes: authenticating child birth/membership, work/control authority, exhaustive scope, and termination.
 */
export declare const RUN_DESCENDANT_LAUNCH_FILE = "descendant-launches.json";
export declare const RUN_DESCENDANT_PREPARATION_FILE = "descendant-preparation.json";
export declare const RUN_DESCENDANT_PREPARED_META_FILE = "prepared-run.json";
declare const SCHEMA = "run-descendant-launches-v1";
declare const PREPARATION_SCHEMA = "run-descendant-preparation-v1";
export interface RunDescendantLaunchOwner {
    readonly run: string;
    readonly runInstanceId: string;
    readonly ownerId?: string;
    readonly pid: number;
    readonly processIdentityDigest?: string;
}
export interface RunDescendantLaunchRequest {
    readonly run: string;
    readonly runInstanceId: string;
    readonly ownerId?: string;
    readonly stateDir: string;
}
export interface RunDescendantLaunchTarget {
    readonly run: string;
    readonly run_instance_id: string;
    readonly ownerId?: string;
    readonly state_dir: string;
}
export interface RunDescendantPreparedFact {
    readonly preparation_id: string;
    readonly prepared_at: string;
}
/** Persisted reference to the original producer, never a reconstructed runtime capability or native membership proof. */
export interface RunDescendantProducerBinding {
    readonly pid: number;
    readonly process_identity_digest: string | null;
}
export interface RunDescendantPreparation extends RunDescendantPreparedFact {
    readonly schema: typeof PREPARATION_SCHEMA;
    readonly parent: Readonly<RunDescendantLaunchTarget>;
    readonly child: Readonly<RunDescendantLaunchTarget>;
    readonly parent_producer?: Readonly<RunDescendantProducerBinding>;
}
export interface RunDescendantLaunchIntent {
    readonly intent_id: string;
    readonly admitted_at: string;
    readonly child: Readonly<RunDescendantLaunchTarget>;
    readonly preparation?: Readonly<RunDescendantPreparedFact>;
}
export interface RunDescendantLaunchLedger {
    readonly schema: typeof SCHEMA;
    readonly run: string;
    readonly run_instance_id: string;
    readonly ownerId?: string;
    readonly runner_pid: number;
    readonly runner_identity_digest: string | null;
    readonly intents: readonly Readonly<RunDescendantLaunchIntent>[];
}
export type RunDescendantLaunchReading = {
    state: "absent" | "invalid";
} | {
    state: "available";
    ledger: Readonly<RunDescendantLaunchLedger>;
};
/** Validated reference data only; resolving a target never grants work or membership authority. */
export declare function resolveRunDescendantLaunchTarget(value: unknown, owner: RunDescendantLaunchOwner, stateDir: string): Readonly<RunDescendantLaunchTarget> | undefined;
/** Only ENOENT permits mutation; an empty or invalid journal is not closure proof. */
export declare function assertNoRetainedDescendantLaunchScope(stateDir: string): void;
/** Declared generations and paths confer no child work/control authority or exhaustive membership. */
export declare function readRunDescendantLaunchLedger(stateDir: string, owner: RunDescendantLaunchOwner): RunDescendantLaunchReading;
/** Retained preparation data is evidence, never a native-start or membership capability. */
export declare function readRunDescendantPreparation(stateDir: string, child: RunDescendantLaunchTarget, parent: RunDescendantLaunchTarget): Readonly<RunDescendantPreparation> | undefined;
/** Fresh evidence checks only, not a capability reconstructed from staged metadata. */
export declare function assertRunDescendantPreparedMetadata(stateDir: string, child: RunDescendantLaunchTarget): void;
/** Storage only: the kernel prepare-only branch owns child creation and holds parent then child lifecycle locks. */
export declare function recordRunDescendantPreparationUnderLock(stateDir: string, child: RunDescendantLaunchTarget, parent: RunDescendantLaunchTarget, producer: RunDescendantLaunchOwner): Readonly<RunDescendantPreparation>;
/** Storage only: bare intents require work admission; prepared facts may use evidence admission. Validate child evidence under its lock. */
export declare function recordRunDescendantLaunchIntentUnderLock(stateDir: string, owner: RunDescendantLaunchOwner, request: RunDescendantLaunchRequest, preparation?: RunDescendantPreparation): Readonly<RunDescendantLaunchIntent>;
export {};
