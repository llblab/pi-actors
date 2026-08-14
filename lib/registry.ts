/**
 * Registry mutation use-cases
 * Zones: registry mutations, persistence, runtime activation
 * Owns register/update/delete validation, persistence, runtime side effects, and result payloads
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import * as CommandTemplates from "./command-templates.ts";
import * as Config from "./config.ts";
import * as ExecutionOutput from "./execution-output.ts";
import {
  withFileMutationLock,
  writeJsonAtomic,
  writeTextAtomic,
} from "./file-state.ts";
import * as Identity from "./identity.ts";
import * as Paths from "./paths.ts";
import * as RecipesContext from "./recipes-context.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as Schema from "./schema.ts";

export interface RegisterToolInput {
  name?: string;
  description?: string;
  async?: boolean;
  template?: CommandTemplates.CommandTemplateValue | null;
  draft?: string;
  args?: string;
  update?: boolean;
  values?: Record<string, unknown>;
}

export interface RegisterToolResultDetails {
  active_tool?: boolean;
  activation?: "current_session" | "unverified";
  args?: string[];
  async?: boolean;
  callable_now?: boolean;
  config?: string;
  defaults?: Record<string, string>;
  draft?: string;
  host_registered?: boolean;
  persisted?: boolean;
  promoted?: boolean;
  registry_active?: boolean;
  resolved?: boolean;
  recipeName?: string;
  template?: CommandTemplates.CommandTemplateValue;
  templateWarnings?: string[];
  tool: string;
  validated?: boolean;
}

export interface RegisterToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: RegisterToolResultDetails;
}

export interface RegisterToolRuntimeDeps<TContext> {
  configPath: string;
  recipeRoot?: string;
  getToolNameBlocker: (name: string) => string | undefined;
  getTools: () => Map<string, Config.RegisteredTool>;
  getActiveTools: () => string[];
  notify: (
    ctx: TContext,
    message: string,
    type: "info" | "warning" | "error",
  ) => void;
  registerRuntimeTool: (cfg: Config.RegisteredTool) =>
    | {
        active_tool: boolean;
        activation: "current_session" | "unverified";
        callable_now: boolean;
        host_registered: boolean;
      }
    | void;
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
        ExecutionOutput.formatToolText(
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

function assertDraftPath<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
  draft: string,
): string {
  const draftRoot = resolve(getRecipeRoot(deps), "drafts");
  const path = resolve(draft);
  const relation = relative(draftRoot, path);
  if (
    relation === "" ||
    relation.startsWith("..") ||
    resolve(relation) === relation
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(
        `Draft must be under ${draftRoot}. Use inspect target=recipes view=summary to list drafts.`,
      ),
    );
  }
  if (!existsSync(path)) {
    throw new Error(ExecutionOutput.formatToolText(`Draft not found: ${path}`));
  }
  return path;
}

function promoteDraftRecipe<TContext>(
  name: string,
  input: RegisterToolInput,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  const draftPath = assertDraftPath(deps, String(input.draft ?? ""));
  const targetPath = getToolRecipePath(deps, name);
  const tools = deps.getTools();
  const existing = tools.get(name);
  const blocker = deps.getToolNameBlocker(name);
  if (blocker) throw new Error(ExecutionOutput.formatToolText(blocker));
  if ((existing || existsSync(targetPath)) && !input.update) {
    throw new Error(
      ExecutionOutput.formatToolText(
        `Tool "${name}" already registered. Use update=true to overwrite.`,
      ),
    );
  }
  const raw = RecipesReferences.readRawRecipeConfig(draftPath);
  if (!raw) {
    const reason = RecipesReferences.diagnoseRawRecipeConfigFailure(draftPath);
    throw new Error(
      ExecutionOutput.formatToolText(
        `Draft recipe is invalid${reason ? `: ${reason}` : "."}`,
      ),
    );
  }
  const authoredRecipe = buildAuthoredRecipe(
    {
      ...input,
      description:
        input.description ??
        (typeof raw.description === "string" ? raw.description : undefined),
    },
    existing,
    raw,
  );
  const resolutionContext = getRegistrationResolutionContext(ctx, deps);
  const candidate = RecipesDiscovery.admitUserRecipe(
    targetPath,
    resolutionContext,
    authoredRecipe,
  );
  if (!candidate.validated || !candidate.tool) {
    throw new Error(
      ExecutionOutput.formatToolText(
        `Draft recipe is invalid: ${candidate.diagnostics.join("; ")}`,
      ),
    );
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeJsonAtomic(targetPath, authoredRecipe);
  const promoted = RecipesDiscovery.admitUserRecipe(
    targetPath,
    resolutionContext,
  ).tool!;
  tools.set(name, promoted);
  deps.registerRuntimeTool(promoted);
  deps.notify(ctx, `Promoted draft recipe: ${name}`, "info");
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          `${existing ? "Updated" : "Registered"} tool "${name}" from draft recipe.`,
        ),
      ),
    ],
    details: {
      args: promoted.args,
      config: targetPath,
      draft: draftPath,
      promoted: true,
      tool: name,
    } as RegisterToolResultDetails & Record<string, unknown>,
  };
}

function persistToolRecipe<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
  name: string,
  recipe: Record<string, unknown>,
): string {
  const path = getToolRecipePath(deps, name);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, recipe);
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
        textContent(
          ExecutionOutput.formatToolText(`Tool "${name}" not found.`),
        ),
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
        ExecutionOutput.formatToolText(
          `Deleted tool "${name}". Reload to remove it from the complete registry.`,
        ),
      ),
    ],
    details: { config: recipePath, tool: name },
  };
}

function readAuthoritativeStoredTool<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
  name: string,
): {
  bytes?: string;
  exists: boolean;
  recipe?: Record<string, unknown>;
  tool?: Config.RegisteredTool;
} {
  const path = getToolRecipePath(deps, name);
  if (!existsSync(path)) return { exists: false };
  try {
    const bytes = readFileSync(path, "utf8");
    const recipe = JSON.parse(bytes);
    const normalized = Config.normalizeStoredTool(
      name,
      recipe,
      deps.reservedToolNames,
    );
    if (!normalized.cfg) return { bytes, exists: true, recipe };
    return {
      bytes,
      exists: true,
      recipe,
      tool: { ...normalized.cfg, sourcePath: path },
    };
  } catch {
    return { exists: true };
  }
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
        ExecutionOutput.formatToolText("Tool template sequence is empty."),
      );
    return value;
  }
  if (value && typeof value === "object") {
    CommandTemplates.expandCommandTemplateConfigs(
      value as CommandTemplates.CommandTemplateConfig,
    );
    return value as CommandTemplates.CommandTemplateConfig;
  }
  throw new Error(
    ExecutionOutput.formatToolText(
      "Tool template must be a string, object, or sequence.",
    ),
  );
}

function getRegistrationResolutionContext<TContext>(
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RecipesContext.RecipeResolutionContext {
  if (
    ctx &&
    typeof ctx === "object" &&
    "recipeResolutionContext" in ctx
  ) {
    const resolutionContext = (ctx as {
      recipeResolutionContext?: RecipesContext.RecipeResolutionContext;
    }).recipeResolutionContext;
    if (resolutionContext) return resolutionContext;
  }
  return RecipesContext.createEmptyRecipeResolutionContext(
    "offline-register-tool",
    getRecipeRoot(deps),
  );
}

function buildAuthoredRecipe(
  input: RegisterToolInput,
  existing: Config.RegisteredTool | undefined,
  existingRecipe: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const explicitArgs =
    input.args === undefined
      ? undefined
      : Schema.parseToolArgDeclarations(input.args);
  if (explicitArgs?.error)
    throw new Error(ExecutionOutput.formatToolText(explicitArgs.error));
  const description = (input.description ?? existing?.description ?? "").trim();
  if (!description) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Tool description is required unless deleting.",
      ),
    );
  }
  const template = getInputTemplate(input.template);
  if (template === null) {
    throw new Error(
      ExecutionOutput.formatToolText("Tool template cannot be null here."),
    );
  }
  const finalTemplate =
    template === undefined || template === ""
      ? existingRecipe?.template ?? existing?.template
      : template;
  if (!finalTemplate) {
    throw new Error(
      ExecutionOutput.formatToolText("Tool template is required."),
    );
  }
  const authored: Record<string, unknown> = {
    ...(existingRecipe ?? {}),
    description,
    template: finalTemplate,
  };
  if (typeof input.async === "boolean") authored.async = input.async;
  if (explicitArgs) {
    authored.args = explicitArgs.declarations;
    if (Object.keys(explicitArgs.defaults).length > 0)
      authored.defaults = explicitArgs.defaults;
    else delete authored.defaults;
  }
  if (input.values && typeof input.values === "object")
    authored.values = input.values;
  return authored;
}

function executeRegisterToolUnlocked<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  const input = params as RegisterToolInput;
  if (!input.name) return listTools(deps);
  const name = Identity.normalizeToolName(input.name);
  if (!name)
    throw new Error(ExecutionOutput.formatToolText("Invalid tool name."));
  if (deps.reservedToolNames.has(name)) {
    throw new Error(
      ExecutionOutput.formatToolText(`Reserved tool name: ${name}`),
    );
  }
  if (typeof input.draft === "string" && input.draft.trim()) {
    return promoteDraftRecipe(name, input, ctx, deps);
  }
  const templateProvided = Object.hasOwn(input, "template");
  const template = getInputTemplate(input.template);
  if (templateProvided && (template === null || template === ""))
    return deleteTool(name, ctx, deps);
  const tools = deps.getTools();
  const authoritative = readAuthoritativeStoredTool(deps, name);
  const existing = authoritative.tool ?? tools.get(name);
  const blocker = deps.getToolNameBlocker(name);
  if (blocker) throw new Error(ExecutionOutput.formatToolText(blocker));
  if ((authoritative.exists || existing) && !input.update) {
    throw new Error(
      ExecutionOutput.formatToolText(
        `Tool "${name}" already registered. Use update=true to overwrite.`,
      ),
    );
  }
  if (template === undefined && !existing) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Tool template is required for new registrations.",
      ),
    );
  }
  const recipePath = getToolRecipePath(deps, name);
  const authoredRecipe = buildAuthoredRecipe(
    input,
    existing,
    authoritative.recipe,
  );
  const resolutionContext = getRegistrationResolutionContext(ctx, deps);
  const candidate = RecipesDiscovery.admitUserRecipe(
    recipePath,
    resolutionContext,
    authoredRecipe,
  );
  if (!candidate.validated || !candidate.tool) {
    throw new Error(
      ExecutionOutput.formatToolText(
        `Tool recipe validation failed: ${candidate.diagnostics.join("; ")}`,
      ),
    );
  }
  const activeBefore = deps.getActiveTools();
  let persisted = false;
  let activation:
    | {
        active_tool: boolean;
        activation: "current_session" | "unverified";
        callable_now: boolean;
        host_registered: boolean;
      }
    | undefined;
  let cfg: Config.RegisteredTool;
  try {
    persistToolRecipe(deps, name, authoredRecipe);
    persisted = true;
    const admitted = RecipesDiscovery.admitUserRecipe(
      recipePath,
      resolutionContext,
    );
    if (!admitted.validated || !admitted.tool) {
      throw new Error(
        `Persisted tool recipe admission failed: ${admitted.diagnostics.join("; ")}`,
      );
    }
    cfg = admitted.tool;
    tools.set(name, cfg);
    activation = deps.registerRuntimeTool(cfg) ?? undefined;
    if (
      activation &&
      (!activation.host_registered ||
        !activation.active_tool ||
        !activation.callable_now)
    ) {
      throw new Error(
        `Host activation verification failed: ${JSON.stringify(activation)}`,
      );
    }
  } catch (error) {
    if (persisted) {
      if (authoritative.bytes !== undefined)
        writeTextAtomic(recipePath, authoritative.bytes);
      else if (existsSync(recipePath)) unlinkSync(recipePath);
    }
    if (existing) {
      tools.set(name, existing);
      deps.registerRuntimeTool(existing);
    } else {
      tools.delete(name);
    }
    deps.setActiveTools(activeBefore);
    throw new Error(
      ExecutionOutput.formatToolText(
        `Tool registration transaction failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  deps.notify(ctx, `Tool activated: ${name}`, "info");
  const templateWarnings = CommandTemplates.getCommandTemplateWarnings(
    typeof cfg.recipe?.template === "object" && !Array.isArray(cfg.recipe.template)
      ? cfg.recipe.template
      : { template: cfg.recipe?.template ?? cfg.template! },
  );
  const warningText =
    templateWarnings.length > 0
      ? `\nWarnings:\n${templateWarnings.map((warning) => `- ${warning}`).join("\n")}`
      : "";
  const outcomeText = activation?.callable_now
    ? `${existing ? "Updated" : "Registered"} and activated tool "${name}"`
    : `Persisted tool "${name}"; current-session activation is unverified`;
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          `${outcomeText} (args: ${Schema.formatToolArgs(cfg.args)}).${warningText}`,
        ),
      ),
    ],
    details: {
      active_tool: activation?.active_tool ?? false,
      activation: activation?.activation ?? "unverified",
      args: cfg.args,
      callable_now: activation?.callable_now ?? false,
      config: recipePath,
      defaults: cfg.defaults,
      host_registered: activation?.host_registered ?? false,
      persisted: true,
      registry_active: tools.get(name) === cfg,
      resolved: true,
      ...(cfg.recipe?.async !== undefined ? { async: cfg.recipe.async } : {}),
      ...(cfg.recipe?.name ? { recipeName: cfg.recipe.name } : {}),
      ...(cfg.template ? { template: cfg.template } : {}),
      ...(templateWarnings.length > 0 ? { templateWarnings } : {}),
      tool: name,
      validated: true,
    },
  };
}

export async function executeRegisterTool<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): Promise<RegisterToolResult> {
  const input = params as RegisterToolInput;
  if (!input.name) return executeRegisterToolUnlocked(params, ctx, deps);
  const name = Identity.normalizeToolName(input.name);
  if (!name) return executeRegisterToolUnlocked(params, ctx, deps);
  return withFileMutationLock(getToolRecipePath(deps, name), () =>
    executeRegisterToolUnlocked(params, ctx, deps),
  );
}
