/**
 * pi-auto-tools — persistent self-registered agent tools.
 * Zones: composition root, pi agent, automation runtime
 *
 * Wraps command templates as callable pi tools and stores their definitions in auto-tools.json across reloads and sessions.
 */

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
const RESERVED_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
  "register_tool",
  "async_run",
]);

export default function toolRegistryExtension(pi: ExtensionAPI) {
  let runsInterval: NodeJS.Timeout | undefined;
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
      "zz-pi-auto-tools-runs",
      status ? ctx.ui.theme.fg("dim", status) : undefined,
    );
    ctx.ui.setWidget("zz-pi-auto-tools-runs", undefined);
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
      const text = Observability.formatRunTransitionMessage(transition);
      const notificationType = Observability.getRunTransitionNotificationType(transition);
      ctx.ui.notify(text, notificationType);
      if (!Observability.shouldSendRunTransitionFollowUp(transition)) continue;
      pi.sendMessage(
        {
          customType: "pi-auto-tools-run",
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
      const notificationType = Observability.getRunOutboxNotificationType(event);
      ctx.ui.notify(text, notificationType);
      if (!Observability.shouldSendRunOutboxFollowUp(event)) continue;
      pi.sendMessage(
        {
          customType: "pi-auto-tools-run-event",
          content: text,
          display: true,
          details: event,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  };
  const runtime = Runtime.createAutoToolsRuntime({
    configPath: CONFIG_PATH,
    exec: CommandTemplates.execCommandTemplate,
    getAllTools: () => pi.getAllTools(),
    registerTool: (definition) => pi.registerTool(definition),
    reservedToolNames: RESERVED_TOOL_NAMES,
  });
  pi.on("session_start", async (_event, ctx) => {
    await Temp.prepareExtensionTempDir(TEMP_DIR);
    runtime.loadTools(ctx);
    updateRunUi(ctx);
    if (runsInterval) clearInterval(runsInterval);
    runsInterval = setInterval(() => updateRunUi(ctx, true), 250);
    runsInterval.unref?.();
  });
  pi.on("session_shutdown", async () => {
    if (runsInterval) clearInterval(runsInterval);
    runsInterval = undefined;
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
  pi.registerTool(
    Tools.createAsyncRunToolDefinition<ExtensionContext>(),
  );
}
