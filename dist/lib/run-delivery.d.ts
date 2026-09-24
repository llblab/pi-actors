/**
 * Coordinator delivery persistence.
 * Zones: owner-scoped completion batches, delivery phase fencing, bounded receipts
 * Owns durable delivery state; excludes Run discovery, Pi scheduling, and model formatting.
 */
export type RunCompletionDeliveryStatus = "done" | "failed" | "killed" | "exited";
export type RunDeliveryPhase = "pending" | "queued" | "presented";
export interface RunCompletionBatchMember {
    artifacts?: Record<string, string>;
    parent_run?: string;
    parent_run_instance_id?: string;
    parent_state_dir?: string;
    output?: string;
    run: string;
    run_instance_id: string;
    state_dir: string;
    status: RunCompletionDeliveryStatus;
    summary: string;
    terminal_at: string;
}
export interface RunCompletionBatch {
    attempts?: number;
    batch_id: string;
    created_at: string;
    last_error?: string;
    last_failed_at?: string;
    members: RunCompletionBatchMember[];
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
export interface RunDeliveryJournal {
    completion_batch?: RunCompletionBatch;
    owner_id: string;
    receipts: RunDeliveryReceipt[];
    schema: "run-delivery-v1";
    steers: RunSteerEnvelope[];
}
export interface AdmitRunCompletionBatchInput {
    batchId?: string;
    members: RunCompletionBatchMember[];
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
export declare function getRunDeliveryJournalPath(tempDir: string, ownerId: string): string;
export declare function readRunDeliveryJournal(tempDir: string, ownerId: string): RunDeliveryJournal;
export declare function admitRunCompletionBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch;
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
/** Format one immutable batch for a model-bound custom message. */
export declare function formatRunCompletionBatchMessage(batch: RunCompletionBatch): string;
