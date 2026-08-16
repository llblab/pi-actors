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
  from?: string;
  defaults?: Record<string, unknown>;
  draft?: string;
  args?: string;
  update?: boolean;
}

export interface RegisterToolResultDetails {
  active_tool?: boolean;
  activation?: "current_session" | "unverified";
  activation_boundary?: string;
  args?: string[];
  async?: boolean;
  callable_now?: boolean;
  defaults?: Record<string, string>;
  host_registered?: boolean;
  next_actions?: string[];
  optional_args?: string[];
  persisted?: boolean;
  promoted?: boolean;
  registry_active?: boolean;
  required_args?: string[];
  resolved?: boolean;
  source?: string;
  templateWarnings?: string[];
  tool: string;
  validated?: boolean;
}

export interface RegisterToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: RegisterToolResultDetails;
}

interface RuntimeActivation {
  active_tool: boolean;
  activation: "current_session" | "unverified";
  callable_now: boolean;
  host_registered: boolean;
}

export interface RegisterToolRuntimeDeps<TContext> {
  configPath: string;
  recipeRoot?: string;
  getToolNameBlocker: (name: string) => string | undefined;
  getTools: () => Map<string, Config.RegisteredTool>;
  getRecipeResolutionContext?: () => RecipesContext.RecipeResolutionContext | undefined;
  getActiveTools: () => string[];
  notify: (
    ctx: TContext,
    message: string,
    type: "info" | "warning" | "error",
  ) => void;
  registerRuntimeTool: (cfg: Config.RegisteredTool) => RuntimeActivation | void;
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

function activationBoundary(
  activation: RuntimeActivation | undefined,
): string {
  if (activation?.callable_now) return "current_session";
  if (!activation) return "session_activation_unverified";
  if (!activation.host_registered) return "host_registration";
  if (!activation.active_tool) return "active_tool_set";
  return "callability_verification";
}

function recipeDoctorAction(source: string): string {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(source)
    ? `inspect target=recipes view=doctor identity=${source}`
    : "inspect target=recipes view=doctor";
}

function registrationNextActions(
  tool: string,
  source: string,
  callableNow: boolean,
): string[] {
  if (callableNow) {
    return [
      `call tool ${tool}`,
      `inspect target=tool:${tool} view=status`,
    ];
  }
  return [
    `inspect target=tool:${tool} view=status`,
    ...(source === "template" || source === "draft"
      ? []
      : [recipeDoctorAction(source)]),
  ];
}

function activeSkillSummary(
  resolutionContext: RecipesContext.RecipeResolutionContext,
): string {
  const names = Object.keys(
    RecipesReferences.getActiveSkillRecipeNamespaces(
      resolutionContext.activeSkills,
    ),
  )
    .sort()
    .slice(0, 20);
  return names.length > 0 ? names.join(", ") : "<none>";
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
  const activation = deps.registerRuntimeTool(promoted) ?? undefined;
  const argSummary = RecipesDiscovery.summarizeRegisteredToolArgs(promoted);
  const callableNow = activation?.callable_now ?? false;
  const nextActions = registrationNextActions(name, "draft", callableNow);
  deps.notify(ctx, `Promoted draft recipe: ${name}`, "info");
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          `${existing ? "Updated" : "Registered"} tool "${name}" from draft; callable_now=${callableNow}; next=${nextActions[0]}.`,
        ),
      ),
    ],
    details: {
      active_tool: activation?.active_tool ?? false,
      activation: activation?.activation ?? "unverified",
      activation_boundary: activationBoundary(activation),
      args: promoted.args,
      callable_now: callableNow,
      defaults: promoted.defaults,
      host_registered: activation?.host_registered ?? false,
      next_actions: nextActions,
      optional_args: argSummary.optional,
      persisted: true,
      promoted: true,
      registry_active: tools.get(name) === promoted,
      required_args: argSummary.required,
      resolved: true,
      source: "draft",
      tool: name,
      validated: true,
    },
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
    details: { tool: name },
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

function looksLikeRecipeReference(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.endsWith(".json") ||
    trimmed.endsWith(".md") ||
    /^[^/:\\]+\/[^/:\\]+$/.test(trimmed)
  );
}

function assertTemplateIsNotNestedRecipe(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.template === "string" &&
    looksLikeRecipeReference(record.template) &&
    (Object.keys(record).length === 1 ||
      ["artifacts", "async", "control", "description", "imports", "values"].some(
        (key) => Object.hasOwn(record, key),
      ))
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Nested Recipe-shaped templates are not a register_tool source mode. Next: retry with from=<skill>/<recipe> and defaults={...}.",
      ),
    );
  }
}

