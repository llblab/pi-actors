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
    "actors_tool_register",
    "actors_run_spawn",
    "actors_control_apply",
    "actors_inspect",
    "register_tool",
    "message",
    "spawn",
    "inspect",
]);
// Compatibility dispatch is registered but omitted from model declarations and normal
// callable listings. Active legacy names still execute saved native tool calls.
export const LEGACY_TOOL_NAMES = {
    register_tool: "actors_tool_register",
    spawn: "actors_run_spawn",
    message: "actors_control_apply",
    inspect: "actors_inspect",
};
export function createLegacyActorToolDefinitions(definitions) {
    return Object.entries(LEGACY_TOOL_NAMES).map(([name, canonical]) => {
        const definition = definitions.find((tool) => tool.name === canonical);
        if (!definition)
            throw new Error(`Missing canonical actor tool: ${canonical}`);
        return {
            ...definition, name, exposure: "deferred",
            description: `Compatibility dispatch for ${canonical}; use the canonical tool for new calls.`,
            promptSnippet: undefined, promptGuidelines: undefined,
            prepareLoadout: () => ({ hiddenDeclarations: Object.keys(LEGACY_TOOL_NAMES) }),
        };
    });
}
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
