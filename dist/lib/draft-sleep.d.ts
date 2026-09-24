/**
 * Automatic draft-sleep scheduling.
 * Zones: twelve-draft trigger, immutable batch capture, silent post-turn launch
 * Owns non-blocking review admission and persisted launch evidence, not reviewer decisions or mutation.
 */
import type { DraftReviewActiveTool } from "./draft-review.ts";
export declare const DRAFT_SLEEP_THRESHOLD = 12;
export interface DraftSleepBatch {
    batchId: string;
    inputPath: string;
    reviewerInputPath: string;
    sourcePaths: string[];
}
export interface DraftSleepState {
    attempts: number;
    batchId: string;
    inputPath: string;
    evidencePath?: string;
    failedStage?: string;
    lastError?: string;
    nextAction?: string;
    phase: "captured" | "completed" | "failed" | "launched" | "processing_failed";
    processingAttempts?: number;
    reviewerInputPath: string;
    runId?: string;
    sourcePaths: string[];
    updatedAt: string;
}
export interface DraftSleepProcessResult {
    cleanup?(): void;
    error?: string;
    evidencePath?: string;
    outcome: "completed" | "pending" | "processing_failed" | "review_failed";
    stage?: string;
}
export interface DraftSleepSchedulerDeps {
    activeTools?(): DraftReviewActiveTool[];
    batchRoot?(batchId: string): string;
    createBatchId?(): string;
    delayMs?: number;
    draftRoot?: string;
    hasActiveActors(): boolean;
    launch(batch: DraftSleepBatch): {
        run: string;
    };
    now?(): Date;
    process?(state: DraftSleepState): DraftSleepProcessResult;
    recipeRoot?: string;
    statePath?: string;
}
export interface DraftSleepScheduler {
    close(): void;
    schedule(): void;
}
type DraftSleepCaptureOptions = Pick<DraftSleepSchedulerDeps, "activeTools" | "batchRoot" | "createBatchId" | "draftRoot" | "now" | "recipeRoot" | "statePath">;
export declare function captureDraftSleepBatch(options?: DraftSleepCaptureOptions): DraftSleepBatch | undefined;
export interface ProcessDraftSleepReviewDeps {
    getRunStatus(runId: string): Record<string, unknown>;
    now?(): Date;
    recipeRoot?: string;
}
export declare function processDraftSleepReview(state: DraftSleepState, deps: ProcessDraftSleepReviewDeps): DraftSleepProcessResult;
export declare function createDraftSleepScheduler(deps: DraftSleepSchedulerDeps): DraftSleepScheduler;
export declare function draftSleepRunId(batchId: string): string;
export {};
