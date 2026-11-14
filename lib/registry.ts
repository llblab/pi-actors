/**
 * Registry mutation use-cases
 * Zones: registry mutations, persistence, runtime activation
 * Owns register/update/delete validation, persistence, runtime side effects, and result payloads
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import * as CommandTemplates from "./command-templates.ts";
import * as Config from "./config.ts";
import * as ExecutionOutput from "./execution-output.ts";
import {
  withFileMutationLock,
  writeJsonAtomic,
  writeTextAtomic,
} from "./file-state.ts";
import * as Identity from "./identity.ts";
import * as Limits from "./limits.ts";
import * as Paths from "./paths.ts";
import * as RecipesContext from "./recipes-context.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as Schema from "./schema.ts";
import * as ToolsResponse from "./tools-response.ts";

export interface RegisterToolInput {
  name?: string;
  description?: string;
  async?: boolean;
  expose?: boolean;
  template?: CommandTemplates.CommandTemplateValue | null;
  from?: string;
  defaults?: Record<string, unknown>;
  draft?: string;
  args?: string;
  update?: boolean;
}

export interface RegisterToolResultDetails {
  active_tool?: boolean;
  activation?: "current_session" | "unverified" | "not_requested";
  activation_boundary?: string;
  args?: string[];
  async?: boolean;
  callable_now?: boolean;
  defaults?: Record<string, string>;
  host_registered?: boolean;
  kind?: "retained_recipe";
  recipe?: string;
  result?: "retained";
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

function registryListText(rows: readonly string[]): string {
  const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;
  const coverage = (shown: number, reason?: string) => ({ ...(reason ? { reason } : {}), shown, omitted: rows.length - shown, total: rows.length });
  const malformed = rows.some(row => !row.isWellFormed());
  if (!malformed) {
    // Remove only the compiler prefix after the original key coercion and join.
    const complete = ToolsResponse.renderYamlMetadata({ registered_tools: rows.map(row => row.slice(2)), registered_tools_coverage: coverage(rows.length) }, budget);
    if (complete.state === "available") return complete.text;
  }
  const fallback = ToolsResponse.renderYamlMetadata({ registered_tools: malformed ? "[unavailable]" : "[omitted]", registered_tools_coverage: coverage(0, malformed ? "malformed_selected_text" : "response_too_large") }, budget);
  // Fixed keys/reasons and finite array-length counts are bounded far below budget.
  return (fallback as Extract<ToolsResponse.YamlMetadataRendering, { state: "available" }>).text;
}

function listTools<TContext>(
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  const names = [...deps.getTools().keys()].sort();
  const rows = names.length > 0 ? names.map((name) => `- ${name}`) : [];
  // Retain the original conditional map/join observations before read-time projection.
  void (names.length > 0 ? `Registered tools:\n${rows.join("\n")}` : "No registered tools.");
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          registryListText(rows),
        ),
      ),
    ],
    details: { tool: "actors_tool_register" },
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
    ? `actors_inspect target=recipes view=doctor identity=${source}`
    : "actors_inspect target=recipes view=doctor";
}

function registrationNextActions(
  tool: string,
  source: string,
  callableNow: boolean,
): string[] {
  if (callableNow) {
    return [
      `call tool ${tool}`,
      `actors_inspect target=tool:${tool} view=status`,
    ];
  }
  return [
    `actors_inspect target=tool:${tool} view=status`,
    ...(source === "template" || source === "draft"
      ? []
      : [recipeDoctorAction(source)]),
  ];
}

const REGISTRY_METADATA_BUDGET = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;

type RegistryMetadata = Record<string, unknown>;

/** Bare block-YAML registry document; builders own whole-value/omission policy and the byte budget. */
function registryMetadataText(value: RegistryMetadata): string {
  return (ToolsResponse.renderYamlMetadata(value, REGISTRY_METADATA_BUDGET) as
    Extract<ToolsResponse.YamlMetadataRendering, { state: "available" }>).text;
}

/** One opaque selected scalar as a whole value or an explicit whole-field omission, never a clip. */
function registrySelected(key: string, value: string): ToolsResponse.YamlPart {
  return ToolsResponse.selectYamlField(key, value, REGISTRY_METADATA_BUDGET);
}

