/**
 * Coordinator delivery persistence.
 * Zones: owner-scoped completion streams/batches, delivery phase fencing, bounded receipts
 * Owns atomic stream allocations, immutable member snapshots and bounded projections; excludes logical-session admission, Run discovery, primary authorization and Pi scheduling.
 */
import { type RunDirectoryNavigation } from "./runs-index.ts";
import { type RunCompletionText, type RunResultDiagnosticsReference, type RunResultDiagnosticPacketExcerpt, type RunPrimaryTextBinding, type RunArtifactInventoryReference } from "./runs-outcomes.ts";
export type RunCompletionDeliveryStatus = "done" | "failed" | "killed" | "exited";
export type RunDeliveryPhase = "pending" | "queued" | "presented";
export type RunCompletionIndexRange = Readonly<{
    state: "available";
    indices: readonly number[];
    next_index: number;
}> | Readonly<{
    state: "unavailable";
    reason: "range_unavailable";
    next_index: number;
}>;
export type RunCompletionNumbering = Readonly<{
    kind: "stream";
    session_id: string;
    stream_id: string;
    first_index: number;
    member_order: readonly number[];
}> | Readonly<{
    kind: "unavailable";
    session_id: string;
    stream_id?: string;
    reason: "counter_unavailable" | "range_unavailable" | "stream_state_unavailable";
    member_order: readonly number[];
}>;
export interface RunCompletionBatchMember {
    artifacts?: Record<string, string>;
    artifact_inventory?: Readonly<RunArtifactInventoryReference> | null;
    artifact_inventory_unavailable?: string;
    result_diagnostics?: Readonly<RunResultDiagnosticsReference> | null;
    result_diagnostics_unavailable?: string;
    diagnostic_excerpt?: RunResultDiagnosticPacketExcerpt;
    parent_run?: string;
    parent_run_instance_id?: string;
    parent_state_dir?: string;
    output?: string;
    primary_text?: Readonly<RunPrimaryTextBinding>;
    completion_text?: Readonly<RunCompletionText>;
    run: string;
    run_instance_id: string;
    state_dir: string;
    status: RunCompletionDeliveryStatus;
    summary: string;
    terminal_at: string;
}
export interface RunCompletionInventorySource {
    readonly path: string;
    readonly sha256: string;
    readonly bytes_total: number;
    readonly members_total: number;
}
export interface RunCompletionFileNavigation {
    readonly member_index: number;
    readonly locations: Readonly<RunDirectoryNavigation>;
}
export interface RunCompletionBatch {
    attempts?: number;
    /** AX capture marker; numbered spellings/absence are retained codecs, never new-capture choices. */
    readonly presentation_format?: "ax_records" | "ax_records_v1" | "ax_records_v2" | "ax_records_v3";
    /** Retained singleton capture; absence preserves older indexed bytes. Never a new-capture selector. */
    readonly single_result?: true;
    /** Captured record-list shape; no public format/version choice or source authority. */
    readonly result_layout?: "records" | "run_headers" | "headings" | "headings_flat_omissions" | "headings_outcomes" | "headings_shared_results" | "headings_shared_kinds" | "frontmatter_v1" | "frontmatter_v2" | "completion_yaml_core_v1";
    /** Immutable scope/order/range data, not a caller-selected format or allocation authority. */
    readonly numbering?: RunCompletionNumbering;
    /** Formatting version/data only; no recipient ownership, read or publication capability. */
    readonly navigation_handoff?: "current_session_request" | "captured_file_locations";
    /** Formatting only; omission counts remain the already-admitted source facts. */
    readonly excerpt_format?: "bracketed_omissions_v1";
    readonly file_navigation?: readonly Readonly<RunCompletionFileNavigation>[];
    readonly text_budget?: number;
    readonly inventory_source?: Readonly<RunCompletionInventorySource>;
    batch_id: string;
    created_at: string;
    last_error?: string;
    last_failed_at?: string;
    members: readonly RunCompletionBatchMember[];
    phase: RunDeliveryPhase;
    presented_at?: string;
    queued_at?: string;
}
export interface RunSteerEnvelope {
    attempts?: number;
    content: string;
    created_at: string;
    event_id: string;
    kind: string;
    last_error?: string;
    last_failed_at?: string;
    level: "info" | "warning" | "error";
    occurred_at: string;
    phase: RunDeliveryPhase;
    presented_at?: string;
    queued_at?: string;
    run: string;
    run_instance_id: string;
    state_dir: string;
    steer_id: string;
}
export interface RunDeliveryReceipt {
    delivery_id: string;
    kind: "completion_batch" | "urgent_steer";
    presented_at: string;
}
/** A requested fresh target only; requesting it does not activate a stream. */
export interface RunCompletionStreamIntent {
    readonly pending_stream_id: string;
}
export type RunCompletionStreamCounter = Readonly<{
    state: "available";
    next_index: number;
}> | Readonly<{
    state: "unavailable";
}>;
export interface RunCompletionStreamActive {
    readonly stream_id: string;
    readonly counter: RunCompletionStreamCounter;
}
export type RunCompletionStreamState = Readonly<RunCompletionStreamIntent & {
    active?: never;
}> | Readonly<{
    active: Readonly<RunCompletionStreamActive>;
    pending_stream_id?: string;
}>;
export type RunCompletionStreamStatus = Readonly<{
    state: "unavailable";
    reason: "stream_state_unavailable";
}> | Readonly<{
    state: "pending";
    session_id: string;
    pending_stream_id: string;
    active?: Readonly<RunCompletionStreamActive>;
    blocking_batch_id?: string;
}> | Readonly<{
    state: "active";
    session_id: string;
    active: Readonly<RunCompletionStreamActive>;
    blocking_batch_id?: string;
}>;
export interface RunDeliveryJournal {
    completion_stream?: RunCompletionStreamState;
    completion_batch?: RunCompletionBatch;
    owner_id: string;
    receipts: RunDeliveryReceipt[];
    schema: "run-delivery-v1";
    steers: RunSteerEnvelope[];
}
export interface AdmitRunCompletionBatchInput {
    batchId?: string;
    fileNavigation?: readonly Readonly<RunCompletionFileNavigation>[];
    members: readonly RunCompletionBatchMember[];
    now?: Date;
    ownerId: string;
    tempDir: string;
}
export interface RunDeliveryTransitionInput {
    batchId: string;
    now?: Date;
    ownerId: string;
    tempDir: string;
}
export interface AdmitRunSteerEnvelopeInput {
    content: string;
    eventId: string;
    kind: string;
    level: "info" | "warning" | "error";
    now?: Date;
    occurredAt: string;
    ownerId: string;
    run: string;
    runInstanceId: string;
    stateDir: string;
    steerId?: string;
    tempDir: string;
}
export interface RunSteerTransitionInput {
    now?: Date;
    ownerId: string;
    steerId: string;
    tempDir: string;
}
/** Pure whole-capture arithmetic, not a reservation; commit with the packet under its owner lock. */
export declare function projectRunCompletionIndexRange(nextIndex: number, memberCount: number): RunCompletionIndexRange;
export declare function getRunDeliveryJournalPath(tempDir: string, ownerId: string): string;
export declare function readRunDeliveryJournal(tempDir: string, ownerId: string): RunDeliveryJournal;
/** Read-only persisted facts, not proof of non-connection or current SDK ownership. */
export declare function readRunCompletionStreamStatus(tempDir: string, ownerId: string): RunCompletionStreamStatus;
/** Kernel-only explicit request; fresh-session bootstrap and public command admission remain separate. */
export declare function requestRunCompletionStream(input: {
    tempDir: string;
    ownerId: string;
}): Readonly<RunCompletionStreamIntent>;
export declare function admitRunCompletionBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch;
/** Kernel-only opt-in; ordinary Pi capture stays fenced until session/lifecycle integration is admitted. */
export declare function captureRunCompletionStreamBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch;
/** Private ordinary candidate composition; stream capture retains its separately gated codec. */
export declare function captureRunCompletionYamlCandidateBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch;
export declare function markRunCompletionBatchQueued(input: RunDeliveryTransitionInput): boolean;
export declare function resetRunCompletionBatchPending(input: Omit<RunDeliveryTransitionInput, "now">): boolean;
export declare function recordRunCompletionBatchDeliveryFailure(input: RunDeliveryTransitionInput & {
    error: unknown;
}): boolean;
export declare function markRunCompletionBatchPresented(input: RunDeliveryTransitionInput): boolean;
export declare function finalizeRunCompletionBatch(input: Omit<RunDeliveryTransitionInput, "now">): boolean;
export declare function getRunSteerDeliveryId(input: {
    eventId: string;
    runInstanceId: string;
    stateDir: string;
}): string;
export declare function admitRunSteerEnvelope(input: AdmitRunSteerEnvelopeInput): RunSteerEnvelope | undefined;
export declare function markRunSteerQueued(input: RunSteerTransitionInput): boolean;
export declare function resetRunSteerPending(input: Omit<RunSteerTransitionInput, "now">): boolean;
export declare function recordRunSteerDeliveryFailure(input: RunSteerTransitionInput & {
    error: unknown;
}): boolean;
export declare function markRunSteerPresented(input: RunSteerTransitionInput): boolean;
export declare function finalizeRunSteer(input: Omit<RunSteerTransitionInput, "now">): boolean;
/** Captured membership ordering only; never native lineage or a complete descendant tree. */
export declare function orderRunCompletionMembers(members: readonly RunCompletionBatchMember[], prioritizeFailed?: boolean): RunCompletionBatchMember[];
export interface RunCompletionPresentation {
    readonly format: "ax_records" | "ax_records_v3" | "completion_frontmatter_v1";
    readonly blocks?: readonly CompletionBlock[];
    readonly content_sha256: string;
    /** UTF-16 offsets in the exact content, not UTF-8 byte or source excerpt ranges. */
    readonly compact_ranges: readonly (readonly [number, number])[];
}
/** Compiler-bound correlation data, not authentication or permission. Body equality cannot identify an epoch. */
export declare function readRunCompletionRecordMarker(content: string): {
    batchId: string;
    start: number;
    single: boolean;
    headers?: true;
} | undefined;
export type CompletionBlock = readonly [kind: "header" | "body" | "marker" | "service", start: number, end: number];
type CompletionYamlProjectionReason = "invalid_snapshot" | "unsupported_source_class" | "unsupported_selected_data" | "overbudget" | "compatibility_refused";
/** Nondefault pure projection; neither a newly admitted Batch nor a rendering/acceptance grant. */
export declare function projectRunCompletionYamlPrototype(batch: unknown): {
    state: "available";
    content: string;
    presentation: {
        format: "completion_yaml_core_v1";
        content_sha256: string;
    };
    membersShown: number;
    textBudget: number;
} | {
    state: "unavailable";
    reason: CompletionYamlProjectionReason;
};
/** Single full model content plus compiler-owned UI offsets; no source reads or saved-packet mutation. */
export declare function projectRunCompletionBatchPresentation(batch: RunCompletionBatch): {
    content: string;
    presentation?: RunCompletionPresentation | {
        format: "completion_yaml_core_v1";
        content_sha256: string;
    };
};
export interface RunCompletionPresentationView {
    text: string;
    compact: boolean;
    single?: true;
    records?: true;
    blocks?: readonly CompletionBlock[];
    yaml?: true;
    segments?: readonly Readonly<{
        kind: "header" | "body" | "marker" | "service" | "separator";
        text: string;
    }>[];
}
/** Invalid/missing hints reveal all content; old captures keep their existing host renderer. */
export declare function readRunCompletionPresentation(content: string, value: unknown): RunCompletionPresentationView | undefined;
/** Format one immutable batch for a model-bound custom message, without source reads or phase changes. */
export declare function formatRunCompletionBatchMessage(batch: RunCompletionBatch): string;
export type CompletionYamlData = null | boolean | number | string | CompletionYamlData[] | {
    [key: string]: CompletionYamlData;
};
export type CompletionYamlPart = {
    body: string;
} | {
    marker: string;
};
export interface CompletionYamlPacket {
    batchId: string;
    records: {
        metadata: Record<string, CompletionYamlData>;
        parts: CompletionYamlPart[];
    }[];
    service?: Record<string, CompletionYamlData>;
}
export interface CompletionYamlBlock {
    kind: "header" | "body" | "marker" | "separator";
    start: number;
    end: number;
    record: number;
    part?: number;
}
type CompletionYamlUnavailable = {
    state: "unavailable";
};
/**
 * Unadmitted data-only prototype, not source/privacy/identity/acceptance authority.
 * Grammar: canonical YAML headers, no physical blank lines. Bare headers end LF;
 * another record adds LF. Body headers are --- LF / YAML / --- LF then raw parts;
 * another record adds LF LF, independently of authored trailing CR/LF. Parts are
 * ordered single-key body/marker UTF-16 lengths, never offsets. Only the first
 * _completion carries codec/batch_id/service. Absent body is DTO parts:[] (no
 * wire parts); selected empty body is body:0 and has a closed header. Zero rows
 * is one bare service-only header requiring nonempty selected service facts.
 * No clipping, fair fitting, source reads, admission or production callers.
 */
export declare function encodeCompletionYamlCarrier(input: unknown): {
    state: "available";
    text: string;
} | CompletionYamlUnavailable;
/** Strict whole-carrier decoder. Derived ranges are consistency data, never authenticity. */
export declare function readCompletionYamlCarrier(input: unknown): {
    state: "available";
    packet: CompletionYamlPacket;
    blocks: CompletionYamlBlock[];
} | CompletionYamlUnavailable;
export {};
