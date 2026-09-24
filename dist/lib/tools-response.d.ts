/**
 * Public tool response formatting
 * Zones: compact text summaries, verbose JSON switching, next-action rendering
 * Owns model-facing response helpers shared by public tool execution paths
 */
export declare function withLeadingLineBreak(text: string): string;
export declare function spaceToolResult<T>(result: T): T;
export declare function spaceToolError(error: unknown): unknown;
export declare function asRecord(value: unknown): Record<string, unknown>;
export declare function jsonText(value: unknown): string;
export declare function compactPreview(value: unknown, maxLength?: number): string | undefined;
export declare function compactNextActions(actions: string[]): string;
export declare function runNextActions(run: unknown): string[];
export declare function compactAsyncRunStatus(value: unknown): string;
export declare function maybeJsonText(value: unknown, verbose: boolean | undefined, compact: string): string;
export declare function compactRecipeImports(summary: Record<string, unknown>): string;
export declare function compactRecipeDoctor(summary: Record<string, unknown>): string;
export declare function recipeRegistryNextActions(summary: Record<string, unknown>, view: string): string[];
export declare function compactRecipeRegistry(summary: Record<string, unknown>): string;
export declare const DEFAULT_INSPECT_LINES = 40;