/** Grow whole selected fields in priority order while the complete document still fits. */
function growRegistryDocument(render: () => RegistryMetadata, order: readonly ToolsResponse.YamlPart[]): string {
  return ToolsResponse.growYamlDocument(render, order, REGISTRY_METADATA_BUDGET);
}

/** Read-time text only: callers supply the original post-activation selections, not live ports. */
function registrationReceiptText(data: {
  tool: string; result: "registered" | "updated" | "persisted"; source: string; callable: boolean;
  boundary?: string; required: readonly unknown[]; optional: readonly unknown[];
  warnings: readonly unknown[]; next: string;
}): string {
  const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;
  const renderPart = (value: Record<string, unknown>) => ToolsResponse.renderYamlMetadata(value, budget);
  const omission = (key: string, count: number, malformed: boolean): Record<string, unknown> => ({
    [key]: malformed ? "[unavailable]" : "[omitted]",
    [key + "_omission"]: { reason: malformed ? "malformed_selected_text" : "response_too_large", shown: 0, omitted: count, total: count },
  });
  const part = (full: Record<string, unknown>, omitted: Record<string, unknown>) => {
    const complete = renderPart(full), fallback = renderPart(omitted);
    return { full, selected: complete.state === "available" && fallback.state === "available" && Buffer.byteLength(complete.text) <= Buffer.byteLength(fallback.text) ? full : omitted };
  };
  const scalar = (key: string, value: string) => {
    const wellFormed = value.isWellFormed();
    const omitted = omission(key, 1, !wellFormed);
    return part(wellFormed ? { [key]: value } : omitted, omitted);
  };
  const sequence = (key: string, values: readonly unknown[]) => {
    const rows: string[] = [];
    let malformed = false;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (typeof value !== "string" || !value.isWellFormed()) { malformed = true; break; }
      rows.push(value);
    }
    const omitted = omission(key, values.length, malformed);
    return part(malformed ? omitted : { [key]: rows }, omitted);
  };
  const tool = scalar("tool", data.tool);
  const source = scalar("source", data.source);
  const required = sequence("required_args", data.required), optional = sequence("optional_args", data.optional);
  const warnings = data.warnings.length ? sequence("warnings", data.warnings) : undefined;
  const nextWellFormed = data.next.isWellFormed();
  const omittedNext = omission("next_action", 1, !nextWellFormed);
  // This producer knows only its existing status hint; invocation advice stays opaque.
  const next = part(nextWellFormed
    ? data.callable ? { instruction: data.next } : { next: { tool: "actors_inspect", target: `tool:${data.tool}`, view: "status" } }
    : omittedNext, omittedNext);
  const render = () => renderPart({ ...tool.selected, result: data.result, ...source.selected, callable_now: data.callable,
    ...(data.boundary === undefined ? {} : { activation_boundary: data.boundary }), ...required.selected, ...optional.selected,
    ...(warnings ? warnings.selected : {}), ...next.selected });
  // Preserve complete safety notes before large argument lists; all seeds are monotone.
  for (const current of [...(warnings ? [warnings] : []), tool, source, next, required, optional]) {
    if (current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (render().state !== "available") current.selected = previous;
  }
  return (render() as Extract<ToolsResponse.YamlMetadataRendering, { state: "available" }>).text;
}

function registryNoticeText(kind: "activated" | "promoted" | "deleted", name: string): string {
  const report = { activated: "Tool activated", promoted: "Promoted draft recipe", deleted: "Deleted tool" }[kind];
  const selected = name.isWellFormed() ? ToolsResponse.formatMarkdownField("tool", name)
    : "- tool: [unavailable]\n- tool_omission:\n  - reason: malformed_selected_text\n  - shown: 0\n  - omitted: 1\n  - total: 1";
  return ToolsResponse.formatMarkdownField("report", report) + "\n" + selected;
}

