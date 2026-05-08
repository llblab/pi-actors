/**
 * Persistent tool registry config helpers
 * Zones: registry config, persistence, migration boundary
 * Owns auto-tools.json loading, normalization, legacy rejection, serialization, and atomic writes
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { normalizeToolName } from "./identity.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as JobReferences from "./job-references.ts";
import * as Schema from "./schema.ts";
import type { CommandTemplateValue } from "./command-templates.ts";

export interface RegisteredTool {
  name: string;
  description: string;
  args: string[];
  defaults: Record<string, string>;
  jobRecipe?: JobReferences.JobRecipeConfig;
  template?: CommandTemplateValue;
  storedArgs?: string[];
  storedDefaults?: Record<string, string>;
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
    if (cfg.jobRecipe?.job) entry.job = cfg.jobRecipe.job;
    if (cfg.jobRecipe?.state_dir) entry.state_dir = cfg.jobRecipe.state_dir;
    if (cfg.jobRecipe?.stateDir) entry.stateDir = cfg.jobRecipe.stateDir;
    if (cfg.jobRecipe?.values) entry.values = cfg.jobRecipe.values;
    if (cfg.template) entry.template = cfg.template;
    result[name] = entry;
  }
  return result;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
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
  const rawName = typeof record.name === "string" ? record.name : (key ?? "");
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
      warning: `Tool "${name}" uses legacy script config. Migrate to template because pi-auto-tools v0.2.0 cannot load it.`,
    };
  }
  if (Object.hasOwn(record, "tool")) {
    return { changed: false, warning: `Tool "${name}" cannot define tool; use template directly.` };
  }
  if (typeof record.job === "string" && !template) {
    return { changed: false, warning: `Tool "${name}" uses legacy job config. Add template to make it a co-located job recipe, or migrate to a template job recipe path.` };
  }
  if (!template) {
    return { changed: true, warning: `Tool "${name}" has no template` };
  }
  const jobRecipe = typeof record.job === "string" && record.job.trim()
    ? {
      job: record.job.trim(),
      ...(typeof record.state_dir === "string" && record.state_dir.trim() ? { state_dir: record.state_dir.trim() } : {}),
      ...(typeof record.stateDir === "string" && record.stateDir.trim() ? { stateDir: record.stateDir.trim() } : {}),
      template,
      ...(record.values && typeof record.values === "object" && !Array.isArray(record.values) ? { values: record.values as Record<string, unknown> } : {}),
    }
    : undefined;
  const isJobRecipe = JobReferences.isJobRecipeTool(template, jobRecipe);
  const recipeTemplate = JobReferences.getJobRecipeTemplate(template);
  const argTemplate = recipeTemplate ?? template;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : isJobRecipe
        ? `Start template job: ${jobRecipe?.job ?? formatTemplateForDescription(template)}`
        : `Execute command template: ${formatTemplateForDescription(template)}`;
  const declarations = Schema.normalizeStoredToolArgDeclarations(
    record.args,
    record.defaults,
  );
  const storedArgs = declarations.provided ? declarations.args : undefined;
  const storedDefaults =
    declarations.provided && Object.keys(declarations.defaults).length > 0
      ? declarations.defaults
      : undefined;
  const cfg = {
    name,
    description,
    args: isJobRecipe && storedArgs !== undefined
      ? Schema.getExplicitToolArgNames(storedArgs)
      : JobReferences.isJobRecipeReference(template) && !recipeTemplate
        ? Schema.getExplicitToolArgNames(storedArgs)
        : Schema.getToolArgNames({
        args: storedArgs,
        defaults: declarations.defaults,
        template: argTemplate,
      }),
    defaults: declarations.defaults,
    ...(jobRecipe ? { jobRecipe } : {}),
    template,
    ...(storedArgs !== undefined ? { storedArgs } : {}),
    ...(storedDefaults !== undefined ? { storedDefaults } : {}),
  };
  const changed =
    record.name !== undefined ||
    record.label !== undefined ||
    JSON.stringify(record.template) !== JSON.stringify(template) ||
    (record.job !== undefined && !jobRecipe) ||
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
