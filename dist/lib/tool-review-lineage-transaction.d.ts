/**
 * Journaled tool-review lineage finalization.
 * Zones: lineage projection persistence, ledger/index CAS, crash roll-forward
 * Owns idempotent ledger mutation after portfolio filesystem commit; admission-state activation and quarantine cleanup remain separate.
 */
export interface ToolReviewLineageTransactionResult {
    journalPath: string;
    phase: "committed";
}
export interface ToolReviewLineageTransactionOptions {
    checkpoint?(checkpoint: "ledger_written" | "prepared"): void;
    now?(): Date;
    recipeRoot: string;
}
export declare function finalizeToolReviewLineage(approvedPath: string, options: ToolReviewLineageTransactionOptions): ToolReviewLineageTransactionResult;
export interface ToolReviewRevisionRollbackResult {
    journalPath: string;
    lineageName: string;
    restoredRevision: number;
    targetPath: string;
}
export interface ToolReviewRevisionRollbackOptions {
    checkpoint?(checkpoint: "ledger_written" | "prepared" | "recipe_written"): void;
    now?(): Date;
    recipeRoot: string;
}
export declare function rollbackToolRecipeRevision(lineageName: string, revision: number, options: ToolReviewRevisionRollbackOptions): ToolReviewRevisionRollbackResult;