function registrationTransactionFailureText(stage: string, generation: string, summary: string, error: string): string {
  const selectedGeneration = registrySelected("resolution_generation", generation);
  const selectedSummary = registrySelected("active_skills_summary", summary);
  const selectedError = registrySelected("error", error);
  const render = (): RegistryMetadata => ({ result: "Tool registration transaction failed.", stage,
    ...selectedGeneration.selected, ...selectedSummary.selected, ...selectedError.selected });
  // Keep a fitting surfaced error before large optional resolution metadata.
  return growRegistryDocument(render, [selectedError, selectedGeneration, selectedSummary]);
}

function candidateAdmissionFailureText(data: { kind: "source"; source: string; diagnostics: string; summary: string; instruction: string } | { kind: "recipe"; diagnostics: string }): string {
  const diagnostics = registrySelected("diagnostics_summary", data.diagnostics);
  const source = data.kind === "source" ? registrySelected("source", data.source) : undefined;
  const summary = data.kind === "source" ? registrySelected("active_skills_summary", data.summary) : undefined;
  const instruction = data.kind === "source" ? registrySelected("instruction", data.instruction) : undefined;
  const render = (): RegistryMetadata => ({ field: "recipe", ...(source ? source.selected : {}),
    result: data.kind === "source" ? "Recipe source validation failed." : "Tool recipe validation failed.",
    ...diagnostics.selected, ...(summary ? summary.selected : {}), ...(instruction ? instruction.selected : {}) });
  // Preserve fitting diagnostics before large optional source/context/advice fields.
  return growRegistryDocument(render, [diagnostics, ...(source ? [source] : []), ...(summary ? [summary] : []), ...(instruction ? [instruction] : [])]);
}

function sourceNormalizationFailureText(source: string, reason: string, summary: string, instruction: string): string {
  const selectedSource = registrySelected("source", source);
  const selectedReason = registrySelected("reason", reason);
  const selectedSummary = registrySelected("active_skills_summary", summary);
  const selectedInstruction = registrySelected("instruction", instruction);
  const render = (): RegistryMetadata => ({ field: "from", ...selectedSource.selected, result: "Recipe source is invalid.",
    ...selectedReason.selected, ...selectedSummary.selected, ...selectedInstruction.selected });
  return growRegistryDocument(render, [selectedSource, selectedReason, selectedSummary, selectedInstruction]);
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

function draftPathFailureText(kind: "root" | "missing", reference: string): string {
  const selected = registrySelected(kind === "root" ? "allowed_root" : "path", reference);
  const render = (): RegistryMetadata => ({ field: "draft", ...selected.selected,
    result: kind === "root" ? "Draft must be under the allowed root." : "Draft not found.",
    ...(kind === "root" ? { instruction: "Use actors_inspect target=recipes view=summary to list drafts." } : {}) });
  return growRegistryDocument(render, [selected]);
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
        draftPathFailureText("root", `${draftRoot}`),
      ),
    );
  }
  if (!existsSync(path)) {
    throw new Error(ExecutionOutput.formatToolText(draftPathFailureText("missing", `${path}`)));
  }
  return path;
}