function getInputTemplate(
  value: CommandTemplates.CommandTemplateValue | null | undefined,
): CommandTemplates.CommandTemplateValue | null | undefined {
  assertTemplateIsNotNestedRecipe(value);
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
  const runtimeContext = deps.getRecipeResolutionContext?.();
  if (runtimeContext) return runtimeContext;
  if (ctx && typeof ctx === "object" && "recipeResolutionContext" in ctx) {
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

function normalizeDefaults(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      ExecutionOutput.formatToolText("Tool defaults must be an object."),
    );
  }
  return { ...(value as Record<string, unknown>) };
}

function normalizeFromReference(
  value: string,
  resolutionContext: RecipesContext.RecipeResolutionContext,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Tool from must be a non-empty Recipe reference. Next: retry register_tool with from=<skill>/<recipe> or an explicit .json/.md path.",
      ),
    );
  }
  if (trimmed.startsWith("std:")) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "std: Recipe references were removed; use <skill>/<recipe> or an explicit .json/.md file path.",
      ),
    );
  }
  if (trimmed.startsWith("skill:")) {
    throw new Error(
      ExecutionOutput.formatToolText(
        `skill: Recipe references were removed; use ${trimmed.slice("skill:".length)} without a prefix.`,
      ),
    );
  }
  if (trimmed.endsWith(".json") || trimmed.endsWith(".md")) {
    return resolve(resolutionContext.cwd, trimmed);
  }
  if (!looksLikeRecipeReference(trimmed)) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Tool from must use <skill>/<recipe> or an explicit .json/.md file path.",
      ),
    );
  }
  return trimmed;
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
  const from = typeof input.from === "string" ? input.from.trim() : "";
  const description = (input.description ?? existing?.description ?? "").trim();
  if (!description && !from) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Tool description is required for command-template registration.",
      ),
    );
  }
  const inputDefaults = normalizeDefaults(input.defaults);
  if (from) {
    const runtimeOwnedDefault = Object.keys(inputDefaults ?? {}).find((key) =>
      RecipesReferences.isRuntimeOwnedRecipeInput(key),
    );
    if (runtimeOwnedDefault) {
      throw new Error(
        ExecutionOutput.formatToolText(
          `Tool defaults cannot set runtime-owned input: ${runtimeOwnedDefault}. Next: remove that default and retry register_tool; the runtime supplies it.`,
        ),
      );
    }
    const authored: Record<string, unknown> = {
      ...(description ? { description } : {}),
      template: from,
    };
    const retainedDefaults =
      inputDefaults ??
      (existingRecipe?.defaults && typeof existingRecipe.defaults === "object"
        ? (existingRecipe.defaults as Record<string, unknown>)
        : undefined);
    if (retainedDefaults && Object.keys(retainedDefaults).length > 0)
      authored.defaults = retainedDefaults;
    return authored;
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
    const defaults = { ...explicitArgs.defaults, ...(inputDefaults ?? {}) };
    if (Object.keys(defaults).length > 0) authored.defaults = defaults;
    else delete authored.defaults;
  } else if (inputDefaults !== undefined) {
    if (Object.keys(inputDefaults).length > 0) authored.defaults = inputDefaults;
    else delete authored.defaults;
  }
  return authored;
}

function assertRegisterToolInputModes(input: RegisterToolInput): void {
  const record = input as RegisterToolInput & Record<string, unknown>;
  if (Object.hasOwn(record, "values")) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "register_tool values was removed. Next: retry register_tool with defaults for caller inputs, or use from=<skill>/<recipe> for maintained composition.",
      ),
    );
  }
  const fromProvided = Object.hasOwn(record, "from");
  if (
    fromProvided &&
    (typeof input.from !== "string" || input.from.trim().length === 0)
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Tool from must be a non-empty Recipe reference. Next: retry register_tool with from=<skill>/<recipe> or an explicit .json/.md path.",
      ),
    );
  }
  const draftProvided =
    typeof input.draft === "string" && input.draft.trim().length > 0;
  const templateProvided = Object.hasOwn(record, "template");
  const modeCount =
    Number(fromProvided) + Number(draftProvided) + Number(templateProvided);
  if (modeCount > 1) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "Use exactly one register_tool source mode: from, template, or draft. Next: remove the extra source fields and retry register_tool.",
      ),
    );
  }
  if (
    fromProvided &&
    (Object.hasOwn(record, "args") || Object.hasOwn(record, "async"))
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "register_tool from inherits args and async behavior. Next: retry register_tool with from and optional defaults only; omit args and async.",
      ),
    );
  }
}

