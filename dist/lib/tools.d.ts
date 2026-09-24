/**
 * Public tool family composition
 * Zones: tool set, reserved tool names, pi-facing tool wiring
 * Owns public tool-family composition without owning individual tool behavior
 */
import type { RuntimeToolContext } from "./tools-local.ts";
import * as ToolsRegister from "./tools-register.ts";
export type RegisterToolRuntimeDeps<TContext> = ToolsRegister.RegisterToolRuntimeDeps<TContext>;
export interface ActorToolDefinition {
    name: string;
    execute?: (...args: never[]) => unknown;
    [key: string]: unknown;
}
export interface CoreActorToolDefinitionDeps<TContext extends RuntimeToolContext> {
    configPath: string;
    getActiveTools: () => string[];
    getRecipeResolutionContext: () => import("./recipes-context.ts").RecipeResolutionContext | undefined;
    getRuntimeTool: (name: string) => unknown;
    getRuntimeToolStatus: (name: string) => Record<string, unknown> | undefined;
    handleRuntimeControl?: (action: string, input: unknown) => Record<string, unknown>;
    registryRuntime: Pick<RegisterToolRuntimeDeps<TContext>, "getToolNameBlocker" | "getTools" | "notify" | "registerRuntimeTool"> & {
        getStatus(): import("./runtime.ts").RecipeRegistryStatus;
    };
    setActiveTools: (toolNames: string[]) => void;
}
export declare function resolveActiveRuntimeTool(name: string, activeTools: Pick<Map<string, unknown>, "has">, getDefinition: (name: string) => unknown): unknown;
export declare const RESERVED_TOOL_NAMES: Set<string>;
export declare function createCoreActorToolDefinitions<TContext extends RuntimeToolContext>(deps: CoreActorToolDefinitionDeps<TContext>): ActorToolDefinition[];
