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

function registryListText(rows: readonly string[]): string {
  const coverage = (shown: number, reason?: string) => "\n- registered_tools_coverage:" +
    (reason ? `\n  - reason: ${reason}` : "") + `\n  - shown: ${shown}\n  - omitted: ${rows.length - shown}\n  - total: ${rows.length}`;
  const malformed = rows.some(row => !row.isWellFormed());
  if (!malformed) {
    // Rows already contain the old compiler-owned bullet and selected key coercion.
    const body = rows.length ? "- registered_tools:\n" + rows.map(row => "  " + row.replaceAll(/\r\n|\r|\n/gu, newline => newline + "    ")).join("\n")
      : "- registered_tools: none";
    const complete = body + coverage(rows.length);
    if (Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) return complete;
  }
  return `- registered_tools: [${malformed ? "unavailable" : "omitted"}]` + coverage(0, malformed ? "malformed_selected_text" : "response_too_large");
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

/** Read-time text only: callers supply the original post-activation selections, not live ports. */
function registrationReceiptText(data: {
  tool: string; result: "registered" | "updated" | "persisted"; source: string; callable: boolean;
  boundary?: string; required: readonly unknown[]; optional: readonly unknown[];
  warnings: readonly unknown[]; next: string;
}): string {
  const field = ToolsResponse.formatMarkdownField;
  const omission = (key: string, count: number, malformed: boolean) =>
    `- ${key}: [${malformed ? "unavailable" : "omitted"}]\n- ${key}_omission:\n  - reason: ${malformed ? "malformed_selected_text" : "response_too_large"}\n  - shown: 0\n  - omitted: ${count}\n  - total: ${count}`;
  const part = (full: string, omitted: string) => ({ full, selected: Buffer.byteLength(full) <= Buffer.byteLength(omitted) ? full : omitted });
  const scalar = (key: string, value: string, literal = false) => {
    const wellFormed = value.isWellFormed();
    const omitted = omission(key, 1, !wellFormed);
    return part(wellFormed ? field(key, literal ? ToolsResponse.formatLiteralBlock(value) : value) : omitted, omitted);
  };
  const sequence = (key: string, values: readonly unknown[]) => {
    const rows: string[] = [];
    let malformed = false;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (typeof value !== "string" || !value.isWellFormed()) { malformed = true; break; }
      rows.push("  - " + value.replaceAll(/\r\n|\r|\n/gu, newline => newline + "    "));
    }
    const omitted = omission(key, values.length, malformed);
    return part(malformed ? omitted : rows.length ? `- ${key}:\n${rows.join("\n")}` : field(key, "none"), omitted);
  };
  const tool = scalar("tool", data.tool);
  const source = scalar("source", data.source, data.source !== "template");
  const required = sequence("required_args", data.required), optional = sequence("optional_args", data.optional);
  const warnings = data.warnings.length ? sequence("warnings", data.warnings) : undefined;
  const nextWellFormed = data.next.isWellFormed();
  const omittedNext = omission("next_action", 1, !nextWellFormed);
  // This producer knows only its existing status hint; invocation advice stays opaque.
  const next = part(nextWellFormed
    ? data.callable ? field("instruction", data.next) : ToolsResponse.formatInspectNextAction(`tool:${data.tool}`, "status")
    : omittedNext, omittedNext);
  const render = () => [tool.selected, field("result", data.result), source.selected, field("callable_now", data.callable ? "true" : "false"),
    ...(data.boundary === undefined ? [] : [field("activation_boundary", data.boundary)]), required.selected, optional.selected,
    ...(warnings ? [warnings.selected] : []), next.selected].join("\n");
  // Preserve complete safety notes before large argument lists; all seeds are monotone.
  for (const current of [...(warnings ? [warnings] : []), tool, source, next, required, optional]) {
    if (current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (Buffer.byteLength(render()) > Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) current.selected = previous;
  }
  return render();
}

function registryNoticeText(kind: "activated" | "promoted" | "deleted", name: string): string {
  const report = { activated: "Tool activated", promoted: "Promoted draft recipe", deleted: "Deleted tool" }[kind];
  const selected = name.isWellFormed() ? ToolsResponse.formatMarkdownField("tool", name)
    : "- tool: [unavailable]\n- tool_omission:\n  - reason: malformed_selected_text\n  - shown: 0\n  - omitted: 1\n  - total: 1";
  return ToolsResponse.formatMarkdownField("report", report) + "\n" + selected;
}

function registrationTransactionFailureText(stage: string, generation: string, summary: string, error: string): string {
  const field = ToolsResponse.formatMarkdownField;
  const part = (key: string, value: string) => {
    const wellFormed = value.isWellFormed();
    const omitted = `- ${key}: [${wellFormed ? "omitted" : "unavailable"}]\n- ${key}_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
    const full = wellFormed ? field(key, value) : omitted;
    return { full, selected: Buffer.byteLength(full) <= Buffer.byteLength(omitted) ? full : omitted };
  };
  const selectedGeneration = part("resolution_generation", generation);
  const selectedSummary = part("active_skills_summary", summary);
  const selectedError = part("error", error);
  const render = () => [field("result", "Tool registration transaction failed."), field("stage", stage),
    selectedGeneration.selected, selectedSummary.selected, selectedError.selected].join("\n");
  // Keep a fitting surfaced error before large optional resolution metadata.
  for (const current of [selectedError, selectedGeneration, selectedSummary]) {
    if (current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (Buffer.byteLength(render()) > Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) current.selected = previous;
  }
  return render();
}

function candidateAdmissionFailureText(data: { kind: "source"; source: string; diagnostics: string; summary: string; instruction: string } | { kind: "recipe"; diagnostics: string }): string {
  const field = ToolsResponse.formatMarkdownField;
  const part = (key: string, value: string, literal = false) => {
    const wellFormed = value.isWellFormed();
    const omitted = `- ${key}: [${wellFormed ? "omitted" : "unavailable"}]\n- ${key}_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
    const full = wellFormed ? field(key, literal ? ToolsResponse.formatLiteralBlock(value) : value) : omitted;
    return { full, selected: Buffer.byteLength(full) <= Buffer.byteLength(omitted) ? full : omitted };
  };
  const diagnostics = part("diagnostics_summary", data.diagnostics);
  const source = data.kind === "source" ? part("source", data.source, true) : undefined;
  const summary = data.kind === "source" ? part("active_skills_summary", data.summary) : undefined;
  const instruction = data.kind === "source" ? part("instruction", data.instruction) : undefined;
  const render = () => [field("field", "recipe"), ...(source ? [source.selected] : []),
    field("result", data.kind === "source" ? "Recipe source validation failed." : "Tool recipe validation failed."),
    diagnostics.selected, ...(summary ? [summary.selected] : []), ...(instruction ? [instruction.selected] : [])].join("\n");
  // Preserve fitting diagnostics before large optional source/context/advice fields.
  for (const current of [diagnostics, source, summary, instruction]) {
    if (!current || current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (Buffer.byteLength(render()) > Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) current.selected = previous;
  }
  return render();
}

function sourceNormalizationFailureText(source: string, reason: string, summary: string, instruction: string): string {
  const field = ToolsResponse.formatMarkdownField;
  const part = (key: string, value: string, literal = false) => {
    const wellFormed = value.isWellFormed();
    const omitted = `- ${key}: [${wellFormed ? "omitted" : "unavailable"}]\n- ${key}_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
    const full = wellFormed ? field(key, literal ? ToolsResponse.formatLiteralBlock(value) : value) : omitted;
    return { full, selected: Buffer.byteLength(full) <= Buffer.byteLength(omitted) ? full : omitted };
  };
  const selectedSource = part("source", source, true);
  const selectedReason = part("reason", reason);
  const selectedSummary = part("active_skills_summary", summary);
  const selectedInstruction = part("instruction", instruction);
  const render = () => [field("field", "from"), selectedSource.selected, field("result", "Recipe source is invalid."),
    selectedReason.selected, selectedSummary.selected, selectedInstruction.selected].join("\n");
  for (const current of [selectedSource, selectedReason, selectedSummary, selectedInstruction]) {
    if (current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (Buffer.byteLength(render()) > Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) current.selected = previous;
  }
  return render();
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
  const key = kind === "root" ? "allowed_root" : "path";
  const render = (selected: string) => "- field: draft\n" + selected + (kind === "root"
    ? "\n- result: Draft must be under the allowed root.\n- instruction: Use inspect target=recipes view=summary to list drafts."
    : "\n- result: Draft not found.");
  const wellFormed = reference.isWellFormed();
  if (wellFormed) {
    const complete = render(ToolsResponse.formatMarkdownField(key, ToolsResponse.formatLiteralBlock(reference)));
    if (Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) return complete;
  }
  return render(`- ${key}: [${wellFormed ? "omitted" : "unavailable"}]\n- ${key}_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`);
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
  const field = ToolsResponse.formatMarkdownField;
  const part = (key: string, value: string, rendered: string) => {
    const wellFormed = value.isWellFormed();
    const omitted = `- ${key}: [${wellFormed ? "omitted" : "unavailable"}]\n- ${key}_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
    const full = wellFormed ? rendered : omitted;
    return { full, selected: Buffer.byteLength(full) <= Buffer.byteLength(omitted) ? full : omitted };
  };
  const identity = part("tool", tool, field("tool", tool));
  const flag = part("callable_now", callable, field("callable_now", callable));
  // Only this producer's exact canonical read-only status hint is typed, never body advice.
  const status = /^inspect target=(tool:[a-z][a-z0-9_]{0,63}) view=status$/u.exec(next);
  const hint = part("next_action", next, status ? ToolsResponse.formatInspectNextAction(status[1], "status") : field("instruction", next));
  const render = () => [identity.selected, field("result", result), field("source", "draft"), flag.selected, hint.selected].join("\n");
  for (const current of [identity, flag, hint]) {
    if (current.selected === current.full) continue;
    const previous = current.selected;
    current.selected = current.full;
    if (Buffer.byteLength(render()) > Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) current.selected = previous;
  }
  return render();
}

function duplicateRegistrationText(value: string): string {
  const render = (selected: string) => "- field: name\n" + selected + "\n- result: Tool already registered.\n- instruction: Use update=true to overwrite.";
  const wellFormed = value.isWellFormed();
  if (wellFormed) {
    const complete = render(ToolsResponse.formatMarkdownField("value", value));
    if (Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) return complete;
  }
  return render(`- value: [${wellFormed ? "omitted" : "unavailable"}]\n- value_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`);
}

function draftRecipeFailureText(key: "reason" | "diagnostics_summary", value?: string): string {
  const header = "- field: draft\n- result: Draft recipe is invalid.";
  if (value === undefined) return header;
  const wellFormed = value.isWellFormed();
  if (wellFormed) {
    const complete = header + "\n" + ToolsResponse.formatMarkdownField(key, value);
    if (Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) return complete;
  }
  return header + `\n- ${key}: [${wellFormed ? "omitted" : "unavailable"}]\n- ${key}_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`;
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
  const field = ToolsResponse.formatMarkdownField;
  const facts = [field("result", result), ...(result === "deleted"
    ? [field("instruction", "Reload to remove it from the complete registry.")] : [])];
  const render = (identity: string) => [identity, ...facts].join("\n");
  const wellFormed = name.isWellFormed();
  if (wellFormed) {
    const complete = render(field("tool", name));
    if (Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) return complete;
  }
  return render(`- tool: [${wellFormed ? "omitted" : "unavailable"}]\n- tool_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`);
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
      ExecutionOutput.formatToolText(
        "- field: template\n- result: Nested Recipe-shaped templates are not a register_tool source mode.\n- instruction: retry with from=<skill>/<recipe> and defaults={...}.",
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
        ExecutionOutput.formatToolText("- field: template\n- result: Tool template sequence is empty."),
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
      "- field: template\n- result: unsupported template type\n- supported_types:\n  - string\n  - object\n  - sequence",
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
      ExecutionOutput.formatToolText("- field: defaults\n- result: Tool defaults must be an object."),
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
        "- field: description\n- result: Tool description is required for command-template registration.",
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
          `- field: defaults\n- key: ${runtimeOwnedDefault}\n- result: Tool defaults cannot set runtime-owned input.\n- instruction: remove that default and retry register_tool; the runtime supplies it.`,
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
      ExecutionOutput.formatToolText("- field: template\n- result: Tool template cannot be null here."),
    );
  }
  const finalTemplate =
    template === undefined || template === ""
      ? existingRecipe?.template ?? existing?.template
      : template;
  if (!finalTemplate) {
    throw new Error(
      ExecutionOutput.formatToolText("- field: template\n- result: Tool template is required."),
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
        "- field: values\n- result: register_tool values was removed.\n- replacement_fields:\n  - defaults\n  - from\n- instruction: retry register_tool with defaults for caller inputs, or use from=<skill>/<recipe> for maintained composition.",
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
        "- field: from\n- result: Tool from must be a non-empty Recipe reference.\n- reference_forms:\n  - <skill>/<recipe>\n  - explicit .json path\n  - explicit .md path\n- instruction: retry register_tool with from=<skill>/<recipe> or an explicit .json/.md path.",
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
        "- result: Use exactly one register_tool source mode.\n- source_modes:\n  - from\n  - template\n  - draft\n- instruction: remove the extra source fields and retry register_tool.",
      ),
    );
  }
  if (
    fromProvided &&
    (Object.hasOwn(record, "args") || Object.hasOwn(record, "async"))
  ) {
    throw new Error(
      ExecutionOutput.formatToolText(
        "- field: from\n- result: register_tool from inherits args and async behavior.\n- inherited_fields:\n  - args\n  - async\n- instruction: retry register_tool with from and optional defaults only; omit args and async.",
      ),
    );
  }
}

function reservedRegistrationNameText(value: string): string {
  const render = (selected: string) => "- field: name\n" + selected + "\n- result: Reserved tool name.";
  const wellFormed = value.isWellFormed();
  if (wellFormed) {
    const complete = render(ToolsResponse.formatMarkdownField("value", value));
    if (Buffer.byteLength(complete) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1) return complete;
  }
  return render(`- value: [${wellFormed ? "omitted" : "unavailable"}]\n- value_omission:\n  - reason: ${wellFormed ? "response_too_large" : "malformed_selected_text"}\n  - shown: 0\n  - omitted: 1\n  - total: 1`);
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
    throw new Error(ExecutionOutput.formatToolText("- field: name\n- result: Invalid tool name."));
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
      ExecutionOutput.formatToolText(
        "- result: New registration requires exactly one source mode.\n- source_modes:\n  - from\n  - template\n  - draft\n- instruction: retry register_tool with one source field.",
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
