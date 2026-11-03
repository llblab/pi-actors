/**
 * Bounded Run observation projection.
 * Owns: one data-only snapshot shape from already-admitted identity/lifecycle/timing facts.
 * Excludes: evidence reads/admission, reference authorization/redaction, clocks, exports,
 * lifecycle mutation, delivery acceptance, and native work/control/scope authority.
 */
export interface RunSnapshotIdentity {
    readonly run: string;
    readonly run_instance_id: string;
    readonly ownerId?: string;
}
/** Kernel read-model inputs, not raw Run metadata or serialized proof capabilities. */
export interface RunSnapshotFacts {
    readonly identity: RunSnapshotIdentity;
    readonly captured_at: string;
    readonly timing: {
        readonly basis: "live" | "terminal";
        readonly elapsed_ms: number;
    } | {
        readonly basis: "unproven";
    };
    readonly lifecycle: {
        readonly status: "running";
        readonly phase?: "stopping";
    } | {
        readonly status: "done" | "failed";
    } | {
        readonly status: "unproven";
    };
    readonly cwd: string;
    readonly context_index?: {
        readonly identity: RunSnapshotIdentity;
        readonly path: string;
    };
}
export interface RunSnapshot {
    readonly kind: "run_snapshot";
    readonly run: string;
    readonly run_instance_id: string;
    readonly captured_at: string;
    readonly elapsed_ms: number;
    readonly status: "running" | "done" | "failed";
    readonly phase?: "stopping";
    readonly cwd: string;
    readonly evidence: string | null;
    readonly evidence_error?: "index_unavailable";
}
type SnapshotUnavailableReason = "identity_unavailable" | "identity_mismatch" | "observation_unavailable" | "lifecycle_unproven" | "timing_unproven" | "references_unavailable" | "snapshot_too_large";
export type RunSnapshotProjection = {
    readonly state: "available";
    readonly snapshot: Readonly<RunSnapshot>;
} | {
    readonly state: "unavailable";
    readonly reason: SnapshotUnavailableReason;
};
/** Facts and curated references must be admitted by their owners before projection; no I/O or authority is acquired here. */
export declare function projectRunSnapshot(expected: unknown, facts: unknown): Readonly<RunSnapshotProjection>;
export {};
