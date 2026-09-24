/**
 * Review preflight diagnostics
 * Zones: recipe diagnostics, subagent launch policy
 * Owns compact classification of failed review-pipeline preflight commands.
 */
export type ReviewPreflightErrorClass = "auth_or_key" | "model_unavailable" | "quota_or_balance" | "rate_limited" | "timeout" | "transport" | "unknown_provider_failure";
export interface ReviewPreflightDiagnosticInput {
    args: readonly string[];
    code?: number;
    killed?: boolean;
    promptFile?: string;
    promptText?: string;
    stderr?: string;
    stdout?: string;
}
export interface ReviewPreflightDiagnostic {
    errorClass: ReviewPreflightErrorClass;
    model?: string;
    promptFile?: string;
    stage: string;
    suggestedOverrideArgs: string;
    thinking?: string;
}
export declare function extractReviewPreflightStage(promptText: string | undefined): string | undefined;
export declare function classifyReviewPreflightError(text: string, killed?: boolean): ReviewPreflightErrorClass;
export declare function buildReviewPreflightDiagnostic(input: ReviewPreflightDiagnosticInput): ReviewPreflightDiagnostic | undefined;
export declare function formatReviewPreflightDiagnostic(diagnostic: ReviewPreflightDiagnostic): string;
