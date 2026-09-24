/**
 * Tool registry runtime coordinator
 * Zones: runtime coordination, registry loading, pi tools
 * Owns persisted tool loading, reserved-name guards, runtime registration, and warning notification
 */
import { existsSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import * as Paths from "./paths.js";
import * as RecipesDiscovery from "./recipes-discovery.js";
import * as RecipesReferences from "./recipes-references.js";
import * as RecipesUsage from "./recipes-usage.js";
import * as ToolsLocal from "./tools-local.js";
export function createAutoToolsRuntime(deps) {
    const tools = new Map();
    const runtimeToolFingerprints = new Map();
    const runtimeTools = new Set();
    const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
    const status = {
        active_tool_count: 0,
        last_scan_counts: { active: 0, rejected: 0, scanned: 0 },
        registry_generation: 0,
        watch_status: "closed",
        watched_root: recipeRoot,
    };
    function notify(ctx, message, type) {
        if (ctx.hasUI)
            ctx.ui.notify(message, type);
    }
    function getToolNameBlocker(name) {
        return deps.reservedToolNames.has(name)
            ? `Reserved tool name: ${name}`
            : undefined;
    }
    function getToolFingerprint(cfg) {
        return JSON.stringify({
            args: cfg.args,
            argTypes: cfg.argTypes,
            defaults: cfg.defaults,
            description: cfg.description,
            recipe: cfg.recipe,
            template: cfg.template,
        });
    }
    function registeredToolSource(cfg) {
        const raw = cfg.sourcePath
            ? RecipesReferences.readRawRecipeConfig(cfg.sourcePath)
            : undefined;
        const template = raw?.template;
        if (typeof template === "string" &&
            /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(template)) {
            return template;
        }
        if (typeof template === "string" &&
            (template.endsWith(".json") || template.endsWith(".md"))) {
            return `<explicit-file:${basename(template)}>`;
        }
        return "template";
    }
    function deactivateMissingRuntimeTools(activeNames) {
        const stale = [...runtimeTools].filter((name) => !activeNames.has(name));
        if (stale.length === 0)
            return;
        for (const name of stale) {
            runtimeTools.delete(name);
            runtimeToolFingerprints.delete(name);
        }
        if (!deps.getActiveTools || !deps.setActiveTools)
            return;
        const staleSet = new Set(stale);
        deps.setActiveTools(deps.getActiveTools().filter((name) => !staleSet.has(name)));
    }
    function activationFor(name) {
        const hostRegistered = deps.getAllTools?.().some((tool) => tool.name === name) ?? false;
        const activeTool = deps.getActiveTools?.().includes(name) ?? false;
        return {
            active_tool: activeTool,
            activation: hostRegistered && activeTool ? "current_session" : "unverified",
            callable_now: hostRegistered && activeTool,
            host_registered: hostRegistered,
        };
    }
    function registerRuntimeTool(cfg) {
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
    function isStartupActionableRegistryWarning(warning) {
        if (warning.includes(" shadows "))
            return false;
        if (warning.includes("invokes bash;") &&
            warning.includes("trusted executable content"))
            return false;
        if (warning.includes("invokes bash;") &&
            warning.includes("shell scripts are trusted executable content"))
            return false;
        return true;
    }
    function formatRecipeToolWarnings(warnings) {
        const shadowed = warnings.filter((warning) => warning.includes(" shadows "));
        const skipped = warnings.filter((warning) => warning.includes(" could not be exposed as a tool:"));
        const other = warnings.filter((warning) => !shadowed.includes(warning) && !skipped.includes(warning));
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
    function loadTools(ctx, resolutionContext) {
        const warnings = [];
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
                if (cfg)
                    tools.set(cfg.name, cfg);
            }
            catch (error) {
                warnings.push(`Recipe ${entry.id} could not be exposed as a tool: ${error instanceof Error ? error.message : String(error)}`);
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
            if (!cfg)
                return undefined;
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
export function createRecipeToolReloadWatcher(runtime, deps = {}) {
    const pathExists = deps.exists ?? existsSync;
    const watchPath = deps.watchPath ?? watch;
    let reloadTimeout;
    let rootWatcher;
    let parentWatcher;
    let failureNotified = false;
    let notifyAfterReload = false;
    const setWatchStatus = (watchStatus) => runtime.setWatchStatus?.(watchStatus);
    const close = () => {
        const closingRoot = rootWatcher;
        rootWatcher = undefined;
        closingRoot?.close();
        const closingParent = parentWatcher;
        parentWatcher = undefined;
        closingParent?.close();
        if (reloadTimeout)
            clearTimeout(reloadTimeout);
        reloadTimeout = undefined;
        notifyAfterReload = false;
        setWatchStatus("closed");
    };
    const reportCallbackError = (error) => {
        try {
            deps.onCallbackError?.(error);
        }
        catch {
            /* host callback containment must remain no-throw */
        }
    };
    const notifyFailure = (ctx) => {
        if (failureNotified)
            return;
        failureNotified = true;
        setWatchStatus("failed");
        try {
            ctx.ui.notify("Recipe live reload watcher failed; restart the session or use register_tool again to refresh recipe tools.", "warning");
        }
        catch (error) {
            reportCallbackError(error);
        }
    };
    const scheduleReload = (ctx, notifyActiveChange = false) => {
        failureNotified = false;
        notifyAfterReload ||= notifyActiveChange;
        if (reloadTimeout)
            clearTimeout(reloadTimeout);
        reloadTimeout = setTimeout(() => {
            reloadTimeout = undefined;
            try {
                runtime.loadTools(ctx, deps.getResolutionContext?.());
                if (notifyAfterReload) {
                    ctx.ui.notify("Recipe tools refreshed from ~/.pi/agent/recipes", "info");
                }
                notifyAfterReload = false;
            }
            catch (error) {
                notifyFailure(ctx);
                reportCallbackError(error);
            }
        }, deps.reloadDelayMs ?? 150);
        reloadTimeout.unref?.();
    };
    const watchParent = (ctx, recipeRoot) => {
        if (parentWatcher || rootWatcher)
            return;
        const parent = dirname(recipeRoot);
        if (!pathExists(parent)) {
            notifyFailure(ctx);
            return;
        }
        try {
            const watcher = watchPath(parent, (_event, changedFile) => {
                if (parentWatcher !== watcher)
                    return;
                if (changedFile &&
                    String(changedFile) !== basename(recipeRoot) &&
                    !pathExists(recipeRoot)) {
                    return;
                }
                if (!pathExists(recipeRoot))
                    return;
                parentWatcher = undefined;
                watcher.close();
                watchRoot(ctx, recipeRoot);
                scheduleReload(ctx, true);
            });
            parentWatcher = watcher;
            setWatchStatus("watching_parent");
            watcher.on("error", () => {
                if (parentWatcher !== watcher)
                    return;
                parentWatcher = undefined;
                watcher.close();
                notifyFailure(ctx);
            });
        }
        catch {
            notifyFailure(ctx);
        }
    };
    const watchRoot = (ctx, recipeRoot) => {
        if (rootWatcher)
            return;
        if (!pathExists(recipeRoot)) {
            watchParent(ctx, recipeRoot);
            return;
        }
        try {
            const watcher = watchPath(recipeRoot, (_event, changedFile) => {
                if (rootWatcher !== watcher)
                    return;
                if (!pathExists(recipeRoot)) {
                    rootWatcher = undefined;
                    watcher.close();
                    scheduleReload(ctx, true);
                    watchParent(ctx, recipeRoot);
                    return;
                }
                const relativeChange = changedFile ? String(changedFile) : "";
                const firstSegment = relativeChange.split(/[\\/]/u)[0];
                scheduleReload(ctx, Boolean(relativeChange) && firstSegment !== "drafts");
            });
            rootWatcher = watcher;
            setWatchStatus("watching_root");
            watcher.on("error", () => {
                if (rootWatcher !== watcher)
                    return;
                rootWatcher = undefined;
                watcher.close();
                if (pathExists(recipeRoot))
                    notifyFailure(ctx);
                else
                    watchParent(ctx, recipeRoot);
            });
        }
        catch {
            notifyFailure(ctx);
        }
    };
    return {
        close,
        watch(ctx) {
            if (rootWatcher || parentWatcher)
                return;
            watchRoot(ctx, deps.recipeRoot ?? Paths.getRecipeRoot());
        },
    };
}
