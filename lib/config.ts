/**
 * Persistent tool registry config helpers
 * Zones: registry config, persistence, normalization
 * Owns registered-tool config loading, normalization, unsupported-shape rejection, and serialization
 */

import { existsSync, readFileSync } from "node:fs";

import type { CommandTemplateValue } from "./command-templates.ts";
import * as CommandTemplates from "./command-templates.ts";
import { writeJsonAtomic } from "./file-state.ts";
import { normalizeToolName } from "./identity.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as Schema from "./schema.ts";

export interface RegisteredTool {
  name: string;
  description: string;
  args: string[];
  defaults: Record<string, string>;
  argTypes?: Record<string, Schema.ToolArgType>;
  recipe?: RecipeReferences.TemplateRecipeConfig;
  template?: CommandTemplateValue;
  storedArgs?: string[];
  storedDefaults?: Record<string, string>;
  sourcePath?: string;
}

export interface LoadConfigResult {
  tools: Map<string, RegisteredTool>;
  warnings: string[];
  changed: boolean;
}

export function serializeTools(
  source: Map<string, RegisteredTool>,
): Record<string, unknown> {
  const entries = [...source.entries()].sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, unknown> = {};
  for (const [name, cfg] of entries) {
    const entry: Record<string, unknown> = {
      description: cfg.description,
    };
    if (cfg.storedArgs && cfg.storedArgs.length > 0)
      entry.args = cfg.storedArgs;
    if (cfg.storedDefaults && Object.keys(cfg.storedDefaults).length > 0)
      entry.defaults = cfg.storedDefaults;
    if (cfg.recipe?.name) entry.name = cfg.recipe.name;
    if (cfg.recipe?.async !== undefined) entry.async = cfg.recipe.async;
    if (cfg.recipe?.state_dir) entry.state_dir = cfg.recipe.state_dir;
    if (cfg.recipe?.values) entry.values = cfg.recipe.values;
    if (cfg.template) entry.template = cfg.template;
    result[name] = entry;
  }
  return result;
}

export function saveTools(
  path: string,
  source: Map<string, RegisteredTool>,
): string | undefined {
  try {
    writeJsonAtomic(path, serializeTools(source));
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
  }
}

export function getStoredEntries(
  raw: unknown,
): Array<[string | undefined, unknown]> {
  if (Array.isArray(raw)) return raw.map((value) => [undefined, value]);
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>);
  }
  return [];
}

function getStoredTemplate(value: unknown): CommandTemplateValue | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const template = value as CommandTemplates.CommandTemplateConfig[];
  return CommandTemplates.expandCommandTemplateConfigs({ template }).length > 0
    ? template
    : undefined;
}

function formatTemplateForDescription(template: CommandTemplateValue): string {
  return typeof template === "string" ? template : JSON.stringify(template);
}

