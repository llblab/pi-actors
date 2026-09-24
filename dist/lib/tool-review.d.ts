/**
 * Automatic active-tool portfolio review contract.
 * Zones: thirty-six-tool reviewer input, evolution decisions, mechanical contract gates
 * Owns strict read-only keep/evolve/replace/demote/merge/split review semantics.
 */
export declare const TOOL_REVIEW_THRESHOLD = 36;
export interface ToolReviewAssessment {
    adaptability: number;
    futureUsefulness: number;
    lifetimeCalls: number;
    redundancy: number;
    revisionCalls: number;
    safety: string;
}
export interface ToolReviewTool {
    name: string;
    path: string;
    recipe: Record<string, unknown>;
    riskLabels: string[];
    sha256: string;
    usage?: Record<string, unknown>;
    valid: boolean;
}
export interface ToolReviewInput {
    createdAt: string;
    reviewId: string;
    tools: ToolReviewTool[];
}
export interface ToolReviewOutputRecipe {
    name: string;
    recipe: Record<string, unknown>;
}
export type ToolReviewAction = "demote" | "evolve" | "keep" | "merge" | "replace" | "split";
export interface ToolReviewDecision {
    action: ToolReviewAction;
    assessment: ToolReviewAssessment;
    rationale: string;
    recipe?: Record<string, unknown>;
    sha256: string;
    source: string;
    target?: string;
    outputs?: ToolReviewOutputRecipe[];
}
export interface ToolReviewResult {
    createdAt: string;
    decisions: ToolReviewDecision[];
    reviewId: string;
}
export interface ToolReviewValidation {
    errors: string[];
    ok: boolean;
}
export declare function validateToolReviewInput(input: ToolReviewInput): ToolReviewValidation;
export declare function validateToolReviewResult(input: ToolReviewInput, result: ToolReviewResult): ToolReviewValidation;
export declare function parseToolReviewResult(stdout: string): ToolReviewResult;
export declare function createToolReviewPrompt(inputPath: string): string;
