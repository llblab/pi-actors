/**
 * Registry mutation use-cases
 * Zones: registry mutations, persistence, runtime activation
 * Owns register/update/delete validation, persistence, runtime side effects, and result payloads
 */
import * as CommandTemplates from "./command-templates.ts";
import * as Config from "./config.ts";
import * as RecipesContext from "./recipes-context.ts";
export interface RegisterToolInput {
    name?: string;
    description?: string;
    async?: boolean;
    template?: CommandTemplates.CommandTemplateValue | null;
    from?: string;
    defaults?: Record<string, unknown>;
    draft?: string;
    args?: string;
    update?: boolean;
}
export interface RegisterToolResultDetails {
    active_tool?: boolean;
    activation?: "current_session" | "unverified";
    activation_boundary?: string;
    args?: string[];
    async?: boolean;
    callable_now?: boolean;
    defaults?: Record<string, string>;
    host_registered?: boolean;
    next_actions?: string[];
    optional_args?: string[];
    persisted?: boolean;
    promoted?: boolean;
    registry_active?: boolean;
    required_args?: string[];
    resolved?: boolean;
    source?: string;
    templateWarnings?: string[];
    tool: string;
    validated?: boolean;
}
export interface RegisterToolResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: RegisterToolResultDetails;
}
interface RuntimeActivation {
    active_tool: boolean;
    activation: "current_session" | "unverified";
    callable_now: boolean;
    host_registered: boolean;
}
export interface RegisterToolRuntimeDeps<TContext> {
    configPath: string;
    recipeRoot?: string;
    getToolNameBlocker: (name: string) => string | undefined;
    getTools: () => Map<string, Config.RegisteredTool>;
    getRecipeResolutionContext?: () => RecipesContext.RecipeResolutionContext | undefined;
    getActiveTools: () => string[];
    notify: (ctx: TContext, message: string, type: "info" | "warning" | "error") => void;
    registerRuntimeTool: (cfg: Config.RegisteredTool) => RuntimeActivation | void;
    reservedToolNames: Set<string>;
    setActiveTools: (toolNames: string[]) => void;
}
export declare function executeRegisterTool<TContext>(params: unknown, ctx: TContext, deps: RegisterToolRuntimeDeps<TContext>): Promise<RegisterToolResult>;
export {};
