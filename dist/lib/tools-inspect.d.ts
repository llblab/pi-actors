/**
 * Public inspect tool behavior.
 * Zones: Run Recipe/Trace/Control views and runtime/recipe/tool diagnostics
 * Owns exact inspect target/view dispatch; source projection stays in domain modules.
 */
import * as Runtime from "./runtime.ts";
export interface InspectToolDeps<TContext = unknown> {
    getRunStatus?: (runOrDir: string) => Record<string, any>;
    getTool?: (name: string) => any | undefined;
    getToolStatus?: (name: string) => Record<string, unknown> | undefined;
    listRuns?: () => Array<Record<string, any>>;
    recipeRoot?: string;
    registryStatus?: () => Runtime.RecipeRegistryStatus;
}
export declare function createInspectToolDefinition<TContext = unknown>(deps?: InspectToolDeps<TContext>): any;
