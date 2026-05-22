/**
 * Registry mutation use-cases
 * Zones: registry mutations, persistence, runtime activation
 * Owns register/update/delete validation, persistence, runtime side effects, and result payloads
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Config from "./config.ts";
import * as Identity from "./identity.ts";
import * as Output from "./output.ts";
import * as CommandTemplates from "./command-templates.ts";
import { writeJsonAtomic } from "./file-state.ts";
import * as Paths from "./paths.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as Schema from "./schema.ts";

export interface RegisterToolInput {
  name?: string;
  description?: string;
  async?: boolean;
  state_dir?: string;
  template?: CommandTemplates.CommandTemplateValue | null;
  args?: string;
  update?: boolean;
  values?: Record<string, unknown>;
}

export interface RegisterToolResultDetails {
  args?: string[];
  async?: boolean;
  config?: string;
  defaults?: Record<string, string>;
  recipeName?: string;
  state_dir?: string;
  template?: CommandTemplates.CommandTemplateValue;
  templateWarnings?: string[];
  tool: string;
}

export interface RegisterToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: RegisterToolResultDetails;
}

export interface RegisterToolRuntimeDeps<TContext> {
  configPath: string;
  recipeRoot?: string;
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
            ? `Registered tools:\n${names.map((name) => `- ${name}`).join("\n")}`
            : "No registered tools.",
        ),
      ),
    ],
    details: { tool: "register_tool" },
  };
}

function getRecipeRoot<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
): string {
  return deps.recipeRoot ?? Paths.getRecipeRoot(dirname(deps.configPath));
}

function getToolRecipePath<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
  name: string,
): string {
  return join(getRecipeRoot(deps), `${name}.json`);
}

function persistToolRecipe<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
  cfg: Config.RegisteredTool,
): string {
  const path = getToolRecipePath(deps, cfg.name);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, {
    description: cfg.description,
    tool: true,
    ...(cfg.recipe?.async !== undefined ? { async: cfg.recipe.async } : {}),
    ...(cfg.recipe?.state_dir ? { state_dir: cfg.recipe.state_dir } : {}),
    ...(cfg.storedArgs ? { args: cfg.storedArgs } : {}),
    ...(cfg.storedDefaults ? { defaults: cfg.storedDefaults } : {}),
    ...(cfg.recipe?.values ? { values: cfg.recipe.values } : {}),
    template: cfg.template,
  });
  return path;
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
  const recipePath = getToolRecipePath(deps, name);
  if (existsSync(recipePath)) unlinkSync(recipePath);
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
    details: { config: recipePath, tool: name },
  };
}

function getInputTemplate(
  value: CommandTemplates.CommandTemplateValue | null | undefined,
): CommandTemplates.CommandTemplateValue | null | undefined {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const steps = CommandTemplates.expandCommandTemplateConfigs({
      template: value,
    });
    if (steps.length === 0)
      throw new Error(
        Output.formatToolText("Tool template sequence is empty."),
      );
    return value;
  }
  throw new Error(
    Output.formatToolText("Tool template must be a string or sequence."),
  );
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
    throw new Error(
      Output.formatToolText("Tool template cannot be null here."),
    );
  }
  const finalTemplate =
    template === undefined || template === "" ? existing?.template : template;
  if (!finalTemplate) {
    throw new Error(Output.formatToolText("Tool template is required."));
  }
  const inputRecipe = typeof input.async === "boolean" ? name : undefined;
  const recipe: RecipeReferences.TemplateRecipeConfig | undefined = inputRecipe
    ? {
        name: inputRecipe,
        ...(typeof input.async === "boolean" ? { async: input.async } : {}),
        ...(typeof input.state_dir === "string" && input.state_dir.trim()
          ? { state_dir: input.state_dir.trim() }
          : {}),
        template: finalTemplate,
        ...(input.values && typeof input.values === "object"
          ? { values: input.values }
          : {}),
      }
    : template === undefined
      ? existing?.recipe
      : undefined;
  const defaults = explicitArgs?.defaults ?? existing?.storedDefaults ?? {};
  const storedArgs = explicitArgs
    ? explicitArgs.declarations
    : existing?.storedArgs;
  const storedDefaults =
    Object.keys(defaults).length > 0 ? defaults : undefined;
  const recipeTemplate = RecipeReferences.getRecipeTemplate(finalTemplate);
  const argTemplate = recipeTemplate ?? finalTemplate;
  const argTemplateConfig: CommandTemplates.CommandTemplateConfig =
    typeof argTemplate === "object" && !Array.isArray(argTemplate)
      ? {
          ...argTemplate,
          ...(storedArgs !== undefined ? { args: storedArgs } : {}),
          defaults: { ...(argTemplate.defaults ?? {}), ...defaults },
        }
      : {
          args: storedArgs,
          defaults,
          template: argTemplate,
        };
  const inferredArgTypes = Schema.getTemplateArgTypes(argTemplateConfig);
  const argTypes = {
    ...inferredArgTypes,
    ...(existing?.argTypes ?? {}),
    ...(explicitArgs?.argTypes ?? {}),
  };
  return {
    name,
    description,
    template: finalTemplate,
    ...(recipe ? { recipe } : {}),
    args:
      RecipeReferences.isRecipeTool(finalTemplate, recipe) &&
      storedArgs !== undefined
        ? Schema.getExplicitToolArgNames(storedArgs)
        : RecipeReferences.isRecipeReference(finalTemplate) && !recipeTemplate
          ? Schema.getExplicitToolArgNames(storedArgs)
          : Schema.getToolArgNames(argTemplateConfig),
    defaults,
    ...(Object.keys(argTypes).length > 0 ? { argTypes } : {}),
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
  let recipePath: string;
  try {
    recipePath = persistToolRecipe(deps, cfg);
  } catch (error) {
    throw new Error(
      Output.formatToolText(
        `Failed to persist tool recipe: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  cfg.sourcePath = recipePath;
  tools.set(name, cfg);
  deps.registerRuntimeTool(cfg);
  deps.notify(ctx, `Tool persisted: ${name}`, "info");
  const templateWarnings = CommandTemplates.getCommandTemplateWarnings(
    typeof cfg.template === "object" && !Array.isArray(cfg.template)
      ? cfg.template
      : { template: cfg.template! },
  );
  const warningText =
    templateWarnings.length > 0
      ? `\nWarnings:\n${templateWarnings.map((warning) => `- ${warning}`).join("\n")}`
      : "";
  return {
    content: [
      textContent(
        Output.formatToolText(
          `${existing ? "Updated" : "Registered"} tool "${name}" (args: ${Schema.formatToolArgs(cfg.args)}).${warningText}`,
        ),
      ),
    ],
    details: {
      args: cfg.args,
      config: recipePath,
      defaults: cfg.defaults,
      ...(cfg.recipe?.async !== undefined ? { async: cfg.recipe.async } : {}),
      ...(cfg.recipe?.name ? { recipeName: cfg.recipe.name } : {}),
      ...(cfg.recipe?.state_dir ? { state_dir: cfg.recipe.state_dir } : {}),
      ...(cfg.template ? { template: cfg.template } : {}),
      ...(templateWarnings.length > 0 ? { templateWarnings } : {}),
      tool: name,
    },
  };
}
