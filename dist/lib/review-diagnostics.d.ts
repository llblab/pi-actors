/**
 * Automatic recipe-review diagnostics.
 * Zones: bounded draft/tool cycle evidence, lineage summaries, revision snapshot inventory
 * Owns read-only diagnostic projection; schedulers and transactions own mutation.
 */
export interface AutomaticReviewDiagnosticOptions {
    draftStatePath?: string;
    recipeRoot?: string;
    toolStatePath?: string;
}
export declare function readAutomaticReviewDiagnostics(options?: AutomaticReviewDiagnosticOptions): Record<string, unknown>;
