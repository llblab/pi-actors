/**
 * Automatic recipe-review operator control.
 * Owns: explicit retry/reset transitions over durable draft/tool admission state.
 */
export type AutomaticReviewScope = "draft" | "tool";
export type AutomaticReviewControlAction = "review.reset" | "review.retry";
export interface AutomaticReviewControlOptions {
    draftStatePath?: string;
    scheduleDraft?(): void;
    scheduleTool?(): void;
    toolStatePath?: string;
}
export declare function controlAutomaticReview(action: AutomaticReviewControlAction, scope: AutomaticReviewScope, options?: AutomaticReviewControlOptions): Record<string, unknown>;
export declare function parseAutomaticReviewScope(input: unknown): AutomaticReviewScope;
