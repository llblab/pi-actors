/**
 * pi-actors — actor runtime and persistent local tool registry for pi.
 * Zones: composition root, pi agent, actor runtime
 *
 * Wraps command templates as callable pi tools, stores their definitions in actors-tools.json, and exposes actor orchestration across reloads and sessions.
 */

import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import * as CommandTemplates from "./lib/command-templates.ts";
import * as Observability from "./lib/observability.ts";
import * as Paths from "./lib/paths.ts";
import * as Prompts from "./lib/prompts.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Temp from "./lib/temp.ts";
import * as Tools from "./lib/tools.ts";

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
  let stateRootWatcher: FSWatcher | undefined;
  const runDirWatchers = new Map<string, FSWatcher>();
  const observedRuns = new Map<string, Observability.RunObservedStatus>();
  const observedRunEventLines = new Map<string, number>();
  let runStatusFrame = 0;
  const getRunOwnerId = (ctx: ExtensionContext): string =>
    ctx.sessionManager.getSessionId();
  const updateRunUi = (ctx: ExtensionContext, notify = false): void => {
    const ownerId = getRunOwnerId(ctx);
    const summary = Observability.summarizeRuns(undefined, ownerId);
    const status = Observability.renderRunStatus(summary, runStatusFrame++);
    ctx.ui.setStatus(
      "zz-pi-actors-runs",
      status ? ctx.ui.theme.fg("dim", status) : undefined,
    );
    ctx.ui.setWidget("zz-pi-actors-runs", undefined);
    const transitions = Observability.detectRunTransitions(
      observedRuns,
      summary,
    );
    const outboxEvents = Observability.detectRunOutboxEvents(
      observedRunEventLines,
      summary,
    );
    if (!notify) return;
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
        stateRootWatcher = watch(RUN_STATE_ROOT, () => scheduleRunEventUpdate(ctx));
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
  const actorToolDefinitions = new Map<string, any>();
  const runtime = Runtime.createAutoToolsRuntime({
    configPath: CONFIG_PATH,
    exec: CommandTemplates.execCommandTemplate,
    getAllTools: () => pi.getAllTools(),
    registerTool: (definition) => {
      actorToolDefinitions.set(definition.name, definition);
      pi.registerTool(definition);
    },
    reservedToolNames: RESERVED_TOOL_NAMES,
  });
  pi.on("session_start", async (_event, ctx) => {
    await Temp.prepareExtensionTempDir(TEMP_DIR);
    runtime.loadTools(ctx);
    updateRunUi(ctx);
    closeRunWatchers();
    refreshRunWatchers(ctx);
    if (runsAnimationInterval) clearInterval(runsAnimationInterval);
    runsAnimationInterval = setInterval(() => updateRunUi(ctx, false), 1000);
    runsAnimationInterval.unref?.();
  });
  pi.on("session_shutdown", async () => {
    if (runsAnimationInterval) clearInterval(runsAnimationInterval);
    runsAnimationInterval = undefined;
    closeRunWatchers();
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
  pi.registerTool(Tools.createInspectToolDefinition());
}
