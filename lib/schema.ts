/**
 * Auto-tools schema helpers
 * Zones: tool schema, registry args, command-template placeholders
 * Owns tool argument declarations, placeholder-derived tool schemas, and persisted registry normalization
 */

import * as CommandTemplates from "./command-templates.ts";

export type ToolArgType =
  | { kind: "string" }
  | { kind: "path" }
  | { kind: "int" }
  | { kind: "number" }
  | { kind: "bool" }
  | { kind: "array" }
  | { kind: "enum"; values: string[] };

export interface ParsedToolArgToken {
  arg: string;
  defaultValue?: string;
  declaration: string;
  type: ToolArgType;
}

export interface ToolArgSpec {
  args: string[];
  argTypes: Record<string, ToolArgType>;
  declarations: string[];
  defaults: Record<string, string>;
  error?: string;
}

function mergeUnique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function parseArgType(value: string | undefined): ToolArgType | undefined {
  const source = value?.trim();
  if (!source) return { kind: "string" };
  if (source === "string") return { kind: "string" };
  if (source === "path") return { kind: "path" };
  if (source === "int") return { kind: "int" };
  if (source === "number") return { kind: "number" };
  if (source === "bool") return { kind: "bool" };
  if (source === "array") return { kind: "array" };
  const enumMatch = source.match(/^enum\(([^)]*)\)$/);
  if (enumMatch) {
    const values = enumMatch[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? { kind: "enum", values } : undefined;
  }
  return undefined;
}

function splitArgDeclarations(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(" ) depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function canonicalArgDeclaration(arg: string, type: ToolArgType): string {
  switch (type.kind) {
    case "string":
      return arg;
    case "path":
    case "int":
    case "number":
    case "bool":
    case "array":
      return `${arg}:${type.kind}`;
    case "enum":
      return `${arg}:enum(${type.values.join(",")})`;
  }
}

export function parseToolArgToken(value: string): ParsedToolArgToken {
  const separatorIndex = value.indexOf("=");
  const rawName =
    separatorIndex === -1 ? value : value.slice(0, separatorIndex);
  const defaultValue =
    separatorIndex === -1 ? undefined : value.slice(separatorIndex + 1).trim();
  const typedMatch = rawName.trim().match(/^([^:\s]+)(?::(.+))?$/);
  if (!typedMatch) {
    return {
      arg: rawName.trim(),
      defaultValue,
      declaration: rawName.trim(),
      type: { kind: "string" },
    };
  }
  const arg = typedMatch[1].trim();
  const type = parseArgType(typedMatch[2]) ?? { kind: "string" };
  return { arg, defaultValue, declaration: canonicalArgDeclaration(arg, type), type };
}

function isValidDefault(type: ToolArgType, value: string): boolean {
  switch (type.kind) {
    case "int":
      return /^-?\d+$/.test(value);
    case "number":
      return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value);
    case "bool":
      return /^(?:true|false|1|0|yes|no)$/i.test(value);
    case "enum":
      return type.values.includes(value);
    case "path":
    case "array":
    case "string":
      return true;
  }
}

export function parseToolArgDeclarations(value: string): ToolArgSpec {
  const source = splitArgDeclarations(value);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const args: string[] = [];
  const argTypes: Record<string, ToolArgType> = {};
  const declarations: string[] = [];
  const defaults: Record<string, string> = {};
  for (const item of source) {
    const parsed = parseToolArgToken(item);
    if (!parsed.arg) continue;
    if (seen.has(parsed.arg)) duplicates.add(parsed.arg);
    seen.add(parsed.arg);
    args.push(parsed.arg);
    if (parsed.type.kind !== "string") argTypes[parsed.arg] = parsed.type;
    declarations.push(parsed.declaration);
    if (parsed.defaultValue !== undefined) {
      if (!isValidDefault(parsed.type, parsed.defaultValue)) {
        return {
          args: [],
          argTypes: {},
          declarations: [],
          defaults: {},
          error: `Invalid default for ${parsed.arg}:${parsed.type.kind}`,
        };
      }
      defaults[parsed.arg] = parsed.defaultValue;
    }
  }
  if (duplicates.size > 0) {
    return {
      args: [],
      argTypes: {},
      declarations: [],
      defaults: {},
      error: `Duplicate argument name(s): ${[...duplicates].join(", ")}`,
    };
  }
  return { args, argTypes, declarations, defaults };
}

