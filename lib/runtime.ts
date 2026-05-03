/**
 * Auto-tool runtime coordinator
 * Owns persisted tool loading, conflict detection, runtime registration, and warning notification
 */

import * as Config from "./config.ts";
import type { RegisteredToolExec } from "./execution.ts";
import * as Tools from "./tools.ts";

export interface RuntimeContext {
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface ToolInfoLike {
  name: string;
}

export interface AutoToolsRuntimeDeps {
  configPath: string;
  exec: RegisteredToolExec;
  getAllTools: () => ToolInfoLike[];
  registerTool: (
    definition: ReturnType<typeof Tools.createRuntimeToolDefinition>,
  ) => void;
  reservedToolNames: Set<string>;
}

export interface AutoToolsRuntime {
  getExternalToolConflict(name: string): string | undefined;
  getTools(): Map<string, Config.RegisteredTool>;
  loadTools(ctx: RuntimeContext): void;
  notify(
    ctx: RuntimeContext,
    message: string,
    type: "info" | "warning" | "error",
  ): void;
  registerRuntimeTool(cfg: Config.RegisteredTool): void;
}

export function createAutoToolsRuntime(
  deps: AutoToolsRuntimeDeps,
): AutoToolsRuntime {
  const tools = new Map<string, Config.RegisteredTool>();
  const runtimeTools = new Set<string>();
  function notify(
    ctx: RuntimeContext,
    message: string,
    type: "info" | "warning" | "error",
  ) {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }
  function getExternalToolConflict(name: string): string | undefined {
    if (runtimeTools.has(name)) return undefined;
    const existing = deps.getAllTools().find((tool) => tool.name === name);
    return existing
      ? `Tool "${name}" is already registered outside pi-auto-tools.`
      : undefined;
  }
  function registerRuntimeTool(cfg: Config.RegisteredTool) {
    deps.registerTool(Tools.createRuntimeToolDefinition(cfg, deps.exec));
    runtimeTools.add(cfg.name);
  }
  function loadTools(ctx: RuntimeContext) {
    const loaded = Config.loadToolConfig(
      deps.configPath,
      deps.reservedToolNames,
    );
    tools.clear();
    for (const [name, cfg] of loaded.tools) tools.set(name, cfg);
    if (loaded.changed) {
      const saveError = Config.saveTools(deps.configPath, tools);
      if (saveError) {
        loaded.warnings.push(
          `Failed to normalize ${deps.configPath}: ${saveError}`,
        );
      }
    }
    for (const cfg of tools.values()) {
      const conflict = getExternalToolConflict(cfg.name);
      if (conflict) {
        loaded.warnings.push(conflict);
        continue;
      }
      registerRuntimeTool(cfg);
    }
    if (loaded.warnings.length > 0) {
      notify(ctx, `Auto-tools: ${loaded.warnings.join("; ")}`, "warning");
    }
  }
  return {
    getExternalToolConflict,
    getTools: () => tools,
    loadTools,
    notify,
    registerRuntimeTool,
  };
}
