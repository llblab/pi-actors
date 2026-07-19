/**
 * pi-actors — actor runtime and persistent local tool registry for pi.
 * Zones: composition root, pi agent, actor runtime
 *
 * Wraps command templates as callable pi tools, stores durable user tools as recipe files, and exposes actor orchestration across reloads and sessions.
 */

import * as AutomaticReviewRuntime from "./lib/automatic-review-runtime.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as InspectorCommand from "./lib/inspector-command.ts";
import * as Paths from "./lib/paths.ts";
import * as Pi from "./lib/pi.ts";
import * as Prompts from "./lib/prompts.ts";
import * as RunUiRuntime from "./lib/run-ui-runtime.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Temp from "./lib/temp.ts";
import * as Tools from "./lib/tools.ts";
import * as ToolsResponse from "./lib/tools-response.ts";

export default function toolRegistryExtension(pi: Pi.ExtensionAPI) {
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
  pi.on("resources_discover", async () => {
    const skillPaths = Paths.getExistingExtensionSkillPaths(import.meta.url);
    if (skillPaths.length === 0) return;
    return { skillPaths };
  });
  pi.on("session_start", async (_event, ctx) => {
    // Clear the pre-overlay widget after hot reloads from older pi-actors builds.
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
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (activeRunContext === ctx) automaticReview.schedule();
  });
  pi.on("session_shutdown", async (event, ctx) => {
    activeRunContext = undefined;
    automaticReview.close();
    recipeReload.close();
    runUiRuntime.shutdown(event.reason, ctx);
  });
  InspectorCommand.registerActorInspectorCommand(pi, getRunOwnerId);
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${Prompts.ONBOARDING_SYSTEM_PROMPT}`,
  }));
  Pi.registerToolDefinitions(
    pi,
    Tools.createCoreActorToolDefinitions<Pi.ExtensionContext>({
      configPath: Paths.EXTENSION_RUNTIME_PATHS.configPath,
      getActiveTools: () => pi.getActiveTools(),
      getRuntimeTool: (name) =>
        Tools.resolveActiveRuntimeTool(name, runtime.getTools(), (activeName) =>
          actorToolDefinitions.get(activeName),
        ),
      handleRuntimeMessage: automaticReview.handleMessage,
      registryRuntime: runtime,
      setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
    }).map(withCurrentThinkingContext),
  );
}
