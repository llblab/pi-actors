/**
 * pi-actors — actor runtime and persistent local tool registry for pi.
 * Zones: composition root, pi agent, actor runtime
 *
 * Wraps command templates as callable pi tools, stores durable user tools as recipe files, and exposes actor orchestration across reloads and sessions.
 */

import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import * as ActorInspectorTui from "./lib/actor-inspector-tui.ts";
import * as AsyncRuns from "./lib/async-runs.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Observability from "./lib/observability.ts";
import * as Paths from "./lib/paths.ts";
import * as Prompts from "./lib/prompts.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Temp from "./lib/temp.ts";
import * as Tools from "./lib/tools.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_SKILLS_DIR = join(EXTENSION_DIR, "skills");
const CONFIG_PATH = Paths.getConfigPath();
const TEMP_DIR = Paths.getExtensionTmpDir();
const RUN_STATE_ROOT = Paths.getRunStateRoot();
const RESERVED_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
  "register_tool",
  "message",
  "spawn",
  "inspect",
]);

export default function toolRegistryExtension(pi: ExtensionAPI) {
  let runsAnimationInterval: NodeJS.Timeout | undefined;
  let runsNotifyTimeout: NodeJS.Timeout | undefined;
  let recipeReloadTimeout: NodeJS.Timeout | undefined;
  let recipeRootWatcher: FSWatcher | undefined;
  let stateRootWatcher: FSWatcher | undefined;
  const runDirWatchers = new Map<string, FSWatcher>();
  const observedRuns = new Map<string, Observability.RunObservedStatus>();
  const observedRunEventLines = new Map<string, number>();
  const observedRunOutboxEventIds = new Map<string, Set<string>>();
  const retirementAttempts = new Set<string>();
  let runStatusFrame = 0;
  let communicationWidgetVisible = false;
  let actorInspectorRows = 12;
  let actorInspectorChannels:
    | ActorInspectorTui.ActorInspectorPreview["channel"][]
    | undefined;
  let actorInspectorMention: string | undefined;
  let actorInspectorBranch: string | undefined;
  let actorInspectorUnreadOnly = false;
  let actorInspectorRoomLimitPerRun = 12;
  let selectedInspectorSequence: number | undefined;
  const actorInspectorReadKeys = new Set<string>();
  let recipeWatcherFailureNotified = false;
  const getRunOwnerId = (ctx: ExtensionContext): string =>
    ctx.sessionManager.getSessionId();
  const retireCandidateRuns = (
    ctx: ExtensionContext,
    summary: Observability.RunSummary,
  ): void => {
    void Observability.executeRunRetirements(summary, {
      attempted: retirementAttempts,
      cancelRun: (candidate) => AsyncRuns.cancelRun(candidate.stateDir),
      notify: (message, level) => ctx.ui.notify(message, level),
      sendStop: (candidate) => AsyncRuns.sendRunMessage(candidate.stateDir, "stop"),
    });
  };
  const updateRunUi = (ctx: ExtensionContext, notify = false): void => {
    const ownerId = getRunOwnerId(ctx);
    const summary = Observability.summarizeRuns(undefined, ownerId);
    const status = Observability.renderRunStatus(summary, runStatusFrame++);
    ctx.ui.setStatus(
      "zz-pi-actors-runs",
      status ? ctx.ui.theme.fg("dim", status) : undefined,
    );
    ctx.ui.setWidget(
      "zz-pi-actors-comms",
      communicationWidgetVisible
        ? () => {
            const style = {
              actor: (text: string) => ctx.ui.theme.fg("accent", text),
              muted: (text: string) => ctx.ui.theme.fg("dim", text),
              preview: (text: string) => ctx.ui.theme.fg("text", text),
              stripe: (text: string) => text,
              stripeAlt: (text: string) =>
                ctx.ui.theme.bg("customMessageBg", text),
              target: (text: string) => ctx.ui.theme.fg("success", text),
              type: (text: string) => ctx.ui.theme.fg("warning", text),
            };
            return {
              invalidate() {},
              render(width: number) {
                const previews = ActorInspectorTui.readActorInspectorPreviews(
                  RUN_STATE_ROOT,
                  actorInspectorRows,
                  {
                    channels: actorInspectorChannels,
                    currentRunOnly: true,
                    branch: actorInspectorBranch,
                    mention: actorInspectorMention,
                    ownerId,
                    readKeys: actorInspectorReadKeys,
                    roomLimitPerRun: actorInspectorRoomLimitPerRun,
                    unreadOnly: actorInspectorUnreadOnly,
                  },
                );
                const rows =
                  (selectedInspectorSequence !== undefined
                    ? ActorInspectorTui.renderInspectorItemView(
                        previews,
                        width,
                        style,
                        { sequence: selectedInspectorSequence },
                      )
                    : ActorInspectorTui.renderInspectorWidget(
                        previews,
                        width,
                        style,
                      )) ?? [];
                const run = previews[0]?.run;
                const roster =
                  selectedInspectorSequence === undefined && run
                    ? ActorInspectorTui.renderInspectorRosterPanel(
                        ActorInspectorTui.readActorInspectorRoster(
                          RUN_STATE_ROOT,
                          run,
                        ),
                        width,
                        style,
                      )
                    : undefined;
                return roster ? [...roster, ...rows] : rows;
              },
            };
          }
        : undefined,
      { placement: "belowEditor" },
    );
    const transitions = Observability.detectRunTransitions(
      observedRuns,
      summary,
    );
    const outboxEvents = Observability.detectRunOutboxEvents(
      observedRunEventLines,
      summary,
      observedRunOutboxEventIds,
    );
    if (!notify) return;
    retireCandidateRuns(ctx, summary);
    for (const transition of transitions) {
      if (!Observability.shouldNotifyRunTransition(transition)) continue;
      const text = Observability.formatRunTransitionMessage(transition);
      const notificationType =
        Observability.getRunTransitionNotificationType(transition);
      ctx.ui.notify(text, notificationType);
      if (!Observability.shouldSendRunTransitionFollowUp(transition)) continue;
      pi.sendMessage(
        {
          customType: "pi-actors-run",
          content: text,
          display: true,
          details: transition,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
    Observability.pruneRunObservationState(
      observedRuns,
      observedRunEventLines,
      summary,
      transitions.map((transition) => transition.stateDir ?? transition.run),
      observedRunOutboxEventIds,
    );
    for (const event of outboxEvents) {
      if (!Observability.shouldNotifyRunOutboxEvent(event)) continue;
      const text = Observability.formatRunOutboxMessage(event);
      const notificationType =
        Observability.getRunOutboxNotificationType(event);
      ctx.ui.notify(text, notificationType);
      if (!Observability.shouldSendRunOutboxFollowUp(event)) continue;
      pi.sendMessage(
        {
          customType: "pi-actors-run-message",
          content: text,
          display: true,
          details: event,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  };
  const closeRunWatchers = (): void => {
    stateRootWatcher?.close();
    stateRootWatcher = undefined;
    for (const watcher of runDirWatchers.values()) watcher.close();
    runDirWatchers.clear();
    if (runsNotifyTimeout) clearTimeout(runsNotifyTimeout);
    runsNotifyTimeout = undefined;
  };
  const scheduleRunEventUpdate = (ctx: ExtensionContext): void => {
    if (runsNotifyTimeout) clearTimeout(runsNotifyTimeout);
    runsNotifyTimeout = setTimeout(() => {
      refreshRunWatchers(ctx);
      updateRunUi(ctx, true);
    }, 50);
    runsNotifyTimeout.unref?.();
  };
  const watchRunDir = (ctx: ExtensionContext, stateDir: string): void => {
    if (runDirWatchers.has(stateDir) || !existsSync(stateDir)) return;
    try {
      const watcher = watch(stateDir, () => scheduleRunEventUpdate(ctx));
      watcher.on("error", () => {
        watcher.close();
        runDirWatchers.delete(stateDir);
      });
      runDirWatchers.set(stateDir, watcher);
    } catch {
      // Watching is best-effort; explicit inspect remains available.
    }
  };
  function refreshRunWatchers(ctx: ExtensionContext): void {
    if (!existsSync(RUN_STATE_ROOT)) return;
    if (!stateRootWatcher) {
      try {
        stateRootWatcher = watch(RUN_STATE_ROOT, () =>
          scheduleRunEventUpdate(ctx),
        );
        stateRootWatcher.on("error", () => {
          stateRootWatcher?.close();
          stateRootWatcher = undefined;
        });
      } catch {
        // Watching is best-effort; explicit inspect remains available.
      }
    }
    for (const entry of readdirSync(RUN_STATE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      watchRunDir(ctx, `${RUN_STATE_ROOT}/${entry.name}`);
    }
  }
  const closeRecipeWatcher = (): void => {
    recipeRootWatcher?.close();
    recipeRootWatcher = undefined;
    if (recipeReloadTimeout) clearTimeout(recipeReloadTimeout);
    recipeReloadTimeout = undefined;
  };
  const notifyRecipeWatcherFailure = (ctx: ExtensionContext): void => {
    if (recipeWatcherFailureNotified) return;
    recipeWatcherFailureNotified = true;
    ctx.ui.notify(
      "Recipe live reload watcher failed; restart the session or use register_tool again to refresh recipe tools.",
      "warning",
    );
  };
  const scheduleRecipeReload = (ctx: ExtensionContext): void => {
    recipeWatcherFailureNotified = false;
    if (recipeReloadTimeout) clearTimeout(recipeReloadTimeout);
    recipeReloadTimeout = setTimeout(() => {
      runtime.loadTools(ctx);
      ctx.ui.notify("Recipe tools refreshed from ~/.pi/agent/recipes", "info");
    }, 150);
    recipeReloadTimeout.unref?.();
  };
  const watchRecipeRoot = (ctx: ExtensionContext): void => {
    const recipeRoot = Paths.getRecipeRoot();
    if (recipeRootWatcher || !existsSync(recipeRoot)) return;
    try {
      recipeRootWatcher = watch(recipeRoot, () => scheduleRecipeReload(ctx));
      recipeRootWatcher.on("error", () => {
        recipeRootWatcher?.close();
        recipeRootWatcher = undefined;
        notifyRecipeWatcherFailure(ctx);
      });
    } catch {
      notifyRecipeWatcherFailure(ctx);
    }
  };
  const actorToolDefinitions = new Map<string, any>();
  const runtime = Runtime.createAutoToolsRuntime({
    configPath: CONFIG_PATH,
    exec: CommandTemplates.execCommandTemplate,
    getActiveTools: () => pi.getActiveTools(),
    getAllTools: () => pi.getAllTools(),
    registerTool: (definition) => {
      actorToolDefinitions.set(definition.name, definition);
      pi.registerTool(definition);
    },
    reservedToolNames: RESERVED_TOOL_NAMES,
    setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
  });
  pi.on("resources_discover", async () => {
    if (!existsSync(EXTENSION_SKILLS_DIR)) return;
    return { skillPaths: [EXTENSION_SKILLS_DIR] };
  });
  pi.on("session_start", async (_event, ctx) => {
    await Temp.prepareExtensionTempDir(TEMP_DIR);
    runtime.loadTools(ctx);
    updateRunUi(ctx);
    closeRunWatchers();
    closeRecipeWatcher();
    refreshRunWatchers(ctx);
    watchRecipeRoot(ctx);
    if (runsAnimationInterval) clearInterval(runsAnimationInterval);
    runsAnimationInterval = setInterval(() => updateRunUi(ctx, false), 1000);
    runsAnimationInterval.unref?.();
  });
  pi.on("session_shutdown", async () => {
    if (runsAnimationInterval) clearInterval(runsAnimationInterval);
    runsAnimationInterval = undefined;
    closeRunWatchers();
    closeRecipeWatcher();
  });
  pi.registerCommand("actors-inspector-toggle", {
    description: "Toggle actor inspector widget; optional row count",
    handler: async (args, ctx) => {
      const raw = Array.isArray(args) ? args[0] : String(args ?? "");
      if (String(raw).trim()) {
        const rows = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(rows) || rows <= 0) {
          ctx.ui.notify(
            "Usage: /actors-inspector-toggle [rows] where rows > 0",
            "warning",
          );
          return;
        }
        actorInspectorRows = rows;
        actorInspectorRoomLimitPerRun = rows;
        selectedInspectorSequence = undefined;
        communicationWidgetVisible = true;
        updateRunUi(ctx);
        ctx.ui.notify(`Actor inspector rows ${rows}`, "info");
        return;
      }
      if (selectedInspectorSequence !== undefined) {
        selectedInspectorSequence = undefined;
        communicationWidgetVisible = true;
        updateRunUi(ctx);
        ctx.ui.notify("Actor inspector table", "info");
        return;
      }
      if (communicationWidgetVisible) {
        communicationWidgetVisible = false;
      } else {
        actorInspectorRows = 12;
        actorInspectorRoomLimitPerRun = 12;
        communicationWidgetVisible = true;
      }
      updateRunUi(ctx);
      ctx.ui.notify(
        `Actor inspector ${communicationWidgetVisible ? "shown" : "hidden"}`,
        "info",
      );
    },
  });
  pi.registerCommand("actors-inspector-filter", {
    description:
      "Filter actor inspector rows: all, room, direct, broadcast, unread, branch <name>, mention <text>",
    handler: async (args, ctx) => {
      const parts = Array.isArray(args)
        ? args.map(String)
        : String(args ?? "").split(/\s+/);
      const mode = (parts[0] ?? "").trim().toLowerCase();
      if (!mode || mode === "all" || mode === "clear") {
        actorInspectorChannels = undefined;
        actorInspectorMention = undefined;
        actorInspectorBranch = undefined;
        actorInspectorUnreadOnly = false;
      } else if (mode === "room" || mode === "direct" || mode === "broadcast") {
        actorInspectorChannels = [mode];
        actorInspectorMention = undefined;
      } else if (mode === "unread") {
        actorInspectorUnreadOnly = true;
      } else if (mode === "branch" || mode === "current-branch") {
        const branch = parts.slice(1).join(" ").trim();
        if (!branch) {
          ctx.ui.notify(
            `Usage: /actors-inspector-filter ${mode} <branch-name>`,
            "warning",
          );
          return;
        }
        actorInspectorBranch = branch;
      } else if (mode === "mention") {
        const mention = parts.slice(1).join(" ").trim();
        if (!mention) {
          ctx.ui.notify(
            "Usage: /actors-inspector-filter mention <text>",
            "warning",
          );
          return;
        }
        actorInspectorChannels = undefined;
        actorInspectorMention = mention;
      } else {
        ctx.ui.notify(
          "Usage: /actors-inspector-filter all|room|direct|broadcast|unread|branch <name>|mention <text>",
          "warning",
        );
        return;
      }
      selectedInspectorSequence = undefined;
      communicationWidgetVisible = true;
      updateRunUi(ctx);
      ctx.ui.notify(`Actor inspector filter ${mode || "all"}`, "info");
    },
  });
  pi.registerCommand("actors-inspect", {
    description: "Inspect actor message by visible number",
    handler: async (args, ctx) => {
      const raw = Array.isArray(args) ? args[0] : String(args ?? "");
      const sequence = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(sequence) || sequence <= 0) {
        ctx.ui.notify("Usage: /actors-inspect <number>", "warning");
        return;
      }
      const previews = ActorInspectorTui.readActorInspectorPreviews(
        RUN_STATE_ROOT,
        actorInspectorRows,
        {
          channels: actorInspectorChannels,
          currentRunOnly: true,
          branch: actorInspectorBranch,
          mention: actorInspectorMention,
          ownerId: getRunOwnerId(ctx),
          readKeys: actorInspectorReadKeys,
          roomLimitPerRun: actorInspectorRoomLimitPerRun,
          unreadOnly: actorInspectorUnreadOnly,
        },
      );
      const preview = previews.find((item) => item.sequence === sequence);
      if (preview) actorInspectorReadKeys.add(ActorInspectorTui.inspectorPreviewReadKey(preview));
      selectedInspectorSequence = sequence;
      communicationWidgetVisible = true;
      updateRunUi(ctx);
      ctx.ui.notify(`Actor inspect item ${sequence}`, "info");
    },
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${Prompts.ONBOARDING_SYSTEM_PROMPT}`,
  }));
  pi.registerTool(
    Tools.createRegisterToolDefinition<ExtensionContext>({
      configPath: CONFIG_PATH,
      getActiveTools: () => pi.getActiveTools(),
      getExternalToolConflict: runtime.getExternalToolConflict,
      getTools: runtime.getTools,
      notify: runtime.notify,
      registerRuntimeTool: runtime.registerRuntimeTool,
      reservedToolNames: RESERVED_TOOL_NAMES,
      setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
    }),
  );
  pi.registerTool(Tools.createSpawnToolDefinition<ExtensionContext>());
  pi.registerTool(
    Tools.createActorMessageToolDefinition<ExtensionContext>({
      getTool: (name) => actorToolDefinitions.get(name),
    }),
  );
  pi.registerTool(
    Tools.createInspectToolDefinition<ExtensionContext>({
      getTool: (name) => actorToolDefinitions.get(name),
    }),
  );
}
