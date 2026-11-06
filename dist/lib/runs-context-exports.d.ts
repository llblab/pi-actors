/**
 * Producer-bound Run context, primary text and index orchestration.
 * Owns: admitted privacy capture, atomic derived views, producer-backed saved Recipe/Trace/Control/Execution/Result correspondence, immutable primary source publication/readonly admission and index assembly.
 * Excludes: public routing, session/composed/failure primary publication, live clocks and native work/control authority.
 */
import type { CommandTemplateAttemptReceipt } from "./command-templates.ts";
import { type ProjectedRunControl } from "./control-projection.ts";
import { type RunExecutionView } from "./runs-execution-evidence.ts";
import { projectRunRecipe } from "./recipe-projection.ts";
import { computeRunControlCapacity } from "./run-evidence-policy.ts";
import { readRunSupervisionClock } from "./run-supervision.ts";
import { type RunContextEntry, type RunContextIndexPublication, type RunContextIndexIdentity } from "./runs-context-index.ts";
import { RUN_RESULT_DIAGNOSTIC_FIELDS as RESULT_DIAGNOSTIC_FIELDS, type RunResultDiagnosticsBinding, type RunResultDiagnosticExcerpt, type RunResultDiagnosticPacketExcerpt, type RunArtifactInventoryBinding, type RunArtifactInventoryReference, type RunPrimaryTextBinding, type RunPrimaryTextOutput } from "./runs-outcomes.ts";
import { type RunResultDiagnosticsAdmission, type RunResultProducer } from "./runs-results.ts";
import { type RunTraceSummary } from "./runs-trace.ts";
import { type TraceItem } from "./trace-projection.ts";
export { readRunSessionContextPreview, writeRunSessionContextExport, writeRunSessionContextIndex, RUN_CONTEXT_SESSIONS_MAX_BYTES } from "./runs-session-exports.ts";
export type { RunSessionContextExportResult, RunSessionContextPreviewReading } from "./runs-session-exports.ts";
export declare const RUN_CONTEXT_CONTROL_MAX_BYTES: number;
declare const CONTROL_VIEW_COVERAGE: Readonly<{
    truncated: true;
    history_complete: false;
    redacted: true;
}>;
export declare const RUN_CONTEXT_RECIPE_MAX_BYTES: number;
declare const RECIPE_VIEW_COVERAGE: Readonly<{
    truncated: true;
    redacted: true;
}>;
export declare const RUN_CONTEXT_TRACE_MAX_BYTES: number;
declare const TRACE_VIEW_COVERAGE: Readonly<{
    truncated: true;
    history_complete: false;
    redacted: true;
}>;
export declare const RUN_CONTEXT_RESULT_MAX_BYTES: number;
export declare const RUN_RESULT_DIAGNOSTICS_MAX_BYTES: number;
declare const RESULT_VIEW_COVERAGE: Readonly<{
    truncated: true;
    redacted: true;
}>;
export declare const RUN_CONTEXT_ARTIFACT_MAX_BYTES: number;
export declare const RUN_ARTIFACT_INVENTORY_MAX_BYTES: number;
export declare const RUN_CONTEXT_EXECUTION_MAX_BYTES: number;
declare const EXECUTION_VIEW_COVERAGE: Readonly<{
    truncated: true;
    history_complete: false;
    redacted: true;
}>;
type WrittenView = {
    readonly status: "written";
    readonly captured_at: string;
    readonly entry: Readonly<RunContextEntry>;
};
type RecipeUnavailable = {
    readonly status: "unavailable";
    readonly reason: "recipe_capture_absent" | "recipe_metadata_unavailable" | "recipe_metadata_invalid" | "recipe_metadata_changed" | "recipe_admission_unavailable" | "recipe_identity_redacted" | "recipe_metadata_redacted" | "recipe_view_too_large";
};
type TraceUnavailable = {
    readonly status: "unavailable";
    readonly reason: "trace_journal_absent" | "trace_journal_unavailable" | "trace_journal_invalid" | "trace_journal_changed" | "trace_metadata_unavailable" | "trace_metadata_changed" | "trace_admission_unavailable" | "trace_identity_redacted" | "trace_metadata_redacted";
};
type ResultUnavailable = {
    readonly status: "unavailable";
    readonly reason: "result_absent" | "result_unavailable" | "result_invalid" | "result_changed" | "result_metadata_unavailable" | "result_identity_redacted" | "result_metadata_redacted" | "result_view_too_large" | "result_diagnostics_invalid" | "result_diagnostics_too_large";
};
type ArtifactUnavailable = {
    readonly status: "unavailable";
    readonly reason: "artifact_declarations_absent" | "artifact_declarations_invalid" | "artifact_base_unavailable" | "artifact_metadata_unavailable" | "artifact_metadata_changed" | "artifact_manifest_too_large" | "artifact_observation_unavailable" | "artifact_admission_unavailable" | "artifact_identity_redacted";
};
type ExecutionUnavailable = {
    readonly status: "unavailable";
    readonly reason: "execution_absent" | "execution_unavailable" | "execution_invalid" | "execution_changed" | "execution_metadata_unavailable" | "execution_admission_unavailable" | "execution_identity_redacted" | "execution_metadata_redacted" | "execution_view_too_large";
};
export type RunExecutionContextExportResult = ExecutionUnavailable | WrittenView;
export type RunArtifactContextExportResult = ArtifactUnavailable | WrittenView;
export type RunResultContextExportResult = ResultUnavailable | WrittenView;
export type RunTraceContextExportResult = TraceUnavailable | WrittenView;
export type RunRecipeContextExportResult = RecipeUnavailable | WrittenView;
type Unavailable = {
    readonly status: "unavailable";
    readonly reason: "control_journal_absent" | "control_journal_unavailable" | "control_journal_invalid" | "control_journal_changed" | "control_metadata_unavailable" | "control_metadata_changed" | "control_admission_unavailable" | "control_identity_redacted" | "control_metadata_redacted";
};
export type RunControlContextExportResult = Unavailable | WrittenView;
type RecipeProjection = {
    readonly capture: "definition_and_launch" | "launch_only";
    readonly recipe: ReturnType<typeof projectRunRecipe>;
    readonly stored_clock?: NonNullable<ReturnType<typeof readRunSupervisionClock>>;
};
export interface RunRecipeContextView extends RecipeProjection {
    readonly schema: "run-context-recipe-v1";
    readonly run: string;
    readonly run_instance_id: string;
    readonly captured_at: string;
    readonly coverage: typeof RECIPE_VIEW_COVERAGE;
}
export type RunRecipeContextViewReading = {
    readonly state: "available";
    readonly basis: "original_producer_projection_match";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly path: string;
    readonly media_type: "application/json";
    readonly bytes_total: number;
    readonly mutable: true;
    readonly view: Readonly<RunRecipeContextView>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "admission_invalid" | "admission_unavailable" | "identity_redacted" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "recipe_unavailable" | "view_unavailable" | "view_invalid" | "view_metadata_redacted" | "view_mismatch" | "response_too_large";
};
/** Kernel-local original data correspondence, not file-issuer authentication or work/caller/restart authority. */
export declare function readRunRecipeContextView(stateDir: string, producer: RunResultProducer): Readonly<RunRecipeContextViewReading>;
export interface RunControlContextView {
    readonly schema: "run-context-control-v1";
    readonly run: string;
    readonly run_instance_id: string;
    readonly captured_at: string;
    readonly run_status: string;
    readonly coverage: typeof CONTROL_VIEW_COVERAGE;
    readonly capacity: ReturnType<typeof computeRunControlCapacity>;
    readonly controls: readonly ProjectedRunControl[];
    readonly controls_omitted: number;
    readonly foreign_controls_omitted: number;
}
export type RunControlContextViewReading = {
    readonly state: "available";
    readonly basis: "original_control_publication_match";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly path: string;
    readonly media_type: "application/json";
    readonly bytes_total: number;
    readonly mutable: true;
    readonly view: Readonly<RunControlContextView>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "admission_invalid" | "admission_unavailable" | "publication_unavailable" | "identity_redacted" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "control_unavailable" | "view_unavailable" | "view_invalid" | "view_metadata_redacted" | "view_mismatch" | "response_too_large";
};
/** Recorded Control data only; neither current readiness/capacity nor authority to admit, dispatch or stop work. */
export declare function readRunControlContextView(stateDir: string, producer: RunResultProducer): Readonly<RunControlContextViewReading>;
export interface RunExecutionContextView {
    readonly schema: "run-context-execution-v1";
    readonly run: string;
    readonly run_instance_id: string;
    readonly captured_at: string;
    readonly coverage: typeof EXECUTION_VIEW_COVERAGE;
    readonly source_scope: "execution_manifest";
    readonly capture_references: "not_exported";
    readonly capture_bodies: "not_read";
    readonly session_bodies: "not_read";
    readonly scope_closure: "not_asserted";
    readonly execution: Readonly<RunExecutionView>;
}
export type RunExecutionContextViewReading = {
    readonly state: "available";
    readonly basis: "original_execution_publication_match";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly path: string;
    readonly media_type: "application/json";
    readonly bytes_total: number;
    readonly mutable: true;
    readonly view: Readonly<RunExecutionContextView>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "admission_invalid" | "admission_unavailable" | "publication_unavailable" | "identity_redacted" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "execution_unavailable" | "view_unavailable" | "view_invalid" | "view_metadata_redacted" | "view_mismatch" | "response_too_large";
};
/** Historical admitted metadata only: recorded references/exits/killed facts grant no body, lifecycle or native authority. */
export declare function readRunExecutionContextView(stateDir: string, producer: RunResultProducer): Readonly<RunExecutionContextViewReading>;
export interface RunResultContextView {
    readonly schema: "run-context-result-v1";
    readonly run: string;
    readonly run_instance_id: string;
    readonly captured_at: string;
    readonly coverage: typeof RESULT_VIEW_COVERAGE;
    readonly content_scope: "canonical_outcome_metadata";
    readonly primary_text: "not_included";
    readonly diagnostics: Readonly<{
        state: "not_recorded";
    }> | Readonly<{
        state: "available";
        source: Readonly<{
            path: string;
            run_instance_id: string;
            sha256: string;
        }>;
        bytes_total: number;
        fields: Readonly<Partial<Record<typeof RESULT_DIAGNOSTIC_FIELDS[number], Omit<RunResultDiagnosticExcerpt, "text">>>>;
    }>;
    readonly outcome: Readonly<{
        code: number;
        recorded_at: string;
        command?: string;
        error?: string;
        failure_reason?: string;
        producer_flags?: Readonly<{
            reported_killed?: boolean;
            reported_truncated?: boolean;
        }>;
    }> & (Readonly<{
        acceptance: "natural";
        terminal_status: "done" | "failed";
    }> | Readonly<{
        acceptance: "capture_only";
    }>);
}
export type RunResultContextViewReading = {
    readonly state: "available";
    readonly basis: "original_result_publication_match";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly path: string;
    readonly media_type: "application/json";
    readonly bytes_total: number;
    readonly mutable: true;
    readonly view: Readonly<RunResultContextView>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "admission_invalid" | "admission_unavailable" | "publication_unavailable" | "identity_redacted" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "result_unavailable" | "view_unavailable" | "view_invalid" | "view_metadata_redacted" | "view_mismatch" | "response_too_large";
};
/** Original successful Result-view data only, never current outcome/source/body, active terminal or cleanup authority. */
export declare function readRunResultContextView(stateDir: string, producer: RunResultProducer): Readonly<RunResultContextViewReading>;
export interface RunTraceContextView {
    readonly header: {
        readonly schema: "run-context-trace-v1";
        readonly run: string;
        readonly run_instance_id: string;
        readonly captured_at: string;
        readonly source_scope: "canonical_journal";
        readonly order: "newest_first";
        readonly coverage: typeof TRACE_VIEW_COVERAGE;
        readonly journal: RunTraceSummary;
        readonly read_omitted_events: number;
        readonly events_total: number;
        readonly events_shown: number;
        readonly events_omitted: number;
    };
    readonly items: readonly TraceItem[];
}
export type RunTraceContextViewReading = {
    readonly state: "available";
    readonly basis: "original_trace_publication_match";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly path: string;
    readonly media_type: "application/x-ndjson";
    readonly bytes_total: number;
    readonly mutable: true;
    readonly view: Readonly<RunTraceContextView>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "admission_invalid" | "admission_unavailable" | "publication_unavailable" | "identity_redacted" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "trace_unavailable" | "view_unavailable" | "view_invalid" | "view_metadata_redacted" | "view_mismatch" | "response_too_large";
};
/** Reads original successful publication data, never a live journal projection or a reconstructed binding. */
export declare function readRunTraceContextView(stateDir: string, producer: RunResultProducer): Readonly<RunTraceContextViewReading>;
export interface RunResultDiagnosticsPublisher {
    readonly publish: (admission: RunResultDiagnosticsAdmission) => Readonly<RunResultDiagnosticsBinding>;
    readonly readFailure: () => unknown;
}
/** Capture privacy before work. Source I/O occurs only in the genuine synchronous first-result callback, not initialization. */
export declare function createRunResultDiagnosticsPublisher(stateDir: string, producer: RunResultProducer): Readonly<RunResultDiagnosticsPublisher>;
type ResultDiagnosticField = typeof RESULT_DIAGNOSTIC_FIELDS[number];
export type RunResultDiagnosticsReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly recorded_acceptance: "natural" | "capture_only";
    readonly field: ResultDiagnosticField;
    readonly content_scope: "canonical_outcome_diagnostic_strings";
    readonly privacy_scope: "producer_admission";
    readonly primary_text: "not_included";
    readonly redacted: true;
    readonly selection: "recorded_preview" | "byte_range";
    readonly diagnostics: Readonly<{
        source: Readonly<{
            path: string;
            run_instance_id: string;
            sha256: string;
        }>;
        bytes_total: number;
    }>;
    readonly output: Readonly<RunResultDiagnosticExcerpt>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "selection_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "index_unavailable" | "publication_unavailable" | "view_unavailable" | "view_invalid" | "diagnostics_unavailable" | "field_unavailable" | "source_unavailable" | "source_invalid" | "range_invalid" | "range_too_large";
};
export type RunResultDiagnosticOutcomeReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly binding: Readonly<RunResultDiagnosticsBinding>;
    readonly excerpt: RunResultDiagnosticPacketExcerpt;
    readonly terminal_status: "done" | "failed";
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "selection_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "result_unavailable" | "publication_unavailable" | "binding_invalid" | "diagnostics_unavailable" | "nonterminal_capture" | "outcome_mismatch" | "source_unavailable" | "source_invalid";
    readonly result_diagnostics_unavailable?: string;
};
/** Eligible completion only: exact natural first-result metadata binding, never a view/index or raw-output fallback. */
export declare function readRunResultDiagnosticOutcome(stateDir: string, expected: unknown, status: unknown): Readonly<RunResultDiagnosticOutcomeReading>;
/** Fixed saved diagnostic metadata only. The query selects one field and optional decoded-field UTF-8 byte range. */
export declare function readRunResultDiagnosticsSource(stateDir: string, expected: unknown, query: unknown): Readonly<RunResultDiagnosticsReading>;
export interface RunArtifactInventoryPublication {
    readonly snapshot: () => Readonly<RunArtifactInventoryBinding>;
    readonly readFailure: () => unknown;
}
/** Kernel preparation, before work/result publication. This projects declarations only, never artifact targets. */
export declare function prepareRunArtifactInventoryPublication(stateDir: string, producer: RunResultProducer): Readonly<RunArtifactInventoryPublication>;
export type RunResultArtifactInventoryReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly binding: Readonly<RunArtifactInventoryBinding>;
    readonly terminal_status: "done" | "failed";
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: Extract<RunArtifactInventoryReading, {
        state: "unavailable";
    }>["reason"] | "result_unavailable" | "binding_invalid" | "inventory_unavailable" | "nonterminal_capture";
    readonly artifact_inventory_unavailable?: string;
};
/** Exact natural first-result binding plus retained-source admission; call only for eligible packet members, never ambient checks. */
export declare function readRunResultArtifactInventory(stateDir: string, expected: unknown): Readonly<RunResultArtifactInventoryReading>;
type ArtifactInventoryReference = Readonly<RunArtifactInventoryReference>;
type ArtifactInventorySummary = Readonly<{
    declared: number;
    references_disclosed: number;
    references_withheld: number;
}>;
export interface RunArtifactInventoryDeclaration {
    readonly name: string;
    readonly path: string | null;
    readonly kind?: string;
    readonly media_type?: string;
    readonly required?: boolean;
    readonly availability: "not_observed";
    readonly reason?: "artifact_reference_redacted";
}
export type RunArtifactInventoryReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly inventory: ArtifactInventoryReference;
    readonly capture_scope: "producer_admission";
    readonly contents: "not_read";
    readonly availability: "not_observed";
    readonly production_provenance: "not_asserted";
    readonly summary: ArtifactInventorySummary;
    readonly selection: Readonly<{
        start: number;
        end: number;
    }>;
    readonly artifacts: readonly Readonly<RunArtifactInventoryDeclaration>[];
    readonly artifacts_omitted: number;
    readonly coverage: Readonly<{
        truncated: boolean;
        redacted: true;
    }>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "selection_invalid" | "identity_unavailable" | "identity_mismatch" | "index_unavailable" | "publication_unavailable" | "view_unavailable" | "view_invalid" | "source_unavailable" | "source_invalid" | "range_invalid" | "range_too_large" | "observation_changed";
};
/** Fixed retained-projection policy, not permission inferred from a path/flag. Query is a half-open declaration range, not bytes. */
export declare function readRunArtifactInventorySource(stateDir: string, expected: unknown, query?: unknown): Readonly<RunArtifactInventoryReading>;
/** The original runtime producer is required twice: permission to read/project is not permission to publish after replacement. */
export declare function writeRunControlContextExport(stateDir: string, producer: RunResultProducer): Readonly<RunControlContextExportResult>;
export declare function writeRunRecipeContextExport(stateDir: string, producer: RunResultProducer): Readonly<RunRecipeContextExportResult>;
export declare function writeRunTraceContextExport(stateDir: string, producer: RunResultProducer): Readonly<RunTraceContextExportResult>;
export declare function writeRunResultContextExport(stateDir: string, producer: RunResultProducer): Readonly<RunResultContextExportResult>;
export declare function writeRunArtifactContextExport(stateDir: string, producer: RunResultProducer): Readonly<RunArtifactContextExportResult>;
export declare function writeRunExecutionContextExport(stateDir: string, producer: RunResultProducer): Readonly<RunExecutionContextExportResult>;
/** A separate admitted index commit preserves partial view effects; unavailable sources create metadata, never empty views. */
export declare function writeRunControlContextIndex(stateDir: string, producer: RunResultProducer): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
export declare function writeRunRecipeContextIndex(stateDir: string, producer: RunResultProducer): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
export declare function writeRunTraceContextIndex(stateDir: string, producer: RunResultProducer): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
export declare function writeRunResultContextIndex(stateDir: string, producer: RunResultProducer): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
export declare function writeRunArtifactContextIndex(stateDir: string, producer: RunResultProducer): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
export declare function writeRunExecutionContextIndex(stateDir: string, producer: RunResultProducer): Readonly<RunContextIndexPublication & {
    status: "published";
}>;
interface PrimaryCommandObservation {
    readonly commandId: string;
    readonly attempts: readonly CommandTemplateAttemptReceipt[];
    readonly session: boolean;
}
export interface RunPrimaryTextPublisher {
    readonly observe: (result: object, observation: PrimaryCommandObservation) => void;
    readonly select: (result: object) => void;
    readonly selectResponse: (text: string, upstreamTruncated: boolean) => void;
    readonly snapshot: () => Readonly<RunPrimaryTextBinding>;
    readonly readFailure: () => unknown;
}
export interface RunSnapshotReferences {
    readonly cwd: string | null;
    readonly cwd_unavailable?: "cwd_reference_invalid" | "cwd_reference_redacted";
    readonly context_index: Readonly<{
        identity: Readonly<RunContextIndexIdentity>;
        path: string;
    }> | null;
    readonly context_index_unavailable?: "index_reference_invalid" | "index_reference_redacted" | "index_unavailable";
}
export type RunSnapshotReferencesReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly references: Readonly<RunSnapshotReferences>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "privacy_capture_unavailable" | "references_too_large" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "observation_unavailable";
};
export interface RunSnapshotReferenceReader {
    readonly read: () => Readonly<RunSnapshotReferencesReading>;
}
/** Original same-module reader only; schemas, copied objects/prototypes and flags are not permission. */
export declare function admitRunSnapshotReferenceReader(stateDir: string, expected: unknown, value: unknown): Readonly<RunSnapshotReferenceReader> | undefined;
/** Trusted fresh-launch kernel entry, under its already-held lifecycle lock after full metadata assembly, before publication/work.
 * The caller's actual admission is authority, NOT metadata shape, marker or clock origin as a privacy certificate; not an arbitrary-JS sandbox.
 * No actor/configuration or saved-data route may invoke this issuer. The original runtime-local reader, never its DTO, crosses the handoff.
 */
