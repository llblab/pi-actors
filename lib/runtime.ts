/**
 * Tool registry runtime coordinator
 * Zones: runtime coordination, registry loading, pi tools
 * Owns persisted tool loading, conflict detection, runtime registration, and warning notification
 */

import { existsSync, watch, type FSWatcher } from "node:fs";

import * as Config from "./config.ts";
import type { RegisteredToolExec } from "./execution.ts";
import * as Paths from "./paths.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as ToolsLocal from "./tools-local.ts";

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
    definition: ReturnType<typeof ToolsLocal.createRuntimeToolDefinition>,
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

export interface RecipeToolReloadWatcher {
  close(): void;
  watch(ctx: RuntimeContext): void;
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
    deps.registerTool(ToolsLocal.createRuntimeToolDefinition(cfg, deps.exec));
    runtimeTools.add(cfg.name);
    runtimeToolFingerprints.set(cfg.name, fingerprint);
  }
  function isStartupActionableRegistryWarning(warning: string): boolean {
    if (
      warning.includes("invokes bash;") &&
      warning.includes("trusted executable content")
    )
      return false;
    if (
      warning.includes("invokes bash;") &&
      warning.includes("shell scripts are trusted executable content")
    )
      return false;
    return true;
  }

  function formatRecipeToolWarnings(warnings: string[]): string {
    const shadowed = warnings.filter((warning) =>
      warning.includes(" shadows "),
    );
    const skipped = warnings.filter((warning) =>
      warning.includes(" could not be exposed as a tool:"),
    );
    const other = warnings.filter(
      (warning) => !shadowed.includes(warning) && !skipped.includes(warning),
    );
    const lines = ["pi-actors recipe registry warning"];
    if (shadowed.length > 0) {
      lines.push("User recipes override packaged recipes:");
      lines.push(...shadowed.map((warning) => `• ${warning}`));
    }
    if (skipped.length > 0) {
      lines.push("Recipes skipped from tool exposure:");
      lines.push(...skipped.map((warning) => `• ${warning}`));
    }
    if (other.length > 0) {
      lines.push("Other registry diagnostics:");
      lines.push(...other.map((warning) => `• ${warning}`));
    }
    return `${lines.join("\n")}\n`;
  }
  function loadTools(ctx: RuntimeContext) {
    const warnings: string[] = [];
    const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
    const packagedRecipeRoot =
      deps.packagedRecipeRoot ?? Paths.getPackagedRecipeRoot();
    const discovered = RecipesDiscovery.discoverRecipeSources([
      { root: recipeRoot, defaultTool: true, mutableUsage: true },
      { root: packagedRecipeRoot },
    ]);
    warnings.push(...discovered.diagnostics);
    tools.clear();
    for (const entry of discovered.active.values()) {
      try {
        const cfg = RecipesDiscovery.toRegisteredTool(entry);
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
    const startupWarnings = warnings.filter(isStartupActionableRegistryWarning);
    if (startupWarnings.length > 0) {
      notify(ctx, formatRecipeToolWarnings(startupWarnings), "warning");
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

export function createRecipeToolReloadWatcher(
  runtime: Pick<ToolRegistryRuntime, "loadTools">,
): RecipeToolReloadWatcher {
  let reloadTimeout: NodeJS.Timeout | undefined;
  let rootWatcher: FSWatcher | undefined;
  let failureNotified = false;
  const close = (): void => {
    rootWatcher?.close();
    rootWatcher = undefined;
    if (reloadTimeout) clearTimeout(reloadTimeout);
    reloadTimeout = undefined;
  };
  const notifyFailure = (ctx: RuntimeContext): void => {
    if (failureNotified) return;
    failureNotified = true;
    ctx.ui.notify(
      "Recipe live reload watcher failed; restart the session or use register_tool again to refresh recipe tools.",
      "warning",
    );
  };
  const scheduleReload = (ctx: RuntimeContext): void => {
    failureNotified = false;
    if (reloadTimeout) clearTimeout(reloadTimeout);
    reloadTimeout = setTimeout(() => {
      runtime.loadTools(ctx);
      ctx.ui.notify("Recipe tools refreshed from ~/.pi/agent/recipes", "info");
    }, 150);
    reloadTimeout.unref?.();
  };
  return {
    close,
    watch(ctx: RuntimeContext): void {
      const recipeRoot = Paths.getRecipeRoot();
      if (rootWatcher || !existsSync(recipeRoot)) return;
      try {
        rootWatcher = watch(recipeRoot, () => scheduleReload(ctx));
        rootWatcher.on("error", () => {
          rootWatcher?.close();
          rootWatcher = undefined;
          notifyFailure(ctx);
        });
      } catch {
        notifyFailure(ctx);
      }
    },
  };
}
