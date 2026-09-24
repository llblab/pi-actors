/**
 * Recipe Control contract.
 * Zones: actor-local action declarations, normalization, reserved-action fencing
 * Owns pure Recipe control validation; Recipe loading and Run capture stay in recipe/run domains.
 */
export declare function normalizeRecipeControl(value: unknown): string[] | undefined;
export declare function assertRecipeHasNoMailbox(recipe: Record<string, unknown>): void;
