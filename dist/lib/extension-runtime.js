/**
 * Pi actor extension runtime coordinator.
 * Zones: extension session lifecycle, host tool adaptation, runtime service composition
 * Owns low-level Pi lifecycle effects and tool wrapping without owning event registration.
 */
import * as AutomaticReviewRuntime from "./automatic-review-runtime.js";
import * as CommandTemplates from "./command-templates.js";
import * as Paths from "./paths.js";
import * as Pi from "./pi.js";
import * as Prompts from "./prompts.js";
import * as RecipeResolution from "./recipes-context.js";
import * as RecipesReferences from "./recipes-references.js";
import * as RunUiRuntime from "./run-ui-runtime.js";
import * as Runtime from "./runtime.js";
import * as Temp from "./temp.js";
import * as Tools from "./tools.js";
import * as ToolsResponse from "./tools-response.js";
export function createActorExtensionRuntime(pi) {
    let activeRunContext;
    let activeRunOwnerId;
    const runOwnerIdsByContext = new WeakMap();
    const recipeResolutionContextsBySession = new Map();
    const getRunOwnerId = Pi.getSessionId;
    const getRecipeResolutionContext = (ctx) => {
        const sessionId = getRunOwnerId(ctx);
        const resolutionContext = recipeResolutionContextsBySession.get(sessionId);
        if (!resolutionContext) {
            throw new Error(`Recipe resolution context is unavailable for session ${sessionId}.`);
        }
        return resolutionContext;
    };
    const automaticReview = AutomaticReviewRuntime.createAutomaticReviewRuntime({
        getActiveContext: () => activeRunContext,
        getRunOwnerId,
        getThinkingLevel: () => pi.getThinkingLevel(),
    });
    let recipeReload;
    let runUiRuntime;
    const closeActiveSessionRuntimes = () => {
        const ownerId = activeRunOwnerId;
        activeRunContext = undefined;
        activeRunOwnerId = undefined;
        runUiRuntime?.close();
        automaticReview.close();
        recipeReload?.close();
        if (ownerId)
            recipeResolutionContextsBySession.delete(ownerId);
    };
    runUiRuntime = RunUiRuntime.createRunUiRuntime({
        getActiveContext: () => activeRunContext,
        onCallbackError: closeActiveSessionRuntimes,
        onRunEvent: automaticReview.schedule,
        pi,
    });
    const actorToolDefinitions = new Map();
    const withCurrentThinkingContext = (definition) => {
        if (typeof definition.execute !== "function")
            return definition;
        const execute = definition.execute;
        return {
            ...definition,
            execute: async (...args) => {
                const nextArgs = [...args];
                const ctx = nextArgs[4];
                if (ctx && typeof ctx === "object") {
                    nextArgs[4] = {
                        ...ctx,
                        recipeResolutionContext: getRecipeResolutionContext(ctx),
                        getThinkingLevel: () => pi.getThinkingLevel(),
                    };
                }
                try {
                    return ToolsResponse.spaceToolResult(await execute(...nextArgs));
                }
                catch (error) {
                    throw ToolsResponse.spaceToolError(error);
                }
            },
        };
    };
    const runtime = Runtime.createAutoToolsRuntime({
        configPath: Paths.EXTENSION_RUNTIME_PATHS.configPath,
        exec: CommandTemplates.execCommandTemplate,
        getActiveTools: () => pi.getActiveTools(),
        getAllTools: () => pi.getAllTools(),
        registerTool: (definition) => {
            const wrapped = withCurrentThinkingContext(definition);
            actorToolDefinitions.set(wrapped.name, wrapped);
            pi.registerTool(wrapped);
        },
        reservedToolNames: Tools.RESERVED_TOOL_NAMES,
        setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
    });
    recipeReload = Runtime.createRecipeToolReloadWatcher(runtime, {
        getResolutionContext: () => activeRunContext
            ? getRecipeResolutionContext(activeRunContext)
            : undefined,
        onCallbackError: closeActiveSessionRuntimes,
    });
    return {
        beforeAgentStart(systemPrompt, skills, ctx) {
            const sessionId = getRunOwnerId(ctx);
            const resolutionContext = RecipeResolution.createRecipeResolutionContext(sessionId, ctx.cwd, RecipesReferences.createActiveSkillRecipeContext(skills));
            recipeResolutionContextsBySession.set(sessionId, resolutionContext);
            runtime.loadTools(ctx, resolutionContext);
            return {
                systemPrompt: `${systemPrompt}\n\n${Prompts.ONBOARDING_SYSTEM_PROMPT}`,
            };
        },
        discoverResources(metaUrl) {
            const skillPaths = Paths.getExistingExtensionSkillPaths(metaUrl);
            return skillPaths.length > 0 ? { skillPaths } : undefined;
        },
        getRunOwnerId,
        onAgentSettled(ctx) {
            if (!activeRunOwnerId || getRunOwnerId(ctx) !== activeRunOwnerId)
                return;
            if (!runUiRuntime.flushCompletionBatch(ctx))
                automaticReview.schedule();
        },
        onContext(messages, ctx) {
            return runUiRuntime.projectContext(messages, ctx);
        },
        onSessionShutdown(reason, ctx) {
            const ownerId = runOwnerIdsByContext.get(ctx);
            runOwnerIdsByContext.delete(ctx);
            if (activeRunContext === ctx)
                closeActiveSessionRuntimes();
            if (ownerId)
                recipeResolutionContextsBySession.delete(ownerId);
            runUiRuntime.shutdown(reason, ownerId, ctx);
        },
        async onSessionStart(ctx) {
            const sessionId = getRunOwnerId(ctx);
            recipeResolutionContextsBySession.set(sessionId, RecipeResolution.createEmptyRecipeResolutionContext(sessionId, ctx.cwd));
            ctx.ui.setWidget("zz-pi-actors-comms", undefined);
            activeRunContext = ctx;
            activeRunOwnerId = sessionId;
            runOwnerIdsByContext.set(ctx, sessionId);
            runUiRuntime.close();
            automaticReview.close();
            recipeReload.close();
            await Temp.prepareExtensionTempDir(Paths.EXTENSION_RUNTIME_PATHS.tempDir);
            if (activeRunContext !== ctx || activeRunOwnerId !== sessionId)
                return;
            automaticReview.start(ctx);
            runUiRuntime.start(ctx, sessionId);
            recipeReload.watch(ctx);
        },
        registerCoreTools() {
            Pi.registerToolDefinitions(pi, Tools.createCoreActorToolDefinitions({
                configPath: Paths.EXTENSION_RUNTIME_PATHS.configPath,
                getActiveTools: () => pi.getActiveTools(),
                getRecipeResolutionContext: () => activeRunContext
                    ? getRecipeResolutionContext(activeRunContext)
                    : undefined,
                getRuntimeTool: (name) => Tools.resolveActiveRuntimeTool(name, runtime.getTools(), (activeName) => actorToolDefinitions.get(activeName)),
                getRuntimeToolStatus: runtime.getToolStatus,
                handleRuntimeControl: automaticReview.handleControl,
                registryRuntime: runtime,
                setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
            }).map(withCurrentThinkingContext));
        },
    };
}
