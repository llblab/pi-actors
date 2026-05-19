/**
 * Template recipe reference helpers
 * Zones: registry config, async runs, path resolution
 * Owns detection, loading, and recipe-layer expansion for template recipe files
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import type {
  CommandTemplateConfig,
  CommandTemplateValue,
} from "./command-templates.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Paths from "./paths.ts";

export interface TemplateRecipeImportBinding {
  from?: string;
  defaults?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export type TemplateRecipeImport = string | TemplateRecipeImportBinding;

export interface TemplateRecipeDefinition {
  name?: string;
  imports?: Record<string, TemplateRecipeImport>;
  template: CommandTemplateValue;
  args?: string[];
  defaults?: Record<string, unknown>;
  parallel?: boolean;
  label?: string;
  when?: boolean | string;
  timeout?: number | string;
  delay?: number | string;
  output?: string;
  retry?: number | string;
  failure?: CommandTemplates.CommandTemplateFailureScope;
  recover?: CommandTemplateValue;
  repeat?: number;
  values?: Record<string, unknown>;
}

export interface TemplateRecipeConfig extends TemplateRecipeDefinition {
  async?: boolean;
  state_dir?: string;
}

interface ImportedRecipe {
  alias: string;
  file: string;
  name: string;
  config: TemplateRecipeDefinition;
  defaults: Record<string, unknown>;
  values: Record<string, unknown>;
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

export function resolveRecipePath(
  value: string,
  recipeRoot = Paths.getRecipeRoot(),
): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed.includes("/")) return resolve(trimmed);
  return resolve(
    recipeRoot,
    trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`,
  );
}

export function getRecipePath(
  value: unknown,
  recipeRoot = Paths.getRecipeRoot(),
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || hasWhitespace(trimmed)) return undefined;
  if (trimmed.endsWith(".json")) return resolveRecipePath(trimmed, recipeRoot);
  const path = resolveRecipePath(trimmed, recipeRoot);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return raw && typeof raw === "object" && Object.hasOwn(raw, "template")
      ? path
      : undefined;
  } catch {
    return undefined;
  }
}

function isImportNode(value: unknown): boolean {
  if (!isRecord(value) || Object.hasOwn(value, "template")) return false;
  return typeof value.name === "string";
}

function isValidRecipeTemplateNode(value: unknown): boolean {
  if (isImportNode(value)) return true;
  if (isRecord(value)) {
    if (isImportNode(value.template)) return true;
    if (Array.isArray(value.template))
      return isValidRecipeTemplateArray(value.template);
  }
  return (
    CommandTemplates.expandCommandTemplateConfigs(
      value as CommandTemplateConfig,
    ).length > 0
  );
}

function isValidRecipeTemplateArray(value: unknown[]): boolean {
  return (
    value.length > 0 && value.every((item) => isValidRecipeTemplateNode(item))
  );
}

function normalizeRecipeTemplate(
  value: unknown,
): CommandTemplateValue | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const template = value as CommandTemplateConfig[];
    return isValidRecipeTemplateArray(template) ? template : undefined;
  }
  if (isImportNode(value))
    return value as CommandTemplates.CommandTemplateObjectConfig;
  if (value && typeof value === "object") {
    const template = value as CommandTemplates.CommandTemplateObjectConfig;
    if (
      Array.isArray(template.template) &&
      isValidRecipeTemplateArray(template.template)
    )
      return template;
    if (isImportNode(template.template)) return template;
    return CommandTemplates.expandCommandTemplateConfigs(template).length > 0
      ? template
      : undefined;
  }
  return undefined;
}

function getRecipeCommandTemplate(
  raw: Record<string, unknown>,
): CommandTemplateValue | undefined {
  const template = raw.template;
  const envelope: Record<string, unknown> = {};
  for (const key of [
    "args",
    "defaults",
    "parallel",
    "label",
    "when",
    "timeout",
    "delay",
    "output",
    "retry",
    "failure",
    "recover",
    "repeat",
  ] as const) {
    if (raw[key] !== undefined) envelope[key] = raw[key];
  }
  if (Object.keys(envelope).length === 0)
    return normalizeRecipeTemplate(template);
  if (template && typeof template === "object" && !Array.isArray(template)) {
    return normalizeRecipeTemplate({
      ...envelope,
      ...(template as Record<string, unknown>),
    });
  }
  return normalizeRecipeTemplate({ ...envelope, template });
}

function readRawRecipeConfig(
  path: string,
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return raw && typeof raw === "object" && !Object.hasOwn(raw, "tool")
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

function readRecipeConfig(value: unknown): TemplateRecipeConfig | undefined {
  const path = getRecipePath(value);
  return path ? readResolvedRecipeConfig(path) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getRecipeImports(
  raw: Record<string, unknown>,
): Record<string, TemplateRecipeImport> {
  if (!isRecord(raw.imports)) return {};
  const result: Record<string, TemplateRecipeImport> = {};
  for (const [alias, value] of Object.entries(raw.imports)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(alias))
      throw new Error(`Invalid recipe import alias: ${alias}`);
    if (typeof value === "string") {
      result[alias] = value;
      continue;
    }
    if (!isRecord(value))
      throw new Error(`Recipe import must be a string or object: ${alias}`);
    const from = typeof value.from === "string" ? value.from.trim() : "";
    if (!from) throw new Error(`Recipe import must define from: ${alias}`);
    result[alias] = {
      from,
      ...(isRecord(value.defaults) ? { defaults: value.defaults } : {}),
      ...(isRecord(value.values) ? { values: value.values } : {}),
    };
  }
  return result;
}

function getImportFrom(value: TemplateRecipeImport): string {
  return typeof value === "string" ? value : (value.from ?? "");
}

function getPathValue(source: unknown, path: string | undefined): unknown {
  if (!path) return source;
  let current = source;
  for (const key of path.split(".")) {
    if (!key) continue;
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function resolveImportRef(
  ref: string,
  imports: Record<string, ImportedRecipe>,
  allowMissing = false,
): { matched: boolean; value: unknown } {
  for (const [alias, imported] of Object.entries(imports)) {
    const prefix = `${alias}.`;
    if (!ref.startsWith(prefix)) continue;
    const rest = ref.slice(prefix.length);
    const match = /^(name|file|defaults|values)(?:\.(.+))?$/.exec(rest);
    if (!match) return { matched: false, value: undefined };
    const section = match[1];
    if (section === "name") return { matched: true, value: imported.name };
    if (section === "file") return { matched: true, value: imported.file };
    const value = section === "defaults" ? imported.defaults : imported.values;
    const resolved = getPathValue(value, match[2]);
    if (resolved === undefined && !allowMissing)
      throw new Error(`Unknown recipe import reference: ${ref}`);
    return { matched: true, value: resolved };
  }
  return { matched: false, value: undefined };
}

function isFalsyImportValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === ""
  );
}

function parseImportLiteral(
  value: string,
  imports: Record<string, ImportedRecipe>,
): unknown {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/);
  if (quoted) return quoted[2];
  const resolved = resolveImportRef(trimmed, imports, true);
  return resolved.matched ? resolved.value : trimmed;
}

function evaluateImportExpression(
  content: string,
  imports: Record<string, ImportedRecipe>,
): { matched: boolean; value: unknown } {
  const trimmed = content.trim();
  const ternary = trimmed.match(/^(.+?)\?([^:]*):(.*)$/);
  if (ternary) {
    const condition = resolveImportRef(ternary[1].trim(), imports, true);
    if (!condition.matched) return { matched: false, value: undefined };
    return {
      matched: true,
      value: parseImportLiteral(
        isFalsyImportValue(condition.value) ? ternary[3] : ternary[2],
        imports,
      ),
    };
  }
  const fallback = trimmed.match(/^([^=]+)=(.*)$/);
  if (fallback) {
    const resolved = resolveImportRef(fallback[1].trim(), imports, true);
    if (!resolved.matched) return { matched: false, value: undefined };
    return {
      matched: true,
      value:
        resolved.value === undefined || resolved.value === null
          ? parseImportLiteral(fallback[2], imports)
          : resolved.value,
    };
  }
  return resolveImportRef(trimmed, imports);
}

function substituteImportRefs(
  value: unknown,
  imports: Record<string, ImportedRecipe>,
): unknown {
  if (typeof value === "string") {
    const exact = /^\{([^{}]+)\}$/.exec(value);
    if (exact) {
      const resolved = evaluateImportExpression(exact[1], imports);
      if (resolved.matched) return resolved.value;
    }
    return value.replaceAll(/\{([^{}]+)\}/g, (token, ref) => {
      const resolved = evaluateImportExpression(String(ref), imports);
      return resolved.matched ? String(resolved.value ?? "") : token;
    });
  }
  if (Array.isArray(value))
    return value.map((item) => substituteImportRefs(item, imports));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value))
      result[key] = substituteImportRefs(child, imports);
    return result;
  }
  return value;
}

function mergeDefaults(
  ...items: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...items.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function applyDefaultsToTemplate(
  template: CommandTemplateValue,
  defaults: Record<string, unknown> | undefined,
  overrides: Record<string, unknown>,
): CommandTemplateValue {
  const cleanOverrides = { ...overrides };
  delete cleanOverrides.name;
  delete cleanOverrides.values;
  if (typeof template === "object" && !Array.isArray(template)) {
    return {
      ...template,
      ...cleanOverrides,
      ...(mergeDefaults(
        template.defaults,
        defaults,
        isRecord(cleanOverrides.defaults) ? cleanOverrides.defaults : undefined,
      )
        ? {
            defaults: mergeDefaults(
              template.defaults,
              defaults,
              isRecord(cleanOverrides.defaults)
                ? cleanOverrides.defaults
                : undefined,
            ),
          }
        : {}),
    } as CommandTemplates.CommandTemplateObjectConfig;
  }
  return {
    ...cleanOverrides,
    ...(defaults ? { defaults } : {}),
    template,
  } as CommandTemplates.CommandTemplateObjectConfig;
}

function expandImportNodes(
  value: CommandTemplateValue,
  imports: Record<string, ImportedRecipe>,
): CommandTemplateValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(
      (item) => expandImportNodes(item, imports) as CommandTemplateConfig,
    );
  }
  const record = value as Record<string, unknown>;
  const importAlias =
    !Object.hasOwn(record, "template") && typeof record.name === "string"
      ? record.name
      : undefined;
  if (importAlias) {
    const imported = imports[importAlias];
    if (!imported) throw new Error(`Unknown recipe import: ${importAlias}`);
    const nodeDefaults = isRecord(record.defaults)
      ? record.defaults
      : undefined;
    const nodeValues = isRecord(record.values) ? record.values : undefined;
    const defaults = mergeDefaults(
      imported.defaults,
      imported.values,
      nodeDefaults,
      nodeValues,
    );
    return applyDefaultsToTemplate(imported.config.template, defaults, record);
  }
  if (Array.isArray(record.template)) {
    return {
      ...record,
      template: record.template.map(
        (item) =>
          expandImportNodes(
            item as CommandTemplateValue,
            imports,
          ) as CommandTemplateConfig,
      ),
    } as CommandTemplates.CommandTemplateObjectConfig;
  }
  if (record.template && typeof record.template === "object") {
    return {
      ...record,
      template: expandImportNodes(
        record.template as CommandTemplateValue,
        imports,
      ),
    } as CommandTemplates.CommandTemplateObjectConfig;
  }
  return value;
}

export function readResolvedRecipeConfig(
  file: string,
  stack: string[] = [],
): TemplateRecipeConfig | undefined {
  const path = resolveRecipePath(
    file,
    stack.length > 0 ? dirname(stack.at(-1)!) : Paths.getRecipeRoot(),
  );
  if (stack.includes(path)) {
    throw new Error(`Cyclic recipe import: ${[...stack, path].join(" -> ")}`);
  }
  const raw = readRawRecipeConfig(path);
  if (!raw || !Object.hasOwn(raw, "template")) return undefined;
  const imports: Record<string, ImportedRecipe> = {};
  for (const [alias, binding] of Object.entries(getRecipeImports(raw))) {
    const importPath = resolveRecipePath(getImportFrom(binding), dirname(path));
    const config = readResolvedRecipeConfig(importPath, [...stack, path]);
    if (!config) throw new Error(`Recipe import not found: ${alias}`);
    const bindingDefaults =
      typeof binding === "string" ? undefined : binding.defaults;
    const bindingValues =
      typeof binding === "string" ? undefined : binding.values;
    imports[alias] = {
      alias,
      file: importPath,
      name: config.name ?? alias,
      config,
      defaults: { ...(config.defaults ?? {}), ...(bindingDefaults ?? {}) },
      values: { ...(bindingValues ?? {}) },
    };
  }
  const substituted = substituteImportRefs(raw, imports) as Record<
    string,
    unknown
  >;
  const template = getRecipeCommandTemplate(substituted);
  if (!template) return undefined;
  const expandedTemplate = expandImportNodes(template, imports);
  return {
    ...(typeof substituted.name === "string" ? { name: substituted.name } : {}),
    ...(substituted.async === true
      ? { async: true }
      : substituted.async === false
        ? { async: false }
        : {}),
    ...(typeof substituted.state_dir === "string"
      ? { state_dir: substituted.state_dir }
      : {}),
    ...(Object.keys(imports).length > 0
      ? { imports: getRecipeImports(raw) }
      : {}),
    template: expandedTemplate,
    ...(Array.isArray(substituted.args)
      ? { args: substituted.args as string[] }
      : {}),
    ...(isRecord(substituted.defaults)
      ? { defaults: substituted.defaults }
      : {}),
    ...(typeof substituted.parallel === "boolean"
      ? { parallel: substituted.parallel }
      : {}),
    ...(typeof substituted.label === "string"
      ? { label: substituted.label }
      : {}),
    ...(typeof substituted.when === "string" || typeof substituted.when === "boolean"
      ? { when: substituted.when }
      : {}),
    ...(typeof substituted.timeout === "number" || typeof substituted.timeout === "string"
      ? { timeout: substituted.timeout }
      : {}),
    ...(typeof substituted.delay === "number" || typeof substituted.delay === "string"
      ? { delay: substituted.delay }
      : {}),
    ...(typeof substituted.output === "string"
      ? { output: substituted.output }
      : {}),
    ...(typeof substituted.retry === "number" || typeof substituted.retry === "string"
      ? { retry: substituted.retry }
      : {}),
    ...(substituted.failure === "continue" ||
    substituted.failure === "branch" ||
    substituted.failure === "root"
      ? { failure: substituted.failure }
      : {}),
    ...(substituted.recover !== undefined
      ? { recover: substituted.recover as CommandTemplateValue }
      : {}),
    ...(typeof substituted.repeat === "number"
      ? { repeat: substituted.repeat }
      : {}),
    ...(isRecord(substituted.values) ? { values: substituted.values } : {}),
  };
}

export function getRecipeTemplate(
  value: unknown,
): CommandTemplateValue | undefined {
  return readRecipeConfig(value)?.template;
}

export function isRecipeReference(value: unknown): boolean {
  return getRecipePath(value) !== undefined;
}

export function isAsyncRecipeReference(value: unknown): boolean {
  return readRecipeConfig(value)?.async === true;
}

export function isRecipeTool(
  template: unknown,
  recipe: TemplateRecipeConfig | undefined,
): boolean {
  return recipe !== undefined || isRecipeReference(template);
}
