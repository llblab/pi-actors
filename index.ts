/**
 * pi-actors — actor runtime and persistent local tool registry for pi.
 * Zones: composition root, pi agent, actor runtime
 *
 * Wraps command templates as callable pi tools, stores durable user tools as recipe files, and exposes actor orchestration across reloads and sessions.
 */

import * as AsyncRuns from "./lib/async-runs.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as InspectorOverlay from "./lib/inspector-overlay.ts";
import * as Observability from "./lib/observability.ts";
import * as Paths from "./lib/paths.ts";
import * as Pi from "./lib/pi.ts";
import * as Prompts from "./lib/prompts.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Temp from "./lib/temp.ts";
import * as Tools from "./lib/tools.ts";
import * as ToolsResponse from "./lib/tools-response.ts";

export default function toolRegistryExtension(pi: Pi.ExtensionAPI) {
  let runsAnimationInterval: NodeJS.Timeout | undefined;
  let runsNotifyTimeout: NodeJS.Timeout | undefined;
  let activeRunContext: Pi.ExtensionContext | undefined;
  const runUi = Observability.createRunUiObservationState();
  const retirementAttempts = new Set<string>();
  const getRunOwnerId = Pi.getSessionId;
  const retireCandidateRuns = (
    ctx: Pi.ExtensionContext,
    summary: Observability.RunSummary,
  ): void => {
    void Observability.executeRunRetirements(summary, {
      attempted: retirementAttempts,
      cancelRun: (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
      notify: (message, level) => ctx.ui.notify(message, level),
      sendStop: (candidate) =>
        AsyncRuns.sendRunMessage(candidate.stateDir, "stop"),
    });
  };
  const updateRunUi = (
    ctx: Pi.ExtensionContext,
    notify = false,
    terminalOnly = false,
  ): void => {
    const ownerId = getRunOwnerId(ctx);
    const snapshot = Observability.readRunUiSnapshot(runUi, ownerId);
    ctx.ui.setStatus(
      "zz-pi-actors-runs",
      snapshot.status ? ctx.ui.theme.fg("dim", snapshot.status) : undefined,
    );
    if (!notify) return;
    const notificationSink = Pi.createNotificationSink(pi, ctx);
    retireCandidateRuns(ctx, snapshot.summary);
    Observability.deliverRunTransitionNotifications(
      snapshot.transitions,
      notificationSink,
    );
    Observability.pruneRunUiObservationState(runUi, snapshot);
    if (!terminalOnly) {
      Observability.deliverRunOutboxNotifications(
        snapshot.outboxEvents,
        notificationSink,
      );
    }
  };
  const closeRunWatchers = (): void => {
    runWatcher.close();
    if (runsNotifyTimeout) clearTimeout(runsNotifyTimeout);
    runsNotifyTimeout = undefined;
  };
  const scheduleRunEventUpdate = (ctx: Pi.ExtensionContext): void => {
    if (runsNotifyTimeout) clearTimeout(runsNotifyTimeout);
    runsNotifyTimeout = setTimeout(() => {
      runWatcher.refresh();
      updateRunUi(ctx, true);
    }, 50);
    runsNotifyTimeout.unref?.();
  };
  const runWatcher = Observability.createRunStateWatcher({
    stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
    onChange: () =>
      activeRunContext && scheduleRunEventUpdate(activeRunContext),
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
    await Temp.prepareExtensionTempDir(Paths.EXTENSION_RUNTIME_PATHS.tempDir);
    runtime.loadTools(ctx);
    updateRunUi(ctx, true, true);
    closeRunWatchers();
    recipeReload.close();
    runWatcher.refresh();
    recipeReload.watch(ctx);
    if (runsAnimationInterval) clearInterval(runsAnimationInterval);
    runsAnimationInterval = setInterval(() => updateRunUi(ctx, false), 1000);
    runsAnimationInterval.unref?.();
  });
  pi.on("session_shutdown", async () => {
    if (runsAnimationInterval) clearInterval(runsAnimationInterval);
    runsAnimationInterval = undefined;
    activeRunContext = undefined;
    closeRunWatchers();
    recipeReload.close();
  });
  pi.registerCommand("actors-inspector-toggle", {
    description: "Toggle the keyboard-driven actor inspector overlay",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("zz-pi-actors-comms", undefined);
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new InspectorOverlay.ActorInspectorOverlay({
            done,
            ownerId: getRunOwnerId(ctx),
            stateRoot: Paths.EXTENSION_RUNTIME_PATHS.runStateRoot,
            theme,
            tui,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "94%",
            minWidth: 72,
            maxHeight: "94%",
            margin: 1,
          },
        },
      );
    },
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${Prompts.ONBOARDING_SYSTEM_PROMPT}`,
  }));
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
      registryRuntime: runtime,
      setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
    }).map(withCurrentThinkingContext),
  );
}
