/**
 * Registry mutation use-cases
 * Owns register/update/delete validation, persistence, runtime side effects, and result payloads
 */

import * as Args from "./args.ts";
import * as Config from "./config.ts";
import * as Identity from "./identity.ts";
import * as Output from "./output.ts";

export interface RegisterToolInput {
  name: string;
  label?: string;
  description?: string;
  template?: string | null;
  args?: string;
  update?: boolean;
}

export interface RegisterToolRuntimeDeps<TContext> {
  configPath: string;
  getExternalToolConflict: (name: string) => string | undefined;
  getTools: () => Map<string, Config.RegisteredTool>;
  getActiveTools: () => string[];
  notify: (ctx: TContext, message: string, type: "info" | "warning" | "error") => void;
  registerRuntimeTool: (cfg: Config.RegisteredTool) => void;
  reservedToolNames: Set<string>;
  setActiveTools: (toolNames: string[]) => void;
}

function textContent(text: string) {
  return { type: "text" as const, text };
}

function deleteTool<TContext>(
  name: string,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
) {
  const tools = deps.getTools();
  if (!tools.has(name)) {
    return {
      content: [textContent(Output.formatToolText(`Tool "${name}" not found.`))],
      details: { tool: name },
    };
  }
  const nextTools = new Map(tools);
  nextTools.delete(name);
  const saveError = Config.saveTools(deps.configPath, nextTools);
  if (saveError) {
    throw new Error(
      Output.formatToolText(`Failed to persist tool deletion: ${saveError}`),
    );
  }
  tools.delete(name);
  deps.setActiveTools(deps.getActiveTools().filter((toolName) => toolName !== name));
  deps.notify(ctx, `Deleted tool: ${name}`, "info");
  return {
    content: [
      textContent(
        Output.formatToolText(
          `Deleted tool "${name}". Reload to remove it from the complete registry.`,
        ),
      ),
    ],
    details: { config: deps.configPath, tool: name },
  };
}

function buildConfig(
  name: string,
  input: RegisterToolInput,
  existing: Config.RegisteredTool | undefined,
): Config.RegisteredTool {
  const parsedArgs =
    input.args === undefined
      ? { args: existing?.args ?? [], defaults: existing?.defaults ?? {} }
      : Args.parseArgs(input.args);
  if (parsedArgs.error) throw new Error(Output.formatToolText(parsedArgs.error));
  const description = (input.description ?? existing?.description ?? "").trim();
  if (!description) {
    throw new Error(
      Output.formatToolText("Tool description is required unless deleting."),
    );
  }
  const template = typeof input.template === "string" ? input.template.trim() : input.template;
  return {
    name,
    label: input.label?.trim() || existing?.label || name,
    description,
    template: template || existing!.template,
    args: parsedArgs.args,
    defaults: parsedArgs.defaults,
  };
}

export async function executeRegisterTool<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
) {
  const input = params as RegisterToolInput;
  const name = Identity.normalizeToolName(input.name);
  if (!name) throw new Error(Output.formatToolText("Invalid tool name."));
  if (deps.reservedToolNames.has(name)) {
    throw new Error(Output.formatToolText(`Reserved tool name: ${name}`));
  }
  const templateProvided = Object.hasOwn(input, "template");
  const template = typeof input.template === "string" ? input.template.trim() : input.template;
  if (templateProvided && !template) return deleteTool(name, ctx, deps);
  const tools = deps.getTools();
  const existing = tools.get(name);
  const conflict = deps.getExternalToolConflict(name);
  if (conflict) throw new Error(Output.formatToolText(conflict));
  if (existing && !input.update) {
    throw new Error(
      Output.formatToolText(
        `Tool "${name}" already registered. Use update=true to overwrite.`,
      ),
    );
  }
  if (!template && !existing) {
    throw new Error(
      Output.formatToolText("Tool template is required for new registrations."),
    );
  }
  const cfg = buildConfig(name, input, existing);
  const nextTools = new Map(tools);
  nextTools.set(name, cfg);
  const saveError = Config.saveTools(deps.configPath, nextTools);
  if (saveError) {
    throw new Error(
      Output.formatToolText(`Failed to persist tool registration: ${saveError}`),
    );
  }
  tools.set(name, cfg);
  deps.registerRuntimeTool(cfg);
  deps.notify(ctx, `Tool persisted: ${name}`, "info");
  return {
    content: [
      textContent(
        Output.formatToolText(
          `${existing ? "Updated" : "Registered"} tool "${name}" (args: ${Args.formatArgs(cfg.args)}).`,
        ),
      ),
    ],
    details: {
      args: cfg.args,
      config: deps.configPath,
      defaults: cfg.defaults,
      template: cfg.template,
      tool: name,
    },
  };
}
