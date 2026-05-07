/**
 * pi-auto-tools — persistent self-registered agent tools.
 * Zones: composition root, pi agent, automation runtime
 *
 * Wraps command templates as callable pi tools and stores their definitions in auto-tools.json across reloads and sessions.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

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
  "template_job",
]);

export default function toolRegistryExtension(pi: ExtensionAPI) {
  let jobsInterval: NodeJS.Timeout | undefined;
  const observedJobs = new Map<string, Observability.JobObservedStatus>();
  let jobStatusFrame = 0;
  const updateJobUi = (ctx: ExtensionContext, notify = false): void => {
    const summary = Observability.summarizeJobs();
    const status = Observability.renderJobStatus(summary, jobStatusFrame++);
    ctx.ui.setStatus(
      "zz-pi-auto-tools-jobs",
      status ? ctx.ui.theme.fg("dim", status) : undefined,
    );
    ctx.ui.setWidget("zz-pi-auto-tools-jobs", undefined);
    if (!notify) return;
    for (const transition of Observability.detectJobTransitions(
      observedJobs,
      summary,
    )) {
      const text = Observability.formatJobTransitionMessage(transition);
      ctx.ui.notify(text, transition.to === "done" ? "info" : "error");
      pi.sendMessage(
        {
          customType: "pi-auto-tools-job",
          content: text,
          display: true,
          details: transition,
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
    updateJobUi(ctx);
    if (jobsInterval) clearInterval(jobsInterval);
    jobsInterval = setInterval(() => updateJobUi(ctx, true), 250);
    jobsInterval.unref?.();
  });
  pi.on("session_shutdown", async () => {
    if (jobsInterval) clearInterval(jobsInterval);
    jobsInterval = undefined;
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
    Tools.createJobToolDefinition<ExtensionContext>({
      getTools: runtime.getTools,
    }),
  );
}
