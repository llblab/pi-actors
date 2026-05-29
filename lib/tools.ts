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
  registryRuntime: Pick<
    RegisterToolRuntimeDeps<TContext>,
    "getExternalToolConflict" | "getTools" | "notify" | "registerRuntimeTool"
  >;
  setActiveTools: (toolNames: string[]) => void;
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
      getExternalToolConflict: deps.registryRuntime.getExternalToolConflict,
      getTools: deps.registryRuntime.getTools,
      notify: deps.registryRuntime.notify,
      registerRuntimeTool: deps.registryRuntime.registerRuntimeTool,
      reservedToolNames: RESERVED_TOOL_NAMES,
      setActiveTools: deps.setActiveTools,
    }),
    ToolsSpawn.createSpawnToolDefinition<TContext>(),
    ToolsMessage.createActorMessageToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
    }),
    ToolsInspect.createInspectToolDefinition<TContext>({
      getTool: (name) => deps.getRuntimeTool(name),
    }),
  ];
}