function draftReceiptText(result: "updated" | "registered", tool: string, callable: string, next: string): string {
  const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;
  const renderPart = (value: Record<string, unknown>) => ToolsResponse.renderYamlMetadata(value, budget);
  const part = (key: string, value: string, rendered: Record<string, unknown>) => {
    const wellFormed = value.isWellFormed();
    const omitted: Record<string, unknown> = { [key]: wellFormed ? "[omitted]" : "[unavailable]",
      [key + "_omission"]: { reason: wellFormed ? "response_too_large" : "malformed_selected_text", shown: 0, omitted: 1, total: 1 } };
    const full = wellFormed ? rendered : omitted;
    const complete = renderPart(full), fallback = renderPart(omitted);
    return { full, selected: complete.state === "available" && fallback.state === "available" && Buffer.byteLength(complete.text) <= Buffer.byteLength(fallback.text) ? full : omitted };
  };
  const identity = part("tool", tool, { tool });
  const flag = part("callable_now", callable, { callable_now: callable });
  // Only this producer's exact canonical read-only status hint is typed, never body advice.
  const status = /^actors_inspect target=(tool:[a-z][a-z0-9_]{0,63}) view=status$/u.exec(next);
  const hint = part("next_action", next, status ? { next: { tool: "actors_inspect", target: status[1], view: "status" } } : { instruction: next });
  const render = () => renderPart({ ...identity.selected, result, source: "draft", ...flag.selected, ...hint.selected });
  for (const current of [identity, flag, hint]) {
    if (current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (render().state !== "available") current.selected = previous;
  }
  return (render() as Extract<ToolsResponse.YamlMetadataRendering, { state: "available" }>).text;
}

function duplicateRegistrationText(value: string): string {
  const selected = registrySelected("value", value);
  const render = (): RegistryMetadata => ({ field: "name", ...selected.selected,
    result: "Tool already registered.", instruction: "Use update=true to overwrite." });
  return growRegistryDocument(render, [selected]);
}

function draftRecipeFailureText(key: "reason" | "diagnostics_summary", value?: string): string {
  const selected = value === undefined ? undefined : registrySelected(key, value);
  const render = (): RegistryMetadata => ({ field: "draft", result: "Draft recipe is invalid.", ...(selected ? selected.selected : {}) });
  return growRegistryDocument(render, selected ? [selected] : []);
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
        duplicateRegistrationText(`${name}`),
      ),
    );
  }
  const raw = RecipesReferences.readRawRecipeConfig(draftPath);
  if (!raw) {
    const reason = RecipesReferences.diagnoseRawRecipeConfigFailure(draftPath);
    throw new Error(
      ExecutionOutput.formatToolText(
        draftRecipeFailureText("reason", reason ? `${reason}` : undefined),
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
        draftRecipeFailureText("diagnostics_summary", `${candidate.diagnostics.join("; ")}`),
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
  deps.notify(ctx, registryNoticeText("promoted", `${name}`), "info");
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          // Preserve the old name→flag→hint template conversions here, after notify.
          draftReceiptText(existing ? "updated" : "registered", `${name}`, `${callableNow}`, `${nextActions[0]}`),
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

function registryDeletionText(name: string, result: "deleted" | "not found"): string {
  const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;
  const facts = { result, ...(result === "deleted" ? { instruction: "Reload to remove it from the complete registry." } : {}) };
  const wellFormed = name.isWellFormed();
  if (wellFormed) {
    const complete = ToolsResponse.renderYamlMetadata({ tool: name, ...facts }, budget);
    if (complete.state === "available") return complete.text;
  }
  const fallback = ToolsResponse.renderYamlMetadata({ tool: wellFormed ? "[omitted]" : "[unavailable]", tool_omission: { reason: wellFormed ? "response_too_large" : "malformed_selected_text", shown: 0, omitted: 1, total: 1 }, ...facts }, budget);
  // Fixed metadata is well formed and bounded far below budget.
  return (fallback as Extract<ToolsResponse.YamlMetadataRendering, { state: "available" }>).text;
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
          ExecutionOutput.formatToolText(registryDeletionText(`${name}`, "not found")),
        ),
      ],
      details: { tool: name },
    };
  }
  const blocker = deps.getToolNameBlocker(name);
  if (blocker) throw new Error(ExecutionOutput.formatToolText(blocker));
  const recipePath = getToolRecipePath(deps, name);
  if (existsSync(recipePath)) unlinkSync(recipePath);
  tools.delete(name);
  deps.setActiveTools(
    deps.getActiveTools().filter((toolName) => toolName !== name),
  );
  deps.notify(ctx, registryNoticeText("deleted", `${name}`), "info");
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          registryDeletionText(`${name}`, "deleted"),
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
      ExecutionOutput.formatToolText(registryMetadataText({ field: "template",
        result: "Nested Recipe-shaped templates are not a actors_tool_register source mode.",
        instruction: "retry with from=<skill>/<recipe> and defaults={...}." })),
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
        ExecutionOutput.formatToolText(registryMetadataText({ field: "template", result: "Tool template sequence is empty." })),
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
    ExecutionOutput.formatToolText(registryMetadataText({ field: "template", result: "unsupported template type",
      supported_types: ["string", "object", "sequence"] })),
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
      ExecutionOutput.formatToolText(registryMetadataText({ field: "defaults", result: "Tool defaults must be an object." })),
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
        "Tool from must be a non-empty Recipe reference. Next: retry actors_tool_register with from=<skill>/<recipe> or an explicit .json/.md path.",
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
      ExecutionOutput.formatToolText(registryMetadataText({ field: "description",
        result: "Tool description is required for command-template registration." })),
    );
  }
  const inputDefaults = normalizeDefaults(input.defaults);
  if (from) {
    const runtimeOwnedDefault = Object.keys(inputDefaults ?? {}).find((key) =>
      RecipesReferences.isRuntimeOwnedRecipeInput(key),
    );
    if (runtimeOwnedDefault) {
      throw new Error(
        ExecutionOutput.formatToolText(registryMetadataText({ field: "defaults",
          ...registrySelected("key", runtimeOwnedDefault).selected,
          result: "Tool defaults cannot set runtime-owned input.",
          instruction: "remove that default and retry actors_tool_register; the runtime supplies it." })),
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
      ExecutionOutput.formatToolText(registryMetadataText({ field: "template", result: "Tool template cannot be null here." })),
    );
  }
  const finalTemplate =
    template === undefined || template === ""
      ? existingRecipe?.template ?? existing?.template
      : template;
  if (!finalTemplate) {
    throw new Error(
      ExecutionOutput.formatToolText(registryMetadataText({ field: "template", result: "Tool template is required." })),
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
      ExecutionOutput.formatToolText(registryMetadataText({ field: "values", result: "actors_tool_register values was removed.",
        replacement_fields: ["defaults", "from"],
        instruction: "retry actors_tool_register with defaults for caller inputs, or use from=<skill>/<recipe> for maintained composition." })),
    );
  }
  const fromProvided = Object.hasOwn(record, "from");
  if (
    fromProvided &&
    (typeof input.from !== "string" || input.from.trim().length === 0)
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(registryMetadataText({ field: "from",
        result: "Tool from must be a non-empty Recipe reference.",
        reference_forms: ["<skill>/<recipe>", "explicit .json path", "explicit .md path"],
        instruction: "retry actors_tool_register with from=<skill>/<recipe> or an explicit .json/.md path." })),
    );
  }
  const draftProvided =
    typeof input.draft === "string" && input.draft.trim().length > 0;
  const templateProvided = Object.hasOwn(record, "template");
  const modeCount =
    Number(fromProvided) + Number(draftProvided) + Number(templateProvided);
  if (modeCount > 1) {
    throw new Error(
      ExecutionOutput.formatToolText(registryMetadataText({ result: "Use exactly one actors_tool_register source mode.",
        source_modes: ["from", "template", "draft"],
        instruction: "remove the extra source fields and retry actors_tool_register." })),
    );
  }
  if (
    fromProvided &&
    (Object.hasOwn(record, "args") || Object.hasOwn(record, "async"))
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(registryMetadataText({ field: "from",
        result: "actors_tool_register from inherits args and async behavior.",
        inherited_fields: ["args", "async"],
        instruction: "retry actors_tool_register with from and optional defaults only; omit args and async." })),
    );
  }
}