export function normalizeStoredToolArgDeclarations(
  argsValue: unknown,
  defaultsValue: unknown,
): ToolArgSpec & { changed: boolean; provided: boolean } {
  const provided = argsValue !== undefined || defaultsValue !== undefined;
  const source = Array.isArray(argsValue)
    ? argsValue
    : typeof argsValue === "string"
      ? splitArgDeclarations(argsValue)
      : [];
  const rawDefaults =
    defaultsValue && typeof defaultsValue === "object"
      ? (defaultsValue as Record<string, unknown>)
      : {};
  const seen = new Set<string>();
  const args: string[] = [];
  const argTypes: Record<string, ToolArgType> = {};
  const declarations: string[] = [];
  const defaults: Record<string, string> = {};
  for (const item of source) {
    const parsed = parseToolArgToken(String(item).trim());
    if (!parsed.arg || seen.has(parsed.arg)) continue;
    seen.add(parsed.arg);
    args.push(parsed.arg);
    if (parsed.type.kind !== "string") argTypes[parsed.arg] = parsed.type;
    declarations.push(parsed.declaration);
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
  const canonicalArgs = argsValue === undefined ? undefined : declarations;
  const canonicalDefaults = Object.keys(defaults).length > 0 ? defaults : {};
  const changed =
    provided &&
    (JSON.stringify(canonicalArgs ?? []) !== JSON.stringify(argsValue ?? []) ||
      JSON.stringify(canonicalDefaults) !== JSON.stringify(defaultsValue ?? {}));
  return { args, argTypes, changed, declarations, defaults, provided };
}

export function formatToolArgs(args: string[]): string {
  return args.length > 0 ? args.join(", ") : "none";
}

function parseTemplatePlaceholderDeclaration(content: string): ParsedToolArgToken | undefined {
  if (content.startsWith("_(")) return undefined;
  const typedMatch = content.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?::(?:string|path|int|number|bool|array|enum\([^)]*\)))?(?:=([^}]*))?$/);  if (!typedMatch) return undefined;
  const parsed = parseToolArgToken(content);
  if (!parsed.arg || CommandTemplates.isCommandTemplateRepeatPlaceholder(parsed.arg)) return undefined;
  return parsed;
}

function getTemplatePlaceholderDeclarations(
  config: CommandTemplates.CommandTemplateConfig,
): ParsedToolArgToken[] {
  const declarations: ParsedToolArgToken[] = [];
  for (const step of CommandTemplates.expandCommandTemplateConfigs(config)) {
    for (const match of step.template.matchAll(/\{([^{}]+)\}/g)) {
      const parsed = parseTemplatePlaceholderDeclaration(match[1]);
      if (parsed) declarations.push(parsed);
    }
  }
  return declarations;
}

export function getTemplatePlaceholderNames(
  config: CommandTemplates.CommandTemplateConfig,
): string[] {
  return mergeUnique(getTemplatePlaceholderDeclarations(config).map((item) => item.arg));
}

export function getTemplateArgTypes(
  config: CommandTemplates.CommandTemplateConfig,
): Record<string, ToolArgType> {
  const argTypes: Record<string, ToolArgType> = {};
  for (const declaration of getTemplatePlaceholderDeclarations(config)) {
    if (declaration.type.kind !== "string") argTypes[declaration.arg] = declaration.type;
  }
  return argTypes;
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
    for (const declaration of getTemplatePlaceholderDeclarations(step)) {
      if (declaration.defaultValue === undefined && !Object.hasOwn(defaults, declaration.arg))
        required.add(declaration.arg);
    }
  }
  return required;
}

function normalizeTypedArgValue(name: string, type: ToolArgType, value: unknown): unknown {
  if (value === undefined || value === null) return "";
  switch (type.kind) {
    case "int": {
      if (typeof value === "number" && Number.isInteger(value)) return String(value);
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
      throw new Error(`Argument ${name} must be an integer.`);
    }
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "string" && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return value.trim();
      throw new Error(`Argument ${name} must be a number.`);
    }
    case "bool": {
      if (typeof value === "boolean") return value ? "true" : "false";
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) return "true";
        if (["false", "0", "no"].includes(normalized)) return "false";
      }
      throw new Error(`Argument ${name} must be a boolean.`);
    }
    case "enum": {
      const normalized = String(value);
      if (type.values.includes(normalized)) return normalized;
      throw new Error(`Argument ${name} must be one of: ${type.values.join(", ")}.`);
    }
    case "array": {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Fall through to error.
        }
      }
      throw new Error(`Argument ${name} must be an array.`);
    }
    case "path":
    case "string":
      return String(value);
  }
}

export function normalizeRuntimeValues(
  values: Record<string, unknown>,
  argTypes: Record<string, ToolArgType> | undefined,
): Record<string, unknown> {
  if (!argTypes || Object.keys(argTypes).length === 0) return values;
  const normalized = { ...values };
  for (const [name, type] of Object.entries(argTypes)) {
    if (Object.hasOwn(normalized, name))
      normalized[name] = normalizeTypedArgValue(name, type, normalized[name]);
  }
  return normalized;
}
