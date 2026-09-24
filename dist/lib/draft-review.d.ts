/**
 * Automatic draft-review contract.
 * Zones: read-only reviewer input, decision schema, mechanical promotion gates
 * Owns strict batch review validation without mutating recipes or registry state.
 */
export interface DraftReviewAssessment {
    flexibility: number;
    futureUsefulness: number;
    launches: number;
    safety: string;
    universality: number;
}
export interface DraftReviewDraft {
    diagnostics?: unknown;
    path: string;
    recipe?: Record<string, unknown>;
    riskLabels: string[];
    sha256: string;
    usage?: Record<string, unknown>;
    valid: boolean;
}
export interface DraftReviewActiveTool {
    name: string;
    path: string;
    sha256: string;
}
export interface DraftReviewInput {
    activeTools: DraftReviewActiveTool[];
    batchId: string;
    createdAt: string;
    drafts: DraftReviewDraft[];
}
export interface DraftReviewDecision {
    action: "discard" | "promote";
    assessment: DraftReviewAssessment;
    draft: string;
    rationale: string;
    recipe?: Record<string, unknown>;
    sha256: string;
    target?: string;
    targetSha256?: null;
}
export interface DraftReviewResult {
    batchId: string;
    createdAt: string;
    decisions: DraftReviewDecision[];
}
export interface DraftReviewValidation {
    errors: string[];
    ok: boolean;
}
export declare function findUnsafeRecipeReason(value: unknown, key?: string): string | undefined;
export declare function validateDraftReviewInput(input: DraftReviewInput): DraftReviewValidation;
export declare function validateDraftReviewResult(input: DraftReviewInput, result: DraftReviewResult): DraftReviewValidation;
export declare function parseDraftReviewResult(stdout: string): DraftReviewResult;
export declare function createDraftReviewPrompt(inputPath: string): string;
