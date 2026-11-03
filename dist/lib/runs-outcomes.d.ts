/**
 * Generation-bound outcome protocol and durable stop-request state.
 * Owns: bounded stop records, process binding, lifecycle-locked stop persistence, canonical result classification and primary/artifact binding data schemas.
 * Excludes: lock acquisition, primary body admission/publication, deadline eligibility, signals, exit proof and delivery.
 */
export declare const RUN_PRIMARY_TEXT_PROTOCOL = "run-primary-text-v1";
export declare const RUN_ARTIFACT_INVENTORY_PROTOCOL = "run-artifact-inventory-v1";
export declare const RUN_RESULT_DIAGNOSTICS_PROTOCOL = "run-result-diagnostics-v1";
export declare const RUN_RESULT_DIAGNOSTIC_FIELDS: readonly ["command", "error", "failure_reason"];
export type RunResultDiagnosticField = typeof RUN_RESULT_DIAGNOSTIC_FIELDS[number];
export type RunResultDiagnosticCandidate = Readonly<Partial<Record<RunResultDiagnosticField, string>>>;
export declare const RUN_RESULT_DIAGNOSTIC_EXCERPT_CHARS = 1000;
export interface RunResultDiagnosticExcerpt {
    readonly text: string;
    readonly bytes_total: number;
    readonly shown_bytes: Readonly<{
        start: number;
        end: number;
    }>;
    readonly chars_total: number;
    readonly chars_shown: number;
    readonly chars_omitted: number;
    readonly truncated: boolean;
}
export type RunResultDiagnosticPacketExcerpt = Readonly<RunResultDiagnosticExcerpt & {
    field: RunResultDiagnosticField;
}>;
export interface RunResultDiagnosticsReference {
    readonly source: Readonly<{
        path: string;
        run_instance_id: string;
        sha256: string;
    }>;
    readonly bytes_total: number;
    readonly fields: readonly RunResultDiagnosticField[];
}
export type RunResultDiagnosticsBinding = {
    readonly result_diagnostics: Readonly<RunResultDiagnosticsReference>;
} | {
    readonly result_diagnostics: null;
    readonly result_diagnostics_unavailable: string;
};
export interface RunArtifactInventoryReference {
    readonly source: Readonly<{
        path: string;
        run_instance_id: string;
        sha256: string;
    }>;
    readonly bytes_total: number;
    readonly declarations_total: number;
}
export type RunArtifactInventoryBinding = {
    readonly artifact_inventory: Readonly<RunArtifactInventoryReference>;
} | {
    readonly artifact_inventory: null;
    readonly artifact_inventory_unavailable: string;
};
export interface RunPrimaryTextOutput {
    readonly text_basis?: "actor_response";
    readonly upstream_truncated?: boolean;
    readonly source: {
        readonly path: string;
        readonly run_instance_id: string;
        readonly sha256: string;
    };
    readonly bytes_total: number;
    readonly shown_bytes: {
        readonly start: number;
        readonly end: number;
    };
    readonly chars_total: number;
    readonly chars_shown: number;
    readonly chars_omitted: number;
    readonly preview: string;
    readonly truncated: boolean;
    readonly redacted: boolean;
}
/** Completion-only admitted source text; this data is not an independent publication or read grant. */
export interface RunCompletionText {
    readonly text: string;
    readonly shown_bytes: Readonly<{
        start: number;
        end: number;
    }>;
}
/** Prefix presentation only; preserve Unicode scalars and never split an admitted CRLF. */
export declare function projectRunCompletionText(text: string, maxBytes: number): Readonly<RunCompletionText>;
export declare function decodeRunCompletionText(primary: Readonly<RunPrimaryTextBinding> | undefined, value: unknown): Readonly<RunCompletionText>;
export type RunPrimaryTextBinding = {
    readonly output: Readonly<RunPrimaryTextOutput>;
} | {
    readonly output: null;
    readonly output_unavailable: string;
};
/** Curated JSON-data schema only; neither decoding nor a protocol marker admits a body, producer or work. */
export declare function decodeRunPrimaryTextBinding(stateDir: string, generation: string, value: unknown): Readonly<RunPrimaryTextBinding>;
/** Data schema only; copied actor fields/markers cannot publish or authorize inventory/body reads. */
export declare function decodeRunArtifactInventoryBinding(stateDir: string, generation: string, value: unknown): Readonly<RunArtifactInventoryBinding>;
/** Curated diagnostic reference data only, never candidate/producer/publication/body permission. */
export declare function decodeRunResultDiagnosticsBinding(stateDir: string, generation: string, value: unknown): Readonly<RunResultDiagnosticsBinding>;
/** Frozen literal prefix metadata only; a valid excerpt/reference DTO does not authorize source publication. */
export declare function decodeRunResultDiagnosticExcerpt(reference: Readonly<RunResultDiagnosticsReference>, value: unknown): RunResultDiagnosticPacketExcerpt;
export declare const RUN_OUTCOME_PROTOCOL: "run-outcome-v1";
export declare const RUN_STOP_CLAIM_FILE = "stop-claim.json";
export type RunStopReason = "manual_kill" | "max_runtime";
export interface RunStopClaim {
    version: 1;
    claim_id: string;
    run: string;
    run_instance_id: string;
    ownerId?: string;
    pid: number;
    process_identity_digest: string;
    reason: RunStopReason;
    requested_at: string;
}
export type RunStopClaimReading = {
    state: "absent" | "stale" | "invalid";
} | {
    state: "pending";
    claim: Readonly<RunStopClaim>;
};
export declare function readRunStopClaim(stateDir: string, meta: Record<string, unknown>): RunStopClaimReading;
/** Only the control owner may call this after admission under the canonical lifecycle lock. */
export declare function writeRunStopClaimUnderLock(stateDir: string, meta: Record<string, unknown>, reason: RunStopReason): Readonly<RunStopClaim>;
/** Capture markers never imply terminal acceptance, even when their claim is unavailable. */
export declare function isRunStopResultCapture(result: Record<string, unknown> | undefined): boolean;
export type RunNaturalOutcomeReading = {
    state: "absent" | "invalid" | "captured";
} | {
    state: "accepted";
    status: "done" | "failed";
};
export interface RunNaturalOutcomeSnapshot {
    readonly result: Record<string, unknown> | undefined;
    readonly outcome: RunNaturalOutcomeReading;
}
/** Read one regular-file result snapshot for both precedence and rendering; data never grants work/stop authority. */
export declare function readRunNaturalOutcomeSnapshot(stateDir: string, meta: Record<string, unknown>, readResult?: (path: string) => unknown): Readonly<RunNaturalOutcomeSnapshot>;
/** Result bodies remain in their existing canonical file; this is admission, not a second store. */
export declare function readRunNaturalOutcome(stateDir: string, meta: Record<string, unknown>): RunNaturalOutcomeReading;
