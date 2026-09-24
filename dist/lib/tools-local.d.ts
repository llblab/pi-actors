/**
 * Local tool definition behavior
 * Zones: user recipe tools, generated schemas, async recipe launch
 * Owns wrapping saved local capabilities as executable pi tools
 */
import * as ModelContext from "./model-context.ts";
import type { RegisteredTool } from "./config.ts";
import * as Execution from "./execution.ts";
import type * as RecipeResolution from "./recipes-context.ts";
export interface RuntimeToolContext extends ModelContext.CurrentModelContext {
    recipeResolutionContext?: RecipeResolution.RecipeResolutionContext;
    cwd: string;
    sessionManager?: {
        getSessionId?: () => string;
    };
}
export declare function createRuntimeToolDefinition(cfg: RegisteredTool, exec: Execution.RegisteredToolExec): any;
