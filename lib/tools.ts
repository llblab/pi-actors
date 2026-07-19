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
  getRuntimeTool: (name: string) => unknown;
  handleRuntimeMessage?: (
    type: string,
    body: unknown,
  ) => Record<string, unknown>;
  registryRuntime: Pick<
    RegisterToolRuntimeDeps<TContext>,
    "getToolNameBlocker" | "getTools" | "notify" | "registerRuntimeTool"
  >;
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
  "register_tool",
  "message",
  "spawn",
  "inspect",
]);

export function createCoreActorToolDefinitions<
  TContext extends RuntimeToolContext,
>(deps: CoreActorToolDefinitionDeps<TContext>): ActorToolDefinition[] {
  return [
    ToolsRegister.createRegisterToolDefinition<TContext>({
      configPath: deps.configPath,
      getActiveTools: deps.getActiveTools,
      getToolNameBlocker: deps.registryRuntime.getToolNameBlocker,
      getTools: deps.registryRuntime.getTools,
      notify: deps.registryRuntime.notify,
      registerRuntimeTool: deps.registryRuntime.registerRuntimeTool,
      reservedToolNames: RESERVED_TOOL_NAMES,
      setActiveTools: deps.setActiveTools,
    }),
    ToolsSpawn.createSpawnToolDefinition<TContext>(),
    ToolsMessage.createActorMessageToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
      handleRuntimeMessage: deps.handleRuntimeMessage,
    }),
    ToolsInspect.createInspectToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
    }),
  ];
}
