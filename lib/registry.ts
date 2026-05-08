/**
 * Registry mutation use-cases
 * Zones: registry mutations, persistence, runtime activation
 * Owns register/update/delete validation, persistence, runtime side effects, and result payloads
 */

import * as Config from "./config.ts";
import * as Identity from "./identity.ts";
import * as Output from "./output.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as JobReferences from "./job-references.ts";
import * as Schema from "./schema.ts";

export interface RegisterToolInput {
  name?: string;
  description?: string;
  job?: string;
  state_dir?: string;
  stateDir?: string;
  template?: CommandTemplates.CommandTemplateValue | null;
  args?: string;
  update?: boolean;
  values?: Record<string, unknown>;
}

export interface RegisterToolResultDetails {
  args?: string[];
  config?: string;
  defaults?: Record<string, string>;
  job?: string;
  state_dir?: string;
  template?: CommandTemplates.CommandTemplateValue;
  tool: string;
}

export interface RegisterToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: RegisterToolResultDetails;
}

export interface RegisterToolRuntimeDeps<TContext> {
  configPath: string;
  getExternalToolConflict: (name: string) => string | undefined;
  getTools: () => Map<string, Config.RegisteredTool>;
  getActiveTools: () => string[];
  notify: (
    ctx: TContext,
    message: string,
    type: "info" | "warning" | "error",
  ) => void;
  registerRuntimeTool: (cfg: Config.RegisteredTool) => void;
  reservedToolNames: Set<string>;
  setActiveTools: (toolNames: string[]) => void;
}

function textContent(text: string) {
  return { type: "text" as const, text };
}

function listTools<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  const names = [...deps.getTools().keys()].sort();
  return {
    content: [
      textContent(
        Output.formatToolText(
          names.length > 0
            ? `Registered auto-tools:\n${names.map((name) => `- ${name}`).join("\n")}`
            : "No registered auto-tools.",
        ),
      ),
    ],
    details: { tool: "register_tool" },
  };
}

function deleteTool<TContext>(
  name: string,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  const tools = deps.getTools();
  if (!tools.has(name)) {
    return {
      content: [
        textContent(Output.formatToolText(`Tool "${name}" not found.`)),
      ],
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
  deps.setActiveTools(
    deps.getActiveTools().filter((toolName) => toolName !== name),
  );
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

function getInputTemplate(
  value: CommandTemplates.CommandTemplateValue | null | undefined,
): CommandTemplates.CommandTemplateValue | null | undefined {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const steps = CommandTemplates.expandCommandTemplateConfigs({ template: value });
    if (steps.length === 0)
      throw new Error(Output.formatToolText("Tool template sequence is empty."));
    return value;
  }
  throw new Error(Output.formatToolText("Tool template must be a string or sequence."));
}

function buildConfig(
  name: string,
  input: RegisterToolInput,
  existing: Config.RegisteredTool | undefined,
): Config.RegisteredTool {
  const explicitArgs =
    input.args === undefined
      ? undefined
      : Schema.parseToolArgDeclarations(input.args);
  if (explicitArgs?.error)
    throw new Error(Output.formatToolText(explicitArgs.error));
  const description = (input.description ?? existing?.description ?? "").trim();
  if (!description) {
    throw new Error(
      Output.formatToolText("Tool description is required unless deleting."),
    );
  }
  const template = getInputTemplate(input.template);
  if (template === null) {
    throw new Error(Output.formatToolText("Tool template cannot be null here."));
  }
  const finalTemplate = template === undefined || template === "" ? existing?.template : template;
  if (!finalTemplate) {
    throw new Error(Output.formatToolText("Tool template is required."));
  }
  const inputJob = typeof input.job === "string" && input.job.trim()
    ? input.job.trim()
    : undefined;
  const jobRecipe = inputJob
    ? {
      job: inputJob,
      ...(typeof input.state_dir === "string" && input.state_dir.trim() ? { state_dir: input.state_dir.trim() } : {}),
      ...(typeof input.stateDir === "string" && input.stateDir.trim() ? { stateDir: input.stateDir.trim() } : {}),
      template: finalTemplate,
      ...(input.values && typeof input.values === "object" ? { values: input.values } : {}),
    }
    : template === undefined
      ? existing?.jobRecipe
      : undefined;
  const defaults = explicitArgs?.defaults ?? existing?.storedDefaults ?? {};
  const storedArgs = explicitArgs ? explicitArgs.args : existing?.storedArgs;
  const storedDefaults =
    Object.keys(defaults).length > 0 ? defaults : undefined;
  const recipeTemplate = JobReferences.getJobRecipeTemplate(finalTemplate);
  const argTemplate = recipeTemplate ?? finalTemplate;
  return {
    name,
    description,
    template: finalTemplate,
    ...(jobRecipe ? { jobRecipe } : {}),
    args: JobReferences.isJobRecipeTool(finalTemplate, jobRecipe) && storedArgs !== undefined
      ? Schema.getExplicitToolArgNames(storedArgs)
      : JobReferences.isJobRecipeReference(finalTemplate) && !recipeTemplate
        ? Schema.getExplicitToolArgNames(storedArgs)
        : Schema.getToolArgNames({
        args: storedArgs,
        defaults,
        template: argTemplate,
      }),
    defaults,
    ...(storedArgs !== undefined ? { storedArgs } : {}),
    ...(storedDefaults !== undefined ? { storedDefaults } : {}),
  };
}

export async function executeRegisterTool<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): Promise<RegisterToolResult> {
  const input = params as RegisterToolInput;
  if (!input.name) return listTools(deps);
  const name = Identity.normalizeToolName(input.name);
  if (!name) throw new Error(Output.formatToolText("Invalid tool name."));
  if (deps.reservedToolNames.has(name)) {
    throw new Error(Output.formatToolText(`Reserved tool name: ${name}`));
  }
  const templateProvided = Object.hasOwn(input, "template");
  const template = getInputTemplate(input.template);
  if (templateProvided && (template === null || template === ""))
    return deleteTool(name, ctx, deps);
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
  if (template === undefined && !existing) {
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
      Output.formatToolText(
        `Failed to persist tool registration: ${saveError}`,
      ),
    );
  }
  tools.set(name, cfg);
  deps.registerRuntimeTool(cfg);
  deps.notify(ctx, `Tool persisted: ${name}`, "info");
  return {
    content: [
      textContent(
        Output.formatToolText(
          `${existing ? "Updated" : "Registered"} tool "${name}" (args: ${Schema.formatToolArgs(cfg.args)}).`,
        ),
      ),
    ],
    details: {
      args: cfg.args,
      config: deps.configPath,
      defaults: cfg.defaults,
      ...(cfg.jobRecipe?.job ? { job: cfg.jobRecipe.job } : {}),
      ...(cfg.jobRecipe?.state_dir ? { state_dir: cfg.jobRecipe.state_dir } : {}),
      ...(cfg.template ? { template: cfg.template } : {}),
      tool: name,
    },
  };
}
