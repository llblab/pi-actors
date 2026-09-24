/**
 * Automatic recipe-review confidentiality projection.
 * Owns: value-free model inputs derived from trusted immutable draft/tool captures.
 */
import type { DraftReviewInput, DraftReviewResult } from "./draft-review.ts";
import type { ToolReviewInput, ToolReviewResult } from "./tool-review.ts";
export declare const draftReviewIdentity: (index: number) => string;
export declare const toolReviewIdentity: (index: number) => string;
export declare function draftReviewRevision(input: DraftReviewInput, index: number): string;
export declare function toolReviewRevision(input: ToolReviewInput, index: number): string;
export declare function projectDraftReviewInput(input: DraftReviewInput): Record<string, unknown>;
export declare function restoreDraftReviewResult(input: DraftReviewInput, result: DraftReviewResult): DraftReviewResult;
export declare function projectToolReviewInput(input: ToolReviewInput): Record<string, unknown>;
export declare function restoreToolReviewResult(input: ToolReviewInput, result: ToolReviewResult): ToolReviewResult;
