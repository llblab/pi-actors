/**
 * Recipe usage and name-based lineage metadata.
 * Zones: recipe lineage, launch telemetry, revision history, migration
 * Owns priority-compatible recipe names and lifetime/revision counters for user recipes.
 */
export type RecipeLaunchKind = "direct" | "spawn" | "tool";
export declare function getRecipeUsageIndexPath(recipeRoot: string): string;
export declare function getRecipeUsageLedgerPath(lineageName: string, recipeRoot: string): string;
export declare const RECIPE_REVISION_SNAPSHOT_LIMIT = 32;
export declare function getRecipeRevisionSnapshotPath(lineageName: string, revision: number, recipeRoot: string): string;
export declare function readRecipeUsage(path: string, recipeRoot?: string): Record<string, unknown> | undefined;
export declare function ensureRecipeLineage(path: string, now?: Date, recipeRoot?: string): boolean;
export declare function isCurrentRecipeRevisionReviewed(path: string, recipeRoot?: string): boolean;
export interface RecipeLaunchRecordOptions {
    onMutationLockContention?(): void;
}
export declare function recordRecipeLaunch(path: string, now?: Date, kind?: RecipeLaunchKind, recipeRoot?: string, options?: RecipeLaunchRecordOptions): boolean;
export declare function recordRecipeReview(path: string, reviewEpoch: string, now?: Date, recipeRoot?: string): boolean;
export declare function recordRecipeRollback(path: string, rollbackRevision: number, now?: Date, recipeRoot?: string): boolean;
export declare function retireRecipeUsage(path: string, recipeRoot?: string): boolean;
export declare function moveRecipeUsage(fromPath: string, toPath: string, recipeRoot?: string): boolean;