function reservedRegistrationNameText(value: string): string {
  const selected = registrySelected("value", value);
  const render = (): RegistryMetadata => ({ field: "name", ...selected.selected, result: "Reserved tool name." });
  return growRegistryDocument(render, [selected]);
}

function executeRegisterToolUnlocked<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult | (() => RegisterToolResult) {
  const rawInput =
    params && typeof params === "object"
      ? (params as RegisterToolInput)
      : ({} as RegisterToolInput);
  assertRegisterToolInputModes(rawInput);
  if (Object.hasOwn(rawInput, "expose")) {
    const exposure = rawInput.expose;
    if (typeof exposure !== "boolean") throw new RetainedRecipeRefusal("expose", "expose must be Boolean.");
    // Select under the existing name reservation; acquire retention locks only after it releases.
    if (exposure === false) return () => retainRecipe(rawInput, ctx, deps);
  }
  let input = rawInput;
  if (!input.name) return listTools(deps);
  const name = Identity.normalizeToolName(input.name);
  if (!name)
    throw new Error(ExecutionOutput.formatToolText(registryMetadataText({ field: "name", result: "Invalid tool name." })));
  if (deps.reservedToolNames.has(name)) {
    throw new Error(
      ExecutionOutput.formatToolText(reservedRegistrationNameText(`${name}`)),
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
          sourceNormalizationFailureText(`${requestedSource}`, `${reason}`, `${activeSkillSummary(resolutionContext)}`, `${recipeDoctorAction(diagnosticSource)}`),
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
        duplicateRegistrationText(`${name}`),
      ),
    );
  }
  if (template === undefined && !input.from && !existing) {
    throw new Error(
      ExecutionOutput.formatToolText(registryMetadataText({ result: "New registration requires exactly one source mode.",
        source_modes: ["from", "template", "draft"],
        instruction: "retry actors_tool_register with one source field." })),
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
      ? candidateAdmissionFailureText({ kind: "source", source: `${requestedSource}`, diagnostics: `${candidate.diagnostics.join("; ")}`, summary: `${activeSkillSummary(resolutionContext)}`, instruction: `${recipeDoctorAction(requestedSource)}` })
      : candidateAdmissionFailureText({ kind: "recipe", diagnostics: `${candidate.diagnostics.join("; ")}` });
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
        `Tool "${name}" activation failed at ${activationBoundary(activation)}; host_registered=${activation.host_registered}, active_tool=${activation.active_tool}, callable_now=${activation.callable_now}. Registration was rolled back. Next: actors_inspect target=runtime view=status; do not use spawn as proof of tool invocation.`,
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
        registrationTransactionFailureText(`${transactionStage}`, `${resolutionContext.generation}`, `${activeSkillSummary(resolutionContext)}`, `${error instanceof Error ? error.message : String(error)}`),
      ),
    );
  }
  deps.notify(ctx, registryNoticeText("activated", `${name}`), "info");
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
  let displayBoundary: string | undefined;
  const outcomeText = callableNow
    ? `${existing ? "Updated" : "Registered"} tool "${name}" from ${source}; callable_now=true`
    : `Persisted tool "${name}" from ${source}; callable_now=false; activation_boundary=${displayBoundary = activationBoundary(activation)}`;
  // Keep original fallible advisory evaluation/order after effects, before the new text.
  void `${outcomeText}; required=${Schema.formatToolArgs(argSummary.required)}; optional=${Schema.formatToolArgs(argSummary.optional)}; next=${nextActions[0]}.${warningText}`;
  return {
    content: [
      textContent(
        ExecutionOutput.formatToolText(
          registrationReceiptText({ tool: name, result: callableNow ? existing ? "updated" : "registered" : "persisted",
            source, callable: Boolean(callableNow), boundary: displayBoundary, required: argSummary.required,
            optional: argSummary.optional, warnings: templateWarnings, next: nextActions[0] }),
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

class RetainedRecipeRefusal extends Error {
  readonly reason: string;
  constructor(field: string, reason: string, cause?: unknown) {
    super(ExecutionOutput.formatToolText(registryMetadataText({ field, result: reason })), { cause });
    this.reason = reason;
  }
}

function retainedDirectory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RetainedRecipeRefusal("storage", "Retained storage must be a regular non-symlink directory.");
  }
  return { path, realpath: realpathSync.native(path), dev: stat.dev, ino: stat.ino };
}

function recheckRetainedDirectory(frame: ReturnType<typeof retainedDirectory>): void {
  const current = retainedDirectory(frame.path);
  if (current.realpath !== frame.realpath || current.dev !== frame.dev || current.ino !== frame.ino) {
    throw new RetainedRecipeRefusal("storage", "Retained storage identity changed.");
  }
}

function retainedSlotAbsent(path: string, ownTargetPublished = false): void {
  for (const candidate of ownTargetPublished ? [path.replace(/\.json$/u, ".md")] : [path, path.replace(/\.json$/u, ".md")]) {
    try { lstatSync(candidate); }
    catch (error) {
      let code: unknown;
      try { code = (error as NodeJS.ErrnoException | undefined)?.code; }
      catch (observationError) { throw new AggregateError([error, observationError], "Retained slot observation failed.", { cause: error }); }
      if (code === "ENOENT") continue;
      throw error;
    }
    throw new RetainedRecipeRefusal("name", "Retained Recipe already exists; this path is create-only.");
  }
}

function retainedFile(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RetainedRecipeRefusal("storage", "Retained target must be a regular non-symlink file.");
  }
  if (stat.size > BigInt(RecipesReferences.MAX_RECIPE_FILE_BYTES)) throw new RetainedRecipeRefusal("storage", "Retained target exceeds the source size limit.");
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs };
}

