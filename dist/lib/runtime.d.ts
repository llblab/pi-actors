/**
 * Tool registry runtime coordinator
 * Zones: runtime coordination, registry loading, pi tools
 * Owns persisted tool loading, reserved-name guards, runtime registration, and warning notification
 */
import { watch } from "node:fs";
import * as Config from "./config.ts";
import type { RegisteredToolExec } from "./execution.ts";
import type { RecipeResolutionContext } from "./recipes-context.ts";
import * as ToolsLocal from "./tools-local.ts";
export interface RuntimeContext {
    hasUI: boolean;
    ui: {
        notify(message: string, type?: "info" | "warning" | "error"): void;
    };
}
export interface RuntimeToolActivation {
    active_tool: boolean;
    activation: "current_session" | "unverified";
    callable_now: boolean;
    host_registered: boolean;
}
export interface ToolRegistryRuntimeDeps {
    configPath: string;
    exec: RegisteredToolExec;
    recipeRoot?: string;
    getActiveTools?: () => string[];
    getAllTools?: () => Array<{
        name: string;
    }>;
    registerTool: (definition: ReturnType<typeof ToolsLocal.createRuntimeToolDefinition>) => void;
    reservedToolNames: Set<string>;
    setActiveTools?: (toolNames: string[]) => void;
}
export interface RecipeRegistryStatus {
    active_tool_count: number;
    last_scan_counts: {
        active: number;
        rejected: number;
        scanned: number;
    };
    last_scan_at?: string;
    registry_generation: number;
    resolution_generation?: string;
    watch_status: "closed" | "failed" | "watching_parent" | "watching_root";
    watched_root: string;
}
export interface ToolRegistryRuntime {
    getStatus(): RecipeRegistryStatus;
    getToolStatus(name: string): Record<string, unknown> | undefined;
    getToolNameBlocker(name: string): string | undefined;
    getTools(): Map<string, Config.RegisteredTool>;
    loadTools(ctx: RuntimeContext, resolutionContext?: RecipeResolutionContext): void;
    notify(ctx: RuntimeContext, message: string, type: "info" | "warning" | "error"): void;
    registerRuntimeTool(cfg: Config.RegisteredTool): RuntimeToolActivation;
    setWatchStatus(status: RecipeRegistryStatus["watch_status"]): void;
}
export interface RecipeToolReloadWatcher {
    close(): void;
    watch(ctx: RuntimeContext): void;
}
export declare function createAutoToolsRuntime(deps: ToolRegistryRuntimeDeps): ToolRegistryRuntime;
export interface RecipeToolReloadWatcherDeps {
    exists?: (path: string) => boolean;
    getResolutionContext?: () => RecipeResolutionContext | undefined;
    onCallbackError?: (error: unknown) => void;
    recipeRoot?: string;
    reloadDelayMs?: number;
    watchPath?: typeof watch;
}
export declare function createRecipeToolReloadWatcher(runtime: Pick<ToolRegistryRuntime, "loadTools"> & Partial<Pick<ToolRegistryRuntime, "setWatchStatus">>, deps?: RecipeToolReloadWatcherDeps): RecipeToolReloadWatcher;