export declare function captureRunAdmissionSnapshotReferences(stateDir: string, metadata: unknown, origin: unknown): Readonly<RunSnapshotReferenceReader>;
/** Private runtime-local reference permission from genuine admission; not lifecycle/timing/body authority or durable transport. */
export declare function createRunSnapshotReferenceReader(stateDir: string, producer: RunResultProducer): Readonly<RunSnapshotReferenceReader>;
/** Kernel-owned invocation context. Only explicit executor selection publishes command text or its final response. */
export declare function createRunPrimaryTextPublisher(stateDir: string, producer: RunResultProducer): Readonly<RunPrimaryTextPublisher>;
export type RunPrimaryTextReading = {
    readonly state: "available";
    readonly identity: Readonly<RunContextIndexIdentity>;
    readonly result_acceptance: "natural" | "capture_only";
    readonly selection: "recorded_preview" | "byte_range";
    readonly output: Readonly<RunPrimaryTextOutput>;
    readonly original_output?: Readonly<RunPrimaryTextOutput>;
    readonly unchanged: () => boolean;
} | {
    readonly state: "unavailable";
    readonly reason: "selection_invalid" | "identity_unavailable" | "identity_mismatch" | "observation_changed" | "result_unavailable" | "publication_unavailable" | "binding_invalid" | "output_unavailable" | "source_unavailable" | "source_invalid" | "range_invalid" | "range_too_large";
    readonly output_unavailable?: string;
};
/** Saved canonical facts authorize only this published source. No producer, index, raw discovery, refresh, work or ACK. */
export declare function readRunPrimaryTextSource(stateDir: string, expected: unknown, query?: unknown): Readonly<RunPrimaryTextReading>;
/** Fresh completion admission only: select bounded text from the same verified source observation, not another source read. */
export declare function readRunCompletionTextSource(stateDir: string, expected: unknown): Readonly<RunPrimaryTextReading>;