export function normalizeStoredTool(
  key: string | undefined,
  value: unknown,
  reservedToolNames: Set<string>,
): { cfg?: RegisteredTool; changed: boolean; warning?: string } {
  if (!value || typeof value !== "object") {
    return {
      changed: true,
      warning: `Invalid tool entry: ${key ?? "<array item>"}`,
    };
  }
  const record = value as Record<string, unknown>;
  const rawName = key ?? (typeof record.name === "string" ? record.name : "");
  const name = normalizeToolName(rawName);
  if (!name) {
    return {
      changed: true,
      warning: `Invalid tool name: ${rawName || key || "<empty>"}`,
    };
  }
  if (reservedToolNames.has(name)) {
    return { changed: true, warning: `Reserved tool name skipped: ${name}` };
  }
  const template = getStoredTemplate(record.template);
  if (!template && typeof record.script === "string") {
    return {
      changed: false,
      warning: `Tool "${name}" uses unsupported script config. Use template because pi-actors cannot load script entries.`,
    };
  }
  if (record.job !== undefined || record.recipe !== undefined) {
    return {
      changed: false,
      warning: `Tool "${name}" uses unsupported job/recipe config. Use template with optional name and async fields.`,
    };
  }
  const keyedRecipeName =
    key !== undefined && typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : undefined;
  if ((keyedRecipeName || typeof record.async === "boolean") && !template) {
    return {
      changed: false,
      warning: `Tool "${name}" uses recipe config without template. Add template to make it a co-located template recipe.`,
    };
  }
  if (!template) {
    return { changed: true, warning: `Tool "${name}" has no template` };
  }
  const recipeName =
    keyedRecipeName ?? (typeof record.async === "boolean" ? name : undefined);
  const recipe: RecipeReferences.TemplateRecipeConfig | undefined = recipeName
    ? {
        name: recipeName,
        ...(typeof record.async === "boolean" ? { async: record.async } : {}),
        ...(typeof record.state_dir === "string" && record.state_dir.trim()
          ? { state_dir: record.state_dir.trim() }
          : {}),
        template,
        ...(record.values &&
        typeof record.values === "object" &&
        !Array.isArray(record.values)
          ? { values: record.values as Record<string, unknown> }
          : {}),
      }
    : undefined;
  const isRecipe = RecipeReferences.isRecipeTool(template, recipe);
  const recipeTemplate = RecipeReferences.getRecipeTemplate(template);
  const argTemplate = recipeTemplate ?? template;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : isRecipe
        ? `${recipe?.async === true || RecipeReferences.isAsyncRecipeReference(template) ? "Start async" : "Execute"} template recipe: ${recipe?.name ?? formatTemplateForDescription(template)}`
        : `Execute command template: ${formatTemplateForDescription(template)}`;
  const declarations = Schema.normalizeStoredToolArgDeclarations(
    record.args,
    record.defaults,
  );
  const storedArgs = declarations.provided
    ? declarations.declarations
    : undefined;
  const storedDefaults =
    declarations.provided && Object.keys(declarations.defaults).length > 0
      ? declarations.defaults
      : undefined;
  const argTemplateConfig: CommandTemplates.CommandTemplateConfig =
    typeof argTemplate === "object" && !Array.isArray(argTemplate)
      ? {
          ...argTemplate,
          ...(storedArgs !== undefined ? { args: storedArgs } : {}),
          defaults: {
            ...(argTemplate.defaults ?? {}),
            ...declarations.defaults,
          },
        }
      : {
          args: storedArgs,
          defaults: declarations.defaults,
          template: argTemplate,
        };
  const inferredArgTypes = Schema.getTemplateArgTypes(argTemplateConfig);
  const argTypes = { ...inferredArgTypes, ...declarations.argTypes };
  const cfg = {
    name,
    description,
    args:
      isRecipe && storedArgs !== undefined
        ? Schema.getExplicitToolArgNames(storedArgs)
        : RecipeReferences.isRecipeReference(template) && !recipeTemplate
          ? Schema.getExplicitToolArgNames(storedArgs)
          : Schema.getToolArgNames(argTemplateConfig),
    defaults: declarations.defaults,
    ...(Object.keys(argTypes).length > 0 ? { argTypes } : {}),
    ...(recipe ? { recipe } : {}),
    template,
    ...(storedArgs !== undefined ? { storedArgs } : {}),
    ...(storedDefaults !== undefined ? { storedDefaults } : {}),
  };
  const changed =
    (key === undefined && record.name !== undefined) ||
    record.label !== undefined ||
    JSON.stringify(record.template) !== JSON.stringify(template) ||
    description !== record.description ||
    declarations.changed;
  return { cfg, changed };
}

export function loadToolConfig(
  path: string,
  reservedToolNames: Set<string>,
): LoadConfigResult {
  const warnings: string[] = [];
  const tools = new Map<string, RegisteredTool>();
  let changed = false;
  if (!existsSync(path)) return { tools, warnings, changed };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const entries = getStoredEntries(raw);
    for (const [key, value] of entries) {
      const result = normalizeStoredTool(key, value, reservedToolNames);
      changed = changed || result.changed;
      if (result.warning) warnings.push(result.warning);
      if (!result.cfg) continue;
      if (tools.has(result.cfg.name)) {
        warnings.push(
          `Duplicate tool kept from last entry: ${result.cfg.name}`,
        );
      }
      if (tools.has(result.cfg.name)) changed = true;
      tools.set(result.cfg.name, result.cfg);
    }
    if (entries.length === 0 && raw && typeof raw !== "object") {
      warnings.push(`Invalid ${path} format`);
    }
    if (entries.length === 0 && raw && typeof raw !== "object") changed = true;
    return { tools, warnings, changed };
  } catch (error) {
    return {
      tools,
      warnings: [`Failed to load ${path}: ${getErrorMessage(error)}`],
      changed: false,
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
