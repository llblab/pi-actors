/**
 * Pi actor extension runtime coordinator.
 * Zones: extension session lifecycle, host tool adaptation, runtime service composition
 * Owns low-level Pi lifecycle effects and tool wrapping without owning event registration.
 */

import * as AutomaticReviewRuntime from "./automatic-review-runtime.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Paths from "./paths.ts";
import * as Pi from "./pi.ts";
import * as Prompts from "./prompts.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RunUiRuntime from "./run-ui-runtime.ts";
import * as Runtime from "./runtime.ts";
import * as Temp from "./temp.ts";
import * as Tools from "./tools.ts";
import * as ToolsResponse from "./tools-response.ts";

export interface ActorExtensionRuntime {
  beforeAgentStart(
    systemPrompt: string,
    skills: RecipesReferences.ActiveSkillRecipeSource[],
  ): { systemPrompt: string };
  discoverResources(metaUrl: string): { skillPaths: string[] } | undefined;
  getRunOwnerId(ctx: Pi.ExtensionContext): string;
  onAgentEnd(ctx: Pi.ExtensionContext): void;
  onSessionShutdown(reason: string, ctx: Pi.ExtensionContext): void;
  onSessionStart(ctx: Pi.ExtensionContext): Promise<void>;
  registerCoreTools(): void;
}

export function createActorExtensionRuntime(
  pi: Pi.ExtensionAPI,
): ActorExtensionRuntime {
  let activeRunContext: Pi.ExtensionContext | undefined;
  const getRunOwnerId = Pi.getSessionId;
  const automaticReview = AutomaticReviewRuntime.createAutomaticReviewRuntime({
    getActiveContext: () => activeRunContext,
    getRunOwnerId,
    getThinkingLevel: () => pi.getThinkingLevel(),
  });
  const runUiRuntime = RunUiRuntime.createRunUiRuntime({
    getActiveContext: () => activeRunContext,
    getRunOwnerId,
    onRunEvent: automaticReview.schedule,
    pi,
  });
  const actorToolDefinitions = new Map<string, Tools.ActorToolDefinition>();
  const withCurrentThinkingContext = <T extends Tools.ActorToolDefinition>(
    definition: T,
  ): T => {
    if (typeof definition.execute !== "function") return definition;
    const execute = definition.execute as (...args: unknown[]) => unknown;
    return {
      ...definition,
      execute: async (...args: unknown[]) => {
        const nextArgs = [...args];
        const ctx = nextArgs[4];
        if (ctx && typeof ctx === "object") {
          nextArgs[4] = {
            ...(ctx as Record<string, unknown>),
            getThinkingLevel: () => pi.getThinkingLevel(),
          };
        }
        try {
          return ToolsResponse.spaceToolResult(await execute(...nextArgs));
        } catch (error) {
          throw ToolsResponse.spaceToolError(error);
        }
      },
    } as T;
  };
  const runtime = Runtime.createAutoToolsRuntime({
    configPath: Paths.EXTENSION_RUNTIME_PATHS.configPath,
    exec: CommandTemplates.execCommandTemplate,
    getActiveTools: () => pi.getActiveTools(),
    registerTool: (definition) => {
      const wrapped = withCurrentThinkingContext(definition);
      actorToolDefinitions.set(wrapped.name, wrapped);
      pi.registerTool(wrapped);
    },
    reservedToolNames: Tools.RESERVED_TOOL_NAMES,
    setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
  });
  const recipeReload = Runtime.createRecipeToolReloadWatcher(runtime);
  return {
    beforeAgentStart(systemPrompt, skills) {
      RecipesReferences.setActiveSkillRecipeSources(skills);
      return {
        systemPrompt: `${systemPrompt}\n\n${Prompts.ONBOARDING_SYSTEM_PROMPT}`,
      };
    },
    discoverResources(metaUrl) {
      const skillPaths = Paths.getExistingExtensionSkillPaths(metaUrl);
      return skillPaths.length > 0 ? { skillPaths } : undefined;
    },
    getRunOwnerId,
    onAgentEnd(ctx) {
      if (activeRunContext === ctx) automaticReview.schedule();
    },
    onSessionShutdown(reason, ctx) {
      activeRunContext = undefined;
      automaticReview.close();
      recipeReload.close();
      runUiRuntime.shutdown(reason, ctx);
    },
    async onSessionStart(ctx) {
      ctx.ui.setWidget("zz-pi-actors-comms", undefined);
      activeRunContext = ctx;
      runUiRuntime.close();
      automaticReview.close();
      recipeReload.close();
      await Temp.prepareExtensionTempDir(Paths.EXTENSION_RUNTIME_PATHS.tempDir);
      if (activeRunContext !== ctx) return;
      automaticReview.start(ctx);
      runtime.loadTools(ctx);
      runUiRuntime.start(ctx);
      recipeReload.watch(ctx);
    },
    registerCoreTools() {
      Pi.registerToolDefinitions(
        pi,
        Tools.createCoreActorToolDefinitions<Pi.ExtensionContext>({
          configPath: Paths.EXTENSION_RUNTIME_PATHS.configPath,
          getActiveTools: () => pi.getActiveTools(),
          getRuntimeTool: (name) =>
            Tools.resolveActiveRuntimeTool(
              name,
              runtime.getTools(),
              (activeName) => actorToolDefinitions.get(activeName),
            ),
          handleRuntimeControl: automaticReview.handleControl,
          registryRuntime: runtime,
          setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
        }).map(withCurrentThinkingContext),
      );
    },
  };
}
