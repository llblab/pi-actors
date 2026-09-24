/**
 * Automatic active-tool portfolio review admission.
 * Zones: revision eligibility, immutable thirty-six-tool capture, persisted review state
 * Owns exact portfolio admission; reviewer execution and recipe mutation remain separate domains.
 */
import { type ToolReviewTool } from "./tool-review.ts";
export declare const TOOL_REVIEW_RESULT_MAX_BYTES: number;
export interface ToolReviewBatch {
    inputPath: string;
    reviewerInputPath: string;
    reviewId: string;
    toolNames: string[];
}
export interface ToolReviewAdmissionState {
    approvedPath?: string;
    attempts: number;
    failedStage?: string;
    lastError?: string;
    lineageJournalPath?: string;
    inputPath: string;
    nextAction?: string;
    phase: "approved" | "captured" | "completed" | "failed" | "launched" | "lineage_pending" | "processing_failed";
    processingAttempts?: number;
    reviewerInputPath: string;
    reviewId: string;
    runId?: string;
    toolNames: string[];
    transactionEvidencePath?: string;
    updatedAt: string;
}
export interface ToolReviewSchedulerDeps extends CaptureToolReviewOptions {
    delayMs?: number;
    hasActiveActors(): boolean;
    launch(batch: ToolReviewBatch): {
        run: string;
    };
    process?(state: ToolReviewAdmissionState): ToolReviewProcessResult;
}
export interface ToolReviewProcessResult {
    approvedPath?: string;
    error?: string;
    outcome: "approved" | "pending" | "processing_failed" | "review_failed";
    stage?: string;
}
export interface ToolReviewScheduler {
    close(): void;
    schedule(): void;
}
export interface CaptureToolReviewOptions {
    batchRoot?(reviewId: string): string;
    createReviewId?(): string;
    now?(): Date;
    recipeRoot?: string;
    statePath?: string;
}
export declare function listEligibleToolReviewRecipes(recipeRoot?: string, now?: Date): ToolReviewTool[];
export declare function captureToolReviewBatch(options?: CaptureToolReviewOptions): ToolReviewBatch | undefined;
export interface ProcessToolReviewDeps {
    draftRoot?: string;
    getRunStatus(runId: string): Record<string, unknown>;
    now?(): Date;
    recipeRoot?: string;
}
export declare function processToolReviewResult(state: ToolReviewAdmissionState, deps: ProcessToolReviewDeps): ToolReviewProcessResult;
export interface ToolReviewBoundaryResult {
    outcome: "completed" | "lineage_pending" | "none" | "processing_failed";
    state?: ToolReviewAdmissionState;
}
export declare function applyApprovedToolReviewAtSessionBoundary(options?: {
    lifecycleHooks?: {
        onCompleted?(): void;
        onLineagePending?(): void;
        onStateLocked?(): void;
    };
    now?(): Date;
    recipeRoot?: string;
    statePath?: string;
}): ToolReviewBoundaryResult;
export declare function createToolReviewScheduler(deps: ToolReviewSchedulerDeps): ToolReviewScheduler;
export declare function toolReviewRunId(reviewId: string): string;
