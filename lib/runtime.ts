/**
 * Tool registry runtime coordinator
 * Zones: runtime coordination, registry loading, pi tools
 * Owns persisted tool loading, conflict detection, runtime registration, and warning notification
 */

import * as Config from "./config.ts";
import type { RegisteredToolExec } from "./execution.ts";
import * as Paths from "./paths.ts";
import * as RecipeDiscovery from "./recipe-discovery.ts";
import * as RecipeMigration from "./recipe-migration.ts";
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

export interface ToolRegistryRuntimeDeps {
  configPath: string;
  exec: RegisteredToolExec;
  packagedRecipeRoot?: string;
  recipeRoot?: string;
  getActiveTools?: () => string[];
  getAllTools: () => ToolInfoLike[];
  registerTool: (
    definition: ReturnType<typeof Tools.createRuntimeToolDefinition>,
  ) => void;
  reservedToolNames: Set<string>;
  setActiveTools?: (toolNames: string[]) => void;
}

export interface ToolRegistryRuntime {
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
  deps: ToolRegistryRuntimeDeps,
): ToolRegistryRuntime {
  const tools = new Map<string, Config.RegisteredTool>();
  const runtimeToolFingerprints = new Map<string, string>();
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
      ? `Tool "${name}" is already registered outside pi-actors.`
      : undefined;
  }
  function getToolFingerprint(cfg: Config.RegisteredTool): string {
    return JSON.stringify({
      args: cfg.args,
      argTypes: cfg.argTypes,
      defaults: cfg.defaults,
      description: cfg.description,
      recipe: cfg.recipe,
      template: cfg.template,
    });
  }
  function deactivateMissingRuntimeTools(activeNames: Set<string>): void {
    const stale = [...runtimeTools].filter((name) => !activeNames.has(name));
    if (stale.length === 0) return;
    for (const name of stale) {
      runtimeTools.delete(name);
      runtimeToolFingerprints.delete(name);
    }
    if (!deps.getActiveTools || !deps.setActiveTools) return;
    const staleSet = new Set(stale);
    deps.setActiveTools(
      deps.getActiveTools().filter((name) => !staleSet.has(name)),
    );
  }
  function registerRuntimeTool(cfg: Config.RegisteredTool) {
    const fingerprint = getToolFingerprint(cfg);
    if (runtimeToolFingerprints.get(cfg.name) === fingerprint) return;
    deps.registerTool(Tools.createRuntimeToolDefinition(cfg, deps.exec));
    runtimeTools.add(cfg.name);
    runtimeToolFingerprints.set(cfg.name, fingerprint);
  }
  function loadTools(ctx: RuntimeContext) {
    const warnings: string[] = [];
    const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
    const packagedRecipeRoot = deps.packagedRecipeRoot ?? Paths.getPackagedRecipeRoot();
    const migration = RecipeMigration.migrateLegacyToolRegistry({
      configPath: deps.configPath,
      recipeRoot,
      reservedToolNames: deps.reservedToolNames,
    });
    warnings.push(...migration.warnings);
    if (migration.conflicts.length > 0)
      warnings.push(`Recipe migration conflicts: ${migration.conflicts.join(", ")}`);
    if (migration.invalid.length > 0)
      warnings.push(`Recipe migration invalid entries: ${migration.invalid.join(", ")}`);
    const discovered = RecipeDiscovery.discoverRecipeSources([
      { root: recipeRoot, defaultTool: true, mutableUsage: true },
      { root: packagedRecipeRoot },
    ]);
    warnings.push(...discovered.diagnostics);
    tools.clear();
    for (const entry of discovered.active.values()) {
      try {
        const cfg = RecipeDiscovery.toRegisteredTool(entry);
        if (cfg) tools.set(cfg.name, cfg);
      } catch (error) {
        warnings.push(
          `Recipe ${entry.id} could not be exposed as a tool: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    deactivateMissingRuntimeTools(new Set(tools.keys()));
    for (const cfg of tools.values()) {
      const conflict = getExternalToolConflict(cfg.name);
      if (conflict) {
        warnings.push(conflict);
        continue;
      }
      registerRuntimeTool(cfg);
    }
    if (warnings.length > 0) {
      notify(ctx, `Recipe tools: ${warnings.join("; ")}`, "warning");
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
