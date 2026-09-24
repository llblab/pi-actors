/**
 * Public spawn tool behavior
 * Zones: actor launch, draft recipe capture, launch diagnostics
 * Owns the public spawn execution path for run-backed actors
 */
import * as ModelContext from "./model-context.ts";
import type * as RecipeResolution from "./recipes-context.ts";
export interface SpawnToolContext extends ModelContext.CurrentModelContext {
    recipeResolutionContext?: RecipeResolution.RecipeResolutionContext;
    cwd: string;
    sessionManager?: {
        getSessionId?: () => string;
    };
}
export declare function createSpawnToolDefinition<TContext extends SpawnToolContext>(): any;
