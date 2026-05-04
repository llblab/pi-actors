/**
 * pi-auto-tools — persistent self-registered agent tools.
 *
 * Wraps command templates as callable pi tools and stores their definitions in
 * auto-tools.json across reloads and sessions.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import * as Paths from "./lib/paths.ts";
import * as Runtime from "./lib/runtime.ts";
import * as CommandTemplates from "./lib/command-templates.ts";
import * as Tools from "./lib/tools.ts";

const CONFIG_PATH = Paths.getConfigPath();
const RESERVED_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "register_tool",
  "write",
]);

export default function toolRegistryExtension(pi: ExtensionAPI) {
  const runtime = Runtime.createAutoToolsRuntime({
    configPath: CONFIG_PATH,
    exec: CommandTemplates.execCommandTemplate,
    getAllTools: () => pi.getAllTools(),
    registerTool: (definition) => pi.registerTool(definition),
    reservedToolNames: RESERVED_TOOL_NAMES,
  });
  pi.on("session_start", (_event, ctx) => runtime.loadTools(ctx));
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
}