function withinRetainedSource(root: string, path: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!isAbsolute(relation) && !/^\.\.(?:[\\/]|$)/u.test(relation));
}

function assertRetainedSourceLifetime(source: string, root: string, field: string): void {
  const drafts = join(root, "drafts");
  if (withinRetainedSource(drafts, source) ||
    (existsSync(drafts) && existsSync(source) && withinRetainedSource(realpathSync.native(drafts), realpathSync.native(source)))) {
    throw new RetainedRecipeRefusal(field, "Retained creation cannot reference a managed disposable draft.");
  }
}

function assertRetainedTemplateLifetimes(value: unknown, path: string, root: string, context: RecipesContext.RecipeResolutionContext): void {
  if (typeof value === "string") {
    const source = RecipesReferences.resolveRecipeReferencePath(value, dirname(path), context.activeSkills);
    if (source) assertRetainedSourceLifetime(source, root, "template");
  } else if (Array.isArray(value)) {
    for (const child of value) assertRetainedTemplateLifetimes(child, path, root, context);
  } else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    assertRetainedTemplateLifetimes(node.template, path, root, context);
    assertRetainedTemplateLifetimes(node.recover, path, root, context);
  }
}

function retainRecipe<TContext>(
  input: RegisterToolInput,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): RegisterToolResult {
  assertRegisterToolInputModes(input);
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new RetainedRecipeRefusal("name", "Retained creation requires a name.");
  }
  const name = Identity.normalizeToolName(input.name);
  if (!name || deps.reservedToolNames.has(name)) {
    throw new RetainedRecipeRefusal("name", "Invalid or reserved retained Recipe name.");
  }
  const blocker = deps.getToolNameBlocker(name);
  if (blocker) throw new Error(ExecutionOutput.formatToolText(blocker));
  if (input.update || Object.hasOwn(input, "draft")) {
    throw new RetainedRecipeRefusal("expose", "Retained creation does not support update or draft promotion.");
  }
  const template = getInputTemplate(input.template);
  if (template === null || template === "") {
    throw new RetainedRecipeRefusal("template", "Retained deletion is not supported.");
  }
  if (template === undefined && !input.from) {
    throw new RetainedRecipeRefusal("source", "Retained creation requires template or from.");
  }
  const root = resolve(getRecipeRoot(deps)), library = join(root, "library"), path = join(library, `${name}.json`);
  const context = getRegistrationResolutionContext(ctx, deps);
  const from = input.from === undefined ? undefined : normalizeFromReference(input.from, context);
  if (from) {
    const source = from.endsWith(".json") || from.endsWith(".md") ? from
      : RecipesReferences.resolveRecipeReferencePath(from, context.cwd, context.activeSkills);
    if (source) assertRetainedSourceLifetime(source, root, "from");
  }
  const authored = buildAuthoredRecipe({ ...input, ...(from ? { from } : {}) }, undefined, undefined);
  if (!from) assertRetainedTemplateLifetimes(authored.template, path, root, context);
  const bytes = `${JSON.stringify(authored, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > RecipesReferences.MAX_RECIPE_FILE_BYTES) {
    throw new RetainedRecipeRefusal("source", "Retained Recipe exceeds the 1 MiB source limit.");
  }
  const candidate = RecipesDiscovery.admitUserRecipe(path, context, authored);
  if (!candidate.validated || !candidate.tool) {
    throw new RetainedRecipeRefusal("source", "Retained Recipe admission failed; check the source and caller argument contract.", candidate.diagnostics);
  }
  let stage = "storage";
  try {
    return withFileMutationLock(root, () => {
      mkdirSync(root, { recursive: true });
      const rootFrame = retainedDirectory(root);
      return withFileMutationLock(library, () => {
        recheckRetainedDirectory(rootFrame);
        mkdirSync(library, { recursive: true });
        const libraryFrame = retainedDirectory(library);
        const relation = relative(rootFrame.realpath, libraryFrame.realpath);
        if ((process.platform === "win32" ? relation.toLowerCase() : relation) !== "library") {
          throw new RetainedRecipeRefusal("storage", "Retained library escapes its Recipe root.");
        }
        const recheck = () => { recheckRetainedDirectory(rootFrame); recheckRetainedDirectory(libraryFrame); };
        return withFileMutationLock(path, () => {
          recheck(); retainedSlotAbsent(path);
          stage = "persistence";
          writeTextAtomic(path, bytes, { exclusive: true, onBeforeReplace: () => { recheck(); retainedSlotAbsent(path); } });
          stage = "persisted_admission";
          recheck(); retainedSlotAbsent(path, true);
          const before = retainedFile(path);
          if (readFileSync(path, "utf8") !== bytes) throw new RetainedRecipeRefusal("storage", "Persisted retained content changed.");
          const admitted = RecipesDiscovery.admitUserRecipe(path, context);
          if (!admitted.validated || !admitted.tool) throw new RetainedRecipeRefusal("source", "Persisted retained Recipe admission failed.", admitted.diagnostics);
          const after = retainedFile(path);
          if (Object.keys(before).some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]) ||
            readFileSync(path, "utf8") !== bytes) throw new RetainedRecipeRefusal("storage", "Persisted retained content changed.");
          recheck(); retainedSlotAbsent(path, true);
          stage = "receipt";
          const args = RecipesDiscovery.summarizeRegisteredToolArgs(admitted.tool);
          const source = from ? from.endsWith(".json") || from.endsWith(".md") ? `<explicit-file:${basename(from)}>` : from : "template";
          const recipe = registrySelected("recipe", path), selectedName = registrySelected("tool", name);
          const selectedSource = registrySelected("source", source);
          const required = ToolsResponse.selectYamlField("required_args", args.required, REGISTRY_METADATA_BUDGET);
          const optional = ToolsResponse.selectYamlField("optional_args", args.optional, REGISTRY_METADATA_BUDGET);
          const facts = { kind: "retained_recipe" as const, result: "retained" as const, persisted: true, resolved: true,
            validated: true, activation: "not_requested" as const, async: admitted.async };
          const text = growRegistryDocument(() => ({ ...selectedName.selected, ...facts, ...recipe.selected, ...selectedSource.selected,
            ...required.selected, ...optional.selected, next: { tool: "actors_inspect", target: "recipes", view: "summary", verbose: true } }),
            [recipe, selectedName, selectedSource, required, optional]);
          const result = {
            content: [textContent(ExecutionOutput.formatToolText(text))],
            details: { ...facts, tool: name, recipe: path, source, required_args: args.required, optional_args: args.optional,
              next_actions: ["actors_inspect target=recipes view=summary verbose=true"] },
          };
          stage = "release";
          return result;
        });
      });
    });
  } catch (error) {
    const reason = error instanceof RetainedRecipeRefusal ? { reason: error.reason } : {};
    throw new Error(ExecutionOutput.formatToolText(registryMetadataText({ operation: "retain", stage, result: "unconfirmed",
      effects: "unknown; inspect retained inventory before retry", ...reason,
      next: { tool: "actors_inspect", target: "recipes", view: "summary", verbose: true } })), { cause: error });
  }
}

export async function executeRegisterTool<TContext>(
  params: unknown,
  ctx: TContext,
  deps: RegisterToolRuntimeDeps<TContext>,
): Promise<RegisterToolResult> {
  const input = params as RegisterToolInput;
  let result: RegisterToolResult | (() => RegisterToolResult);
  if (!input.name) result = executeRegisterToolUnlocked(params, ctx, deps);
  else {
    const name = Identity.normalizeToolName(input.name);
    result = !name ? executeRegisterToolUnlocked(params, ctx, deps)
      : withFileMutationLock(getToolRecipePath(deps, name), () => executeRegisterToolUnlocked(params, ctx, deps));
  }
  return typeof result === "function" ? result() : result;
}
