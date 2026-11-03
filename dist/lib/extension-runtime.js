/**
 * Pi actor extension runtime coordinator.
 * Zones: extension session lifecycle, host tool adaptation, runtime service composition
 * Owns low-level Pi lifecycle effects and tool wrapping without owning event registration.
 */
import { join } from "node:path";
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
import * as RunRetention from "./runs-retention.js";
import * as Tools from "./tools.js";
import * as ToolsResponse from "./tools-response.js";
import { createRunSupervisionOwner, } from "./runs-supervision.js";
export function createActorExtensionRuntime(pi, supervisionPorts, completionStreamSessionAdmission, captureCompletionBatch) {
    let activeRunContext;
    let activeRunOwnerId;
    let sessionStartTicket;
    let parentSession;
    const parentSessionsByContext = new WeakMap();
    const seenParentManagers = new WeakSet();
    const recipeResolutionContextsBySession = new Map();
    const getRunOwnerId = Pi.getSessionId;
    let supervision;
    const closeSupervision = () => {
        const scope = supervision;
        supervision = undefined;
        scope?.owner.close();
    };
    const getRunAdmissionObserver = (ctx) => {
        if (!supervisionPorts)
            return undefined;
        const scope = supervision;
        const sessionManager = ctx.sessionManager;
        const ownerId = sessionManager.getSessionId();
        return capture => {
            if (!scope || supervision !== scope || !scope.ready || scope.sessionManager !== sessionManager || scope.ownerId !== ownerId || capture.identity.ownerId !== ownerId) {
                throw new Error("Run supervision coordinator admission is unavailable or changed.");
            }
            scope.owner.onSupervisionClockCaptured(capture);
        };
    };
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
        getRunAdmissionObserver,
    });
    let recipeReload;
    let runUiRuntime;
    const closeActiveSessionRuntimes = () => {
        const ownerId = activeRunOwnerId;
        activeRunContext = undefined;
        activeRunOwnerId = undefined;
        sessionStartTicket = undefined;
        runUiRuntime?.close();
        automaticReview.close();
        recipeReload?.close();
        if (ownerId)
            recipeResolutionContextsBySession.delete(ownerId);
    };
    RunUiRuntime.registerRunCompletionRenderer(pi);
    runUiRuntime = RunUiRuntime.createRunUiRuntime({
        completionStreamSessionAdmission,
        captureCompletionBatch,
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
                        onSupervisionClockCaptured: getRunAdmissionObserver(ctx),
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
        getRunAdmissionObserver,
        observeRunSnapshot(expected, capturedAt, stateDir) {
            return supervision?.owner.observeSnapshot(expected, capturedAt, stateDir) ?? Object.freeze({ state: "unavailable", reason: "origin_not_retained" });
        },
        onAgentSettled(ctx) {
            if ((completionStreamSessionAdmission || captureCompletionBatch) && !runUiRuntime.isCurrentSessionContext(ctx))
                return;
            if (!activeRunOwnerId || getRunOwnerId(ctx) !== activeRunOwnerId)
                return;
            if (!runUiRuntime.flushCompletionBatch(ctx))
                automaticReview.schedule();
        },
        onTurnEnd(event, ctx) {
            return runUiRuntime.onTurnEnd(event, ctx);
        },
        onContext(messages, ctx) {
            return runUiRuntime.projectContext(messages, ctx);
        },
        onSessionShutdown(reason, ctx) {
            const scope = parentSession;
            if (!scope?.shutdownAdmitted)
                return;
            const known = parentSessionsByContext.get(ctx);
            if (known && known !== scope)
                return;
            if (!known) {
                try {
                    if (ctx.sessionManager !== scope.sessionManager || scope.sessionManager.getSessionId() !== scope.ownerId)
                        return;
                }
                catch {
                    return; /* Unknown invalidated wrappers cannot identify this lifetime. */
                }
            }
            if (parentSession !== scope)
                return;
            // Consume before cleanup/teardown: stale or reentrant callbacks cannot stop a replacement.
            scope.shutdownAdmitted = false;
            parentSessionsByContext.set(ctx, scope);
            closeSupervision();
            if (parentSession !== scope)
                return;
            closeActiveSessionRuntimes();
            if (parentSession !== scope)
                return;
            recipeResolutionContextsBySession.delete(scope.ownerId);
            runUiRuntime.shutdown(reason, scope.ownerId, ctx);
        },
        async onSessionStart(ctx, event) {
            const ticket = {};
            sessionStartTicket = ticket;
            parentSession = undefined;
            const sessionManager = ctx.sessionManager;
            const sessionId = sessionManager.getSessionId();
            if (sessionStartTicket !== ticket)
                return;
            const scopeBinding = { ownerId: sessionId, sessionManager,
                shutdownAdmitted: !seenParentManagers.has(sessionManager) && !parentSessionsByContext.has(ctx) };
            seenParentManagers.add(sessionManager);
            if (!parentSessionsByContext.has(ctx))
                parentSessionsByContext.set(ctx, scopeBinding);
            parentSession = scopeBinding;
            closeSupervision();
            recipeResolutionContextsBySession.set(sessionId, RecipeResolution.createEmptyRecipeResolutionContext(sessionId, ctx.cwd));
            ctx.ui.setWidget("zz-pi-actors-comms", undefined);
            activeRunContext = ctx;
            activeRunOwnerId = sessionId;
            runUiRuntime.close();
            automaticReview.close();
            recipeReload.close();
            const scope = supervisionPorts ? {
                context: ctx, ownerId: sessionId, owner: createRunSupervisionOwner(supervisionPorts),
                ready: false, sessionManager,
            } : undefined;
            supervision = scope;
            await Temp.prepareExtensionTempDir(Paths.EXTENSION_RUNTIME_PATHS.tempDir);
            await RunRetention.cleanupStaleRunEntries(join(Paths.EXTENSION_RUNTIME_PATHS.tempDir, "runs"));
            if (sessionStartTicket !== ticket || activeRunContext !== ctx || activeRunOwnerId !== sessionId || supervision !== scope)
                return;
            if (scope)
                scope.ready = true;
            automaticReview.start(ctx);
            runUiRuntime.start(ctx, sessionId, event);
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
