/**
 * Tool registry runtime coordinator
 * Zones: runtime coordination, registry loading, pi tools
 * Owns persisted tool loading, reserved-name guards, runtime registration, and warning notification
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import * as Config from "./config.ts";
import type { RegisteredToolExec } from "./execution.ts";
import * as Paths from "./paths.ts";
import type { RecipeResolutionContext } from "./recipes-context.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
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
  getAllTools?: () => Array<{ name: string }>;
  registerTool: (
    definition: ReturnType<typeof ToolsLocal.createRuntimeToolDefinition>,
  ) => void;
  reservedToolNames: Set<string>;
  setActiveTools?: (toolNames: string[]) => void;
}

export interface RecipeRegistryStatus {
  active_tool_count: number;
  last_scan_counts: { active: number; rejected: number; scanned: number };
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
  loadTools(
    ctx: RuntimeContext,
    resolutionContext?: RecipeResolutionContext,
  ): void;
  notify(
    ctx: RuntimeContext,
    message: string,
    type: "info" | "warning" | "error",
  ): void;
  registerRuntimeTool(cfg: Config.RegisteredTool): RuntimeToolActivation;
  setWatchStatus(status: RecipeRegistryStatus["watch_status"]): void;
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
  const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
  const status: RecipeRegistryStatus = {
    active_tool_count: 0,
    last_scan_counts: { active: 0, rejected: 0, scanned: 0 },
    registry_generation: 0,
    watch_status: "closed",
    watched_root: recipeRoot,
  };
  function notify(
    ctx: RuntimeContext,
    message: string,
    type: "info" | "warning" | "error",
  ) {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }
  function getToolNameBlocker(name: string): string | undefined {
    return deps.reservedToolNames.has(name)
      ? `Reserved tool name: ${name}`
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
  function registeredToolSource(cfg: Config.RegisteredTool): string {
    const raw = cfg.sourcePath
      ? RecipesReferences.readRawRecipeConfig(cfg.sourcePath)
      : undefined;
    const template = raw?.template;
    if (
      typeof template === "string" &&
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(template)
    ) {
      return template;
    }
    if (
      typeof template === "string" &&
      (template.endsWith(".json") || template.endsWith(".md"))
    ) {
      return `<explicit-file:${basename(template)}>`;
    }
    return "template";
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
  function activationFor(name: string): RuntimeToolActivation {
    const hostRegistered = deps.getAllTools?.().some((tool) => tool.name === name) ?? false;
    const activeTool = deps.getActiveTools?.().includes(name) ?? false;
    return {
      active_tool: activeTool,
      activation:
        hostRegistered && activeTool ? "current_session" : "unverified",
      callable_now: hostRegistered && activeTool,
      host_registered: hostRegistered,
    };
  }
  function registerRuntimeTool(cfg: Config.RegisteredTool): RuntimeToolActivation {
    const fingerprint = getToolFingerprint(cfg);
    if (runtimeToolFingerprints.get(cfg.name) !== fingerprint) {
      deps.registerTool(ToolsLocal.createRuntimeToolDefinition(cfg, deps.exec));
      runtimeTools.add(cfg.name);
      runtimeToolFingerprints.set(cfg.name, fingerprint);
    }
    if (deps.getActiveTools && deps.setActiveTools) {
      deps.setActiveTools([
        ...new Set([...deps.getActiveTools(), cfg.name]),
      ]);
    }
    return activationFor(cfg.name);
  }
  function isStartupActionableRegistryWarning(warning: string): boolean {
    if (warning.includes(" shadows ")) return false;
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
      lines.push("User recipes shadow lower-priority user sources:");
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
    lines.push("Next: inspect target=recipes view=doctor");
    return `${lines.join("\n")}\n`;
  }
  function loadTools(
    ctx: RuntimeContext,
    resolutionContext?: RecipeResolutionContext,
  ) {
    const warnings: string[] = [];
    const discovered = RecipesDiscovery.discoverRecipeSources([
      {
        root: recipeRoot,
        defaultTool: true,
        mutableUsage: true,
        resolutionContext,
      },
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
      const blocker = getToolNameBlocker(cfg.name);
      if (blocker) {
        warnings.push(blocker);
        continue;
      }
      registerRuntimeTool(cfg);
    }
    status.active_tool_count = tools.size;
    status.last_scan_at = new Date().toISOString();
    status.last_scan_counts = {
      active: tools.size,
      rejected: discovered.entries.filter((entry) => entry.invalid).length,
      scanned: discovered.entries.length,
    };
    status.registry_generation += 1;
    status.resolution_generation = resolutionContext?.generation;
    const startupWarnings = warnings.filter(isStartupActionableRegistryWarning);
    if (startupWarnings.length > 0) {
      notify(ctx, formatRecipeToolWarnings(startupWarnings), "warning");
    }
  }
  return {
    getStatus: () => ({
      ...status,
      last_scan_counts: { ...status.last_scan_counts },
    }),
    getToolStatus: (name) => {
      const cfg = tools.get(name);
      if (!cfg) return undefined;
      const usage = cfg.sourcePath
        ? RecipesUsage.readRecipeUsage(cfg.sourcePath)
        : undefined;
      const activation = activationFor(name);
      const args = RecipesDiscovery.summarizeRegisteredToolArgs(cfg);
      return {
        ...activation,
        activation_boundary: activation.callable_now
          ? "current_session"
          : !activation.host_registered
            ? "host_registration"
            : "active_tool_set",
        persisted: Boolean(cfg.sourcePath),
        registry_active: true,
        source: registeredToolSource(cfg),
        required_args: args.required,
        optional_args: args.optional,
        next_actions: activation.callable_now
          ? [`call tool ${name}`]
          : [
              `register_tool name=${name} update=true`,
              `inspect target=tool:${name} view=status`,
            ],
        ...(usage?.launch_kind ? { launch_kind: usage.launch_kind } : {}),
        spawn_calls: Number(usage?.spawn_calls ?? 0),
        tool_calls: Number(usage?.tool_calls ?? 0),
      };
    },
    getToolNameBlocker,
    getTools: () => tools,
    loadTools,
    notify,
    registerRuntimeTool,
    setWatchStatus: (watchStatus) => {
      status.watch_status = watchStatus;
    },
  };
}

export interface RecipeToolReloadWatcherDeps {
  exists?: (path: string) => boolean;
  getResolutionContext?: () => RecipeResolutionContext | undefined;
  recipeRoot?: string;
  watchPath?: typeof watch;
}

export function createRecipeToolReloadWatcher(
  runtime: Pick<ToolRegistryRuntime, "loadTools"> &
    Partial<Pick<ToolRegistryRuntime, "setWatchStatus">>,
  deps: RecipeToolReloadWatcherDeps = {},
): RecipeToolReloadWatcher {
  const pathExists = deps.exists ?? existsSync;
  const watchPath = deps.watchPath ?? watch;
  let reloadTimeout: NodeJS.Timeout | undefined;
  let rootWatcher: FSWatcher | undefined;
  let parentWatcher: FSWatcher | undefined;
  let failureNotified = false;
  const setWatchStatus = (watchStatus: RecipeRegistryStatus["watch_status"]): void =>
    runtime.setWatchStatus?.(watchStatus);
  const close = (): void => {
    const closingRoot = rootWatcher;
    rootWatcher = undefined;
    closingRoot?.close();
    const closingParent = parentWatcher;
    parentWatcher = undefined;
    closingParent?.close();
    if (reloadTimeout) clearTimeout(reloadTimeout);
    reloadTimeout = undefined;
    setWatchStatus("closed");
  };
  const notifyFailure = (ctx: RuntimeContext): void => {
    if (failureNotified) return;
    failureNotified = true;
    setWatchStatus("failed");
    ctx.ui.notify(
      "Recipe live reload watcher failed; restart the session or use register_tool again to refresh recipe tools.",
      "warning",
    );
  };
  const scheduleReload = (ctx: RuntimeContext): void => {
    failureNotified = false;
    if (reloadTimeout) clearTimeout(reloadTimeout);
    reloadTimeout = setTimeout(() => {
      runtime.loadTools(ctx, deps.getResolutionContext?.());
      ctx.ui.notify("Recipe tools refreshed from ~/.pi/agent/recipes", "info");
    }, 150);
    reloadTimeout.unref?.();
  };
  const watchParent = (ctx: RuntimeContext, recipeRoot: string): void => {
    if (parentWatcher || rootWatcher) return;
    const parent = dirname(recipeRoot);
    if (!pathExists(parent)) {
      notifyFailure(ctx);
      return;
    }
    try {
      const watcher = watchPath(parent, (_event, changedFile) => {
        if (parentWatcher !== watcher) return;
        if (
          changedFile &&
          String(changedFile) !== basename(recipeRoot) &&
          !pathExists(recipeRoot)
        ) {
          return;
        }
        if (!pathExists(recipeRoot)) return;
        parentWatcher = undefined;
        watcher.close();
        watchRoot(ctx, recipeRoot);
        scheduleReload(ctx);
      });
      parentWatcher = watcher;
      setWatchStatus("watching_parent");
      watcher.on("error", () => {
        if (parentWatcher !== watcher) return;
        parentWatcher = undefined;
        watcher.close();
        notifyFailure(ctx);
      });
    } catch {
      notifyFailure(ctx);
    }
  };
  const watchRoot = (ctx: RuntimeContext, recipeRoot: string): void => {
    if (rootWatcher) return;
    if (!pathExists(recipeRoot)) {
      watchParent(ctx, recipeRoot);
      return;
    }
    try {
      const watcher = watchPath(recipeRoot, () => {
        if (rootWatcher !== watcher) return;
        if (!pathExists(recipeRoot)) {
          rootWatcher = undefined;
          watcher.close();
          scheduleReload(ctx);
          watchParent(ctx, recipeRoot);
          return;
        }
        scheduleReload(ctx);
      });
      rootWatcher = watcher;
      setWatchStatus("watching_root");
      watcher.on("error", () => {
        if (rootWatcher !== watcher) return;
        rootWatcher = undefined;
        watcher.close();
        if (pathExists(recipeRoot)) notifyFailure(ctx);
        else watchParent(ctx, recipeRoot);
      });
    } catch {
      notifyFailure(ctx);
    }
  };
  return {
    close,
    watch(ctx: RuntimeContext): void {
      if (rootWatcher || parentWatcher) return;
      watchRoot(ctx, deps.recipeRoot ?? Paths.getRecipeRoot());
    },
  };
}