function executeRegisterToolUnlocked<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  const rawInput =
    params && typeof params === "object"
      ? (params as RegisterToolInput)
      : ({} as RegisterToolInput);
  assertRegisterToolInputModes(rawInput);
  let input = rawInput;
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
  const resolutionContext = getRegistrationResolutionContext(ctx, deps);
  const requestedSource =
    typeof rawInput.from === "string" ? rawInput.from.trim() : undefined;
  if (typeof input.from === "string") {
    try {
      input = {
        ...input,
        from: normalizeFromReference(input.from, resolutionContext),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message.trim() : String(error);
      const diagnosticSource = requestedSource?.startsWith("skill:")
        ? requestedSource.slice("skill:".length)
        : requestedSource ?? "";
      throw new Error(
        ExecutionOutput.formatToolText(
          `Recipe source "${requestedSource}" is invalid: ${reason}. Active Skills: ${activeSkillSummary(resolutionContext)}. Next: ${recipeDoctorAction(diagnosticSource)}`,
        ),
      );
    }
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
  if (template === undefined && !input.from && !existing) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "New registration requires exactly one source mode: from, template, or draft. Next: retry register_tool with one source field.",
      ),
    );
  }
  const recipePath = getToolRecipePath(deps, name);
  const authoredRecipe = buildAuthoredRecipe(
    input,
    existing,
    authoritative.recipe,
  );
  const candidate = RecipesDiscovery.admitUserRecipe(
    recipePath,
    resolutionContext,
    authoredRecipe,
  );
  if (!candidate.validated || !candidate.tool) {
    const sourceDiagnostic = requestedSource
      ? `Recipe source "${requestedSource}" validation failed: ${candidate.diagnostics.join("; ")}. Active Skills: ${activeSkillSummary(resolutionContext)}. Next: ${recipeDoctorAction(requestedSource)}`
      : `Tool recipe validation failed: ${candidate.diagnostics.join("; ")}`;
    throw new Error(ExecutionOutput.formatToolText(sourceDiagnostic));
  }
  const activeBefore = deps.getActiveTools();
  let persisted = false;
  let activation: RuntimeActivation | undefined;
  let cfg: Config.RegisteredTool;
  let transactionStage = "persist";
  try {
    persistToolRecipe(deps, name, authoredRecipe);
    persisted = true;
    transactionStage = "persisted_admission";
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
    transactionStage = "runtime_activation";
    activation = deps.registerRuntimeTool(cfg) ?? undefined;
    if (
      activation &&
      (!activation.host_registered ||
        !activation.active_tool ||
        !activation.callable_now)
    ) {
      throw new Error(
        `Tool "${name}" activation failed at ${activationBoundary(activation)}; host_registered=${activation.host_registered}, active_tool=${activation.active_tool}, callable_now=${activation.callable_now}. Registration was rolled back. Next: inspect target=runtime view=status; do not use spawn as proof of tool invocation.`,
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
        `Tool registration transaction failed at ${transactionStage} (${resolutionContext.generation}; active Skills: ${activeSkillSummary(resolutionContext)}): ${error instanceof Error ? error.message : String(error)}`,
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
  const callableNow = activation?.callable_now ?? false;
  const source = requestedSource ?? "template";
  const argSummary = RecipesDiscovery.summarizeRegisteredToolArgs(cfg);
  const nextActions = registrationNextActions(name, source, callableNow);
  const outcomeText = callableNow
    ? `${existing ? "Updated" : "Registered"} tool "${name}" from ${source}; callable_now=true`
    : `Persisted tool "${name}" from ${source}; callable_now=false; activation_boundary=${activationBoundary(activation)}`;
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          `${outcomeText}; required=${Schema.formatToolArgs(argSummary.required)}; optional=${Schema.formatToolArgs(argSummary.optional)}; next=${nextActions[0]}.${warningText}`,
        ),
      ),
    ],
    details: {
      active_tool: activation?.active_tool ?? false,
      activation: activation?.activation ?? "unverified",
      activation_boundary: activationBoundary(activation),
      args: cfg.args,
      callable_now: callableNow,
      defaults: cfg.defaults,
      host_registered: activation?.host_registered ?? false,
      next_actions: nextActions,
      optional_args: argSummary.optional,
      persisted: true,
      registry_active: tools.get(name) === cfg,
      required_args: argSummary.required,
      resolved: true,
      source,
      ...(cfg.recipe?.async !== undefined ? { async: cfg.recipe.async } : {}),
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
