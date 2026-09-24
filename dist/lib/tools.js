/**
 * Public tool family composition
 * Zones: tool set, reserved tool names, pi-facing tool wiring
 * Owns public tool-family composition without owning individual tool behavior
 */
import * as ToolsInspect from "./tools-inspect.js";
import * as ToolsMessage from "./tools-message.js";
import * as ToolsRegister from "./tools-register.js";
import * as ToolsSpawn from "./tools-spawn.js";
export function resolveActiveRuntimeTool(name, activeTools, getDefinition) {
    return activeTools.has(name) ? getDefinition(name) : undefined;
}
export const RESERVED_TOOL_NAMES = new Set([
    "read",
    "write",
    "edit",
    "bash",
    "find",
    "grep",
    "ls",
    "register_tool",
    "message",
    "spawn",
    "inspect",
]);
export function createCoreActorToolDefinitions(deps) {
    return [
        ToolsRegister.createRegisterToolDefinition({
            configPath: deps.configPath,
            getActiveTools: deps.getActiveTools,
            getToolNameBlocker: deps.registryRuntime.getToolNameBlocker,
            getTools: deps.registryRuntime.getTools,
            getRecipeResolutionContext: deps.getRecipeResolutionContext,
            notify: deps.registryRuntime.notify,
            registerRuntimeTool: deps.registryRuntime.registerRuntimeTool,
            reservedToolNames: RESERVED_TOOL_NAMES,
            setActiveTools: deps.setActiveTools,
        }),
        ToolsSpawn.createSpawnToolDefinition(),
        ToolsMessage.createControlToolDefinition({
            handleRuntimeControl: deps.handleRuntimeControl,
        }),
        ToolsInspect.createInspectToolDefinition({
            getTool: (name) => deps.getRuntimeTool(name),
            getToolStatus: deps.getRuntimeToolStatus,
            registryStatus: deps.registryRuntime.getStatus,
        }),
    ];
}
