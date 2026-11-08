import { type RunContextIndexIdentity } from "./runs-context-index.ts";
export interface ExecutionCaptureView {
    readonly reported_saved_bytes: number | null;
    readonly persistence: "incomplete" | "reported_complete" | "unproven";
    readonly reported_observed_bytes?: number;
    readonly error?: "capture_write_failed";
}
export interface ExecutionAttemptView {
    readonly attempt: number;
    readonly code: number;
    readonly native_exit_code?: number | null;
    readonly native_signal?: string;
    readonly reported_killed?: boolean;
    readonly stdout: Readonly<ExecutionCaptureView>;
    readonly stderr: Readonly<ExecutionCaptureView>;
}
export interface ExecutionCommandView {
    readonly id: string;
    readonly reported_status: string;
    readonly attempts: readonly Readonly<ExecutionAttemptView>[];
    readonly stage?: string;
    readonly command?: string;
    readonly label?: string;
    readonly occurrence?: number;
    readonly branch_index?: number;
    readonly prompt_bytes?: number;
    readonly started_at?: string;
    readonly completed_at?: string;
    readonly semantic_acceptance?: string;
    readonly exit_code?: number;
    readonly effective_exit_code?: number;
    readonly native_exit_code?: number | null;
    readonly reported_killed?: boolean;
    readonly interruption?: string;
    readonly reported_session_file_count?: number;
}
export interface RunExecutionView {
    readonly reported_status: string;
    readonly updated_at: string;
    readonly reported_active_subagents: number;
    readonly commands_total: number;
    readonly settled_attempts_reported: number;
    readonly commands: readonly Readonly<ExecutionCommandView>[];
}
export type RunExecutionProjection = {
    readonly state: "available";
    readonly view: Readonly<RunExecutionView>;
} | {
    readonly state: "unavailable";
    readonly reason: "manifest_invalid" | "identity_mismatch";
};
/** Already-captured metadata is data, never a reconstructed producer/work/close capability. */
export declare function projectRunExecutionManifest(expected: {
    readonly run: string;
    readonly run_instance_id: string;
}, value: unknown, recipe?: Record<string, unknown>, redactEvidence?: (value: unknown) => unknown): Readonly<RunExecutionProjection>;
export type KernelRunStreamSourceReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly stream: "stdout" | "stderr";
    readonly source_scope: "canonical_runner_stream";
    readonly visibility: "kernel_only";
    readonly capture_completeness: "not_asserted";
    readonly bytes_total: number;
    readonly text: string;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "stream_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "stream_missing" | "stream_unavailable" | "stream_too_large" | "stream_invalid_text";
};
/** Never serialize this raw source as tool/model evidence: an export owner still owes a fixed privacy projection. */
export declare function readRunStreamSource(stateDir: string, expected: unknown, stream: unknown): Readonly<KernelRunStreamSourceReading>;
export type RunExecutionReferenceRequest = {
    readonly kind: "capture";
    readonly command_id: string;
    readonly attempt: number;
    readonly stream: "stdout" | "stderr";
} | {
    readonly kind: "session";
    readonly command_id: string;
    readonly path: string;
};
interface ExecutionReferenceMetadata {
    readonly command_id: string;
    readonly path: string;
    readonly local_path: string;
    readonly bytes_total: number;
    readonly mutable: true;
}
export type RunExecutionReference = ExecutionReferenceMetadata & ({
    readonly kind: "capture";
    readonly attempt: number;
    readonly stream: "stdout" | "stderr";
    readonly capture: Readonly<ExecutionCaptureView>;
} | {
    readonly kind: "session";
});
export type RunExecutionReferenceReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly source_updated_at: string;
    readonly reference: Readonly<RunExecutionReference>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "request_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "manifest_absent" | "manifest_unavailable" | "manifest_invalid" | "manifest_identity_mismatch" | "reference_not_recorded" | "reference_invalid" | "reference_missing" | "reference_unavailable" | "reference_changed" | "reference_size_unrepresentable" | "capture_size_mismatch";
};
/** Local paths and unchanged callbacks describe data only, never readable-body exposure or native capabilities. */
export declare function readRunExecutionReference(stateDir: string, expected: unknown, query: unknown): Readonly<RunExecutionReferenceReading>;
export {};
