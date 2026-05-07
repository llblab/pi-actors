/**
 * Auto-tools schema helpers
 * Zones: tool schema, registry args, command-template placeholders
 * Owns tool argument declarations, placeholder-derived tool schemas, and persisted registry normalization
 */

import * as CommandTemplates from "./command-templates.ts";

export interface ToolArgSpec {
  args: string[];
  defaults: Record<string, string>;
  error?: string;
}

function mergeUnique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

export function parseToolArgToken(value: string): {
  arg: string;
  defaultValue?: string;
} {
  const separatorIndex = value.indexOf("=");
  const rawName =
    separatorIndex === -1 ? value : value.slice(0, separatorIndex);
  const arg = rawName.trim();
  const defaultValue =
    separatorIndex === -1 ? undefined : value.slice(separatorIndex + 1).trim();
  return { arg, defaultValue };
}

export function parseToolArgDeclarations(value: string): ToolArgSpec {
  const source = value
    .split(",")
    .map((arg) => arg.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const args: string[] = [];
  const defaults: Record<string, string> = {};
  for (const item of source) {
    const parsed = parseToolArgToken(item);
    if (!parsed.arg) continue;
    if (seen.has(parsed.arg)) duplicates.add(parsed.arg);
    seen.add(parsed.arg);
    args.push(parsed.arg);
    if (parsed.defaultValue !== undefined)
      defaults[parsed.arg] = parsed.defaultValue;
  }
  if (duplicates.size > 0) {
    return {
      args: [],
      defaults: {},
      error: `Duplicate argument name(s): ${[...duplicates].join(", ")}`,
    };
  }
  return { args, defaults };
}

export function normalizeStoredToolArgDeclarations(
  argsValue: unknown,
  defaultsValue: unknown,
): ToolArgSpec & { changed: boolean; provided: boolean } {
  const provided = argsValue !== undefined || defaultsValue !== undefined;
  const source = Array.isArray(argsValue)
    ? argsValue
    : typeof argsValue === "string"
      ? argsValue.split(",")
      : [];
  const rawDefaults =
    defaultsValue && typeof defaultsValue === "object"
      ? (defaultsValue as Record<string, unknown>)
      : {};
  const seen = new Set<string>();
  const args: string[] = [];
  const defaults: Record<string, string> = {};
  for (const item of source) {
    const parsed = parseToolArgToken(String(item).trim());
    if (!parsed.arg || seen.has(parsed.arg)) continue;
    seen.add(parsed.arg);
    args.push(parsed.arg);
    const storedDefault = rawDefaults[parsed.arg];
    if (typeof storedDefault === "string") defaults[parsed.arg] = storedDefault;
    else if (parsed.defaultValue !== undefined)
      defaults[parsed.arg] = parsed.defaultValue;
  }
  for (const [key, value] of Object.entries(rawDefaults)) {
    const arg = key.trim();
    if (!arg || Object.hasOwn(defaults, arg)) continue;
    defaults[arg] = value === undefined || value === null ? "" : String(value);
  }
  const canonicalArgs = argsValue === undefined ? undefined : args;
  const canonicalDefaults = Object.keys(defaults).length > 0 ? defaults : {};
  const changed =
    provided &&
    (JSON.stringify(canonicalArgs ?? []) !== JSON.stringify(argsValue ?? []) ||
      JSON.stringify(canonicalDefaults) !== JSON.stringify(defaultsValue ?? {}));
  return { args, changed, defaults, provided };
}

export function formatToolArgs(args: string[]): string {
  return args.length > 0 ? args.join(", ") : "none";
}

export function getTemplatePlaceholderNames(
  config: CommandTemplates.CommandTemplateConfig,
): string[] {
  const names: string[] = [];
  for (const step of CommandTemplates.expandCommandTemplateConfigs(config)) {
    for (const match of step.template.matchAll(
      /\{([A-Za-z_][A-Za-z0-9_-]*)(?:=([^}]*))?\}/g,
    )) {
      names.push(match[1]);
    }
  }
  return mergeUnique(names);
}

export function getExplicitToolArgNames(args: string[] | undefined): string[] {
  return mergeUnique((args ?? []).map((item) => parseToolArgToken(String(item)).arg));
}

export function getToolArgNames(
  config: CommandTemplates.CommandTemplateConfig,
): string[] {
  const normalizedConfig = CommandTemplates.normalizeCommandTemplateConfig(config);
  const declaredArgs = Array.isArray(normalizedConfig.args)
    ? normalizedConfig.args.map((item) => parseToolArgToken(String(item)).arg)
    : [];
  return mergeUnique([
    ...declaredArgs,
    ...getTemplatePlaceholderNames(config),
  ]);
}

export function getRequiredToolArgNames(
  config: CommandTemplates.CommandTemplateConfig,
): Set<string> {
  const required = new Set<string>();
  for (const step of CommandTemplates.expandCommandTemplateConfigs(config)) {
    const defaults = CommandTemplates.getCommandTemplateDefaults(step);
    for (const match of step.template.matchAll(
      /\{([A-Za-z_][A-Za-z0-9_-]*)(?:=([^}]*))?\}/g,
    )) {
      const name = match[1];
      const inlineDefault = match[2];
      if (inlineDefault === undefined && !Object.hasOwn(defaults, name))
        required.add(name);
    }
  }
  return required;
}
