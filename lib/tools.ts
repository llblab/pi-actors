/**
 * Public tool family composition
 * Zones: tool set, reserved tool names, pi-facing tool wiring
 * Owns public tool-family composition without owning individual tool behavior
 */

import * as ToolsInspect from "./tools-inspect.ts";
import type { RuntimeToolContext } from "./tools-local.ts";
import * as ToolsMessage from "./tools-message.ts";
import * as ToolsRegister from "./tools-register.ts";
import * as ToolsSpawn from "./tools-spawn.ts";

export type RegisterToolRuntimeDeps<TContext> =
  ToolsRegister.RegisterToolRuntimeDeps<TContext>;

export interface ActorToolDefinition {
  name: string;
  execute?: (...args: never[]) => unknown;
  [key: string]: unknown;
}

export interface CoreActorToolDefinitionDeps<
  TContext extends RuntimeToolContext,
> {
  configPath: string;
  getActiveTools: () => string[];
  getRecipeResolutionContext: () => import("./recipes-context.ts").RecipeResolutionContext | undefined;
  getRuntimeTool: (name: string) => unknown;
  getRuntimeToolStatus: (name: string) => Record<string, unknown> | undefined;
  handleRuntimeControl?: (
    action: string,
    input: unknown,
  ) => Record<string, unknown>;
  registryRuntime: Pick<
    RegisterToolRuntimeDeps<TContext>,
    "getToolNameBlocker" | "getTools" | "notify" | "registerRuntimeTool"
  > & { getStatus(): import("./runtime.ts").RecipeRegistryStatus };
  setActiveTools: (toolNames: string[]) => void;
}

export function resolveActiveRuntimeTool(
  name: string,
  activeTools: Pick<Map<string, unknown>, "has">,
  getDefinition: (name: string) => unknown,
): unknown {
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
} as const;

export function createLegacyActorToolDefinitions(
  definitions: ActorToolDefinition[],
): ActorToolDefinition[] {
  return Object.entries(LEGACY_TOOL_NAMES).map(([name, canonical]) => {
    const definition = definitions.find((tool) => tool.name === canonical);
    if (!definition) throw new Error(`Missing canonical actor tool: ${canonical}`);
    return {
      ...definition, name, exposure: "deferred",
      description: `Compatibility dispatch for ${canonical}; use the canonical tool for new calls.`,
      promptSnippet: undefined, promptGuidelines: undefined,
      prepareLoadout: () => ({ hiddenDeclarations: Object.keys(LEGACY_TOOL_NAMES) }),
    };
  });
}

export function createCoreActorToolDefinitions<
  TContext extends RuntimeToolContext,
>(deps: CoreActorToolDefinitionDeps<TContext>): ActorToolDefinition[] {
  return [
    ToolsRegister.createRegisterToolDefinition<TContext>({
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
    ToolsSpawn.createSpawnToolDefinition<TContext>(),
    ToolsMessage.createControlToolDefinition<TContext>({
      handleRuntimeControl: deps.handleRuntimeControl,
    }),
    ToolsInspect.createInspectToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
      getToolStatus: deps.getRuntimeToolStatus,
      registryStatus: deps.registryRuntime.getStatus,
    }),
  ];
}
