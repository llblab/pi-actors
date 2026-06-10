/**
 * Template recipe reference helpers
 * Zones: registry config, async runs, path resolution
 * Owns detection, loading, and recipe-layer expansion for template recipe files
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";

import type {
  CommandTemplateConfig,
  CommandTemplateValue,
} from "./command-templates.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Paths from "./paths.ts";

const MAX_RECIPE_FILE_BYTES = 1024 * 1024;
const MAX_RECIPE_IMPORT_DEPTH = 32;

export interface TemplateRecipeImportBinding {
  from?: string;
  defaults?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export type TemplateRecipeImport = string | TemplateRecipeImportBinding;

export type TemplateRecipeMailboxEntry =
  | string
  | {
      type: string;
      body_schema?: unknown;
      ack?: boolean | string;
      idempotency?: string;
      requires_response?: boolean;
      level?: string;
      summary?: string;
    };

export interface TemplateRecipeMailbox {
  accepts?: TemplateRecipeMailboxEntry[];
  emits?: TemplateRecipeMailboxEntry[];
}

export interface TemplateRecipeDefinition {
  name?: string;
  description?: string;
  disabled?: boolean;
  imports?: Record<string, TemplateRecipeImport>;
  template: CommandTemplateValue;
  args?: string[];
  defaults?: Record<string, unknown>;
  parallel?: boolean;
  concurrency?: number | string;
  min_successful?: number | string;
  label?: string;
  when?: boolean | string;
  timeout?: number | string;
  delay?: number | string;
  output?: string;
  artifacts?: Record<string, string>;
  mailbox?: TemplateRecipeMailbox;
  retire_when?: "children_terminal";
  retry?: number | string;
  failure?: CommandTemplates.CommandTemplateFailureScope;
  recover?: CommandTemplateValue;
  repeat?: number;
  values?: Record<string, unknown>;
  usage?: Record<string, unknown>;
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

export interface TemplateRecipeContextRecord {
  alias?: string;
  depth: number;
  file: string;
  import_path: string[];
  name: string;
  recipe: Record<string, unknown>;
  role: "entry" | "import";
}

export interface ReadResolvedRecipeConfigOptions {
  includeActorRecipeContext?: boolean;
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

export function resolveRecipePath(
  value: string,
  recipeRoot = Paths.getRecipeRoot(),
): string {
  const trimmed = value.trim();
  const repoRoot = resolve(recipeRoot, "..");
  const expanded = trimmed
    .replaceAll("{repo}", repoRoot)
    .replaceAll("{agent}", Paths.getAgentDir());
  if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2));
  if (expanded.includes("/")) return resolve(expanded);
  return resolve(
    recipeRoot,
    expanded.endsWith(".json") || expanded.endsWith(".md")
      ? expanded
      : `${expanded}.json`,
  );
}

function isBareRecipeName(value: string): boolean {
  const trimmed = value.trim();
  return (
    Boolean(trimmed) &&
    !trimmed.includes("/") &&
    !trimmed.startsWith("~") &&
    !trimmed.includes("{")
  );
}

function recipeNameFiles(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.endsWith(".json") || trimmed.endsWith(".md")) return [trimmed];
  return [`${trimmed}.json`, `${trimmed}.md`];
}

function recipeCandidatePaths(
  value: string,
  currentRecipeRoot: string,
): string[] {
  if (!isBareRecipeName(value))
    return [resolveRecipePath(value, currentRecipeRoot)];
  const roots = [
    Paths.getRecipeRoot(),
    currentRecipeRoot,
    Paths.getPackagedRecipeRoot(),
  ];
  return [
    ...new Set(
      roots.flatMap((root) =>
        recipeNameFiles(value).map((file) => resolve(root, file)),
      ),
    ),
  ];
}

function resolveRecipeImportPath(
  value: string,
  currentRecipeRoot: string,
): string {
  const candidates = recipeCandidatePaths(value, currentRecipeRoot);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function resolveRecipeReferencePath(
  value: unknown,
  currentRecipeRoot = Paths.getRecipeRoot(),
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || hasWhitespace(trimmed)) return undefined;
  for (const path of recipeCandidatePaths(trimmed, currentRecipeRoot)) {
    if (!existsSync(path)) continue;
    try {
      const raw = readRawRecipeConfig(path);
      if (raw && typeof raw === "object" && Object.hasOwn(raw, "template"))
        return path;
      return path;
    } catch {
      return path;
    }
  }
  return undefined;
}

export function getRecipePath(
  value: unknown,
  recipeRoot = Paths.getRecipeRoot(),
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || hasWhitespace(trimmed)) return undefined;
  if (trimmed.endsWith(".json") || trimmed.endsWith(".md"))
    return resolveRecipePath(trimmed, recipeRoot);
  return resolveRecipeReferencePath(trimmed, recipeRoot);
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
    "concurrency",
    "min_successful",
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

function parseMarkdownScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  const quoted = trimmed.match(/^(?:"([^"]*)"|'([^']*)')$/);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseMarkdownFrontmatterObject(
  lines: string[],
): Record<string, unknown> | unknown[] {
  if (lines.every((line) => /^\s*-\s+/.test(line))) {
    return lines.map((line) =>
      parseMarkdownScalar(line.replace(/^\s*-\s+/, "")),
    );
  }
  const result: Record<string, unknown> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^\s{2}([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/,
    );
    if (!match) continue;
    if (match[2]) {
      result[match[1]] = parseMarkdownScalar(match[2]);
      continue;
    }
    const nested: string[] = [];
    while (index + 1 < lines.length && /^\s{4}/.test(lines[index + 1])) {
      index += 1;
      nested.push(lines[index].slice(2));
    }
    result[match[1]] = parseMarkdownFrontmatterObject(nested);
  }
  return result;
}

function normalizeMarkdownFrontmatterField(
  key: string,
  value: unknown,
): unknown {
  if (key === "args" && typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (key === "defaults" && Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => {
          const separator = item.indexOf(":");
          return separator < 0
            ? [item.trim(), ""]
            : [
                item.slice(0, separator).trim(),
                parseMarkdownScalar(item.slice(separator + 1)),
              ];
        })
        .filter(([name]) => Boolean(name)),
    );
  }
  return value;
}

function parseMarkdownFrontmatter(value: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = value.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (!match) continue;
    if (match[2]) {
      result[match[1]] = normalizeMarkdownFrontmatterField(
        match[1],
        parseMarkdownScalar(match[2]),
      );
      continue;
    }
    const nested: string[] = [];
    while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
      index += 1;
      nested.push(lines[index]);
    }
    result[match[1]] = normalizeMarkdownFrontmatterField(
      match[1],
      parseMarkdownFrontmatterObject(nested),
    );
  }
  return result;
}

function findMarkdownRecipeFence(
  body: string,
): { info: string; body: string } | undefined {
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of body.matchAll(pattern)) {
    const info = match[1].trim().toLowerCase();
    if (
      info.includes("recipe") ||
      info.includes("template") ||
      info.includes("command") ||
      info.includes("json")
    ) {
      return { info, body: match[2].trim() };
    }
  }
  return undefined;
}

function parseMarkdownRecipeConfig(
  content: string,
): Record<string, unknown> | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end === -1) return undefined;
  const frontmatter = parseMarkdownFrontmatter(lines.slice(1, end).join("\n"));
  const fence = findMarkdownRecipeFence(lines.slice(end + 1).join("\n"));
  if (!fence)
    return Object.hasOwn(frontmatter, "template") ? frontmatter : undefined;
  const text = fence.body.trim();
  if (!text) return undefined;
  if (
    fence.info.includes("json") ||
    fence.info.includes("recipe") ||
    text.startsWith("{") ||
    text.startsWith("[") ||
    text.startsWith('"')
  ) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed) && Object.hasOwn(parsed, "template"))
        return { ...frontmatter, ...parsed };
      return { ...frontmatter, template: parsed };
    } catch {
      if (fence.info.includes("json") || fence.info.includes("recipe"))
        return undefined;
    }
  }
  return { ...frontmatter, template: text };
}

export function diagnoseRawRecipeConfigFailure(
  path: string,
): string | undefined {
  if (!existsSync(path)) return "file does not exist";
  const size = statSync(path).size;
  if (size > MAX_RECIPE_FILE_BYTES) {
    return `file exceeds size limit ${MAX_RECIPE_FILE_BYTES} bytes`;
  }
  try {
    const content = readFileSync(path, "utf8");
    if (path.endsWith(".md")) {
      const lines = content.split(/\r?\n/);
      if (lines[0]?.trim() !== "---") {
        return "Markdown recipe must start with frontmatter";
      }
      const end = lines.findIndex(
        (line, index) => index > 0 && line.trim() === "---",
      );
      if (end === -1) return "Markdown recipe frontmatter is not closed";
      const parsed = parseMarkdownRecipeConfig(content);
      if (!parsed)
        return "Markdown recipe has no executable recipe/template fence";
      if (!Object.hasOwn(parsed, "template"))
        return "recipe must define template";
      return undefined;
    }
    const raw = JSON.parse(content) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return "JSON recipe must be an object";
    }
    if (!Object.hasOwn(raw, "template")) return "recipe must define template";
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function readRawRecipeConfig(
  path: string,
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const size = statSync(path).size;
  if (size > MAX_RECIPE_FILE_BYTES) {
    throw new Error(
      `Recipe file exceeds size limit ${MAX_RECIPE_FILE_BYTES} bytes: ${path}`,
    );
  }
  try {
    const content = readFileSync(path, "utf8");
    if (path.endsWith(".md")) return parseMarkdownRecipeConfig(content);
    const raw = JSON.parse(content) as Record<string, unknown>;
    return raw && typeof raw === "object" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function getRecipeIdFromPath(file: string): string {
  return basename(file, extname(file));
}

function readRecipeConfig(value: unknown): TemplateRecipeConfig | undefined {
  const path = resolveRecipeReferencePath(value);
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
  delete cleanOverrides.template;
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

function withActorRecipeContext(
  value: CommandTemplateValue,
  context: CommandTemplates.CommandTemplateActorRecipeContext,
): CommandTemplateValue {
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...value, actorRecipeContext: context };
  }
  return { actorRecipeContext: context, template: value };
}

function loadDelegatedRecipe(
  value: unknown,
  currentRecipeFile: string,
  stack: string[],
  options: ReadResolvedRecipeConfigOptions,
): TemplateRecipeConfig | undefined {
  const path = resolveRecipeReferencePath(value, dirname(currentRecipeFile));
  if (!path) return undefined;
  const config = readResolvedRecipeConfig(
    path,
    [...stack, currentRecipeFile],
    options,
  );
  if (!config) throw new Error(`Template recipe must define template: ${path}`);
  if (config.disabled === true)
    throw new Error(`Template recipe is disabled: ${path}`);
  return config;
}

function applyDelegatedRecipeToNode(
  delegated: TemplateRecipeConfig,
  overrides: Record<string, unknown> = {},
): CommandTemplateValue {
  return applyDefaultsToTemplate(
    delegated.template,
    delegated.values,
    overrides,
  );
}

function expandRecipeDelegations(
  value: CommandTemplateValue,
  currentRecipeFile: string,
  stack: string[],
  options: ReadResolvedRecipeConfigOptions = {},
): CommandTemplateValue {
  if (typeof value === "string") {
    const delegated = loadDelegatedRecipe(
      value,
      currentRecipeFile,
      stack,
      options,
    );
    return delegated ? applyDelegatedRecipeToNode(delegated) : value;
  }
  if (Array.isArray(value)) {
    return value.map(
      (item) =>
        expandRecipeDelegations(
          item as CommandTemplateValue,
          currentRecipeFile,
          stack,
          options,
        ) as CommandTemplateConfig,
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.template === "string") {
    const delegated = loadDelegatedRecipe(
      record.template,
      currentRecipeFile,
      stack,
      options,
    );
    if (delegated) return applyDelegatedRecipeToNode(delegated, record);
  }
  if (Array.isArray(record.template)) {
    return {
      ...record,
      template: record.template.map(
        (item) =>
          expandRecipeDelegations(
            item as CommandTemplateValue,
            currentRecipeFile,
            stack,
            options,
          ) as CommandTemplateConfig,
      ),
    } as CommandTemplates.CommandTemplateObjectConfig;
  }
  if (record.template && typeof record.template === "object") {
    return {
      ...record,
      template: expandRecipeDelegations(
        record.template as CommandTemplateValue,
        currentRecipeFile,
        stack,
        options,
      ),
    } as CommandTemplates.CommandTemplateObjectConfig;
  }
  return value;
}

function getDirectDelegatedRecipe(
  value: CommandTemplateValue,
  currentRecipeFile: string,
  stack: string[],
  options: ReadResolvedRecipeConfigOptions = {},
): TemplateRecipeConfig | undefined {
  if (typeof value === "string")
    return loadDelegatedRecipe(value, currentRecipeFile, stack, options);
  if (!Array.isArray(value) && typeof value.template === "string") {
    return loadDelegatedRecipe(
      value.template,
      currentRecipeFile,
      stack,
      options,
    );
  }
  return undefined;
}

function expandImportNodes(
  value: CommandTemplateValue,
  imports: Record<string, ImportedRecipe>,
  options: ReadResolvedRecipeConfigOptions = {},
): CommandTemplateValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(
      (item) =>
        expandImportNodes(item, imports, options) as CommandTemplateConfig,
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
    const expanded = applyDefaultsToTemplate(
      imported.config.template,
      defaults,
      record,
    );
    return options.includeActorRecipeContext
      ? withActorRecipeContext(expanded, {
          alias: imported.alias,
          file: imported.file,
          name: imported.name,
          path: imported.alias,
          role: "import",
        })
      : expanded;
  }
  if (Array.isArray(record.template)) {
    return {
      ...record,
      template: record.template.map(
        (item) =>
          expandImportNodes(
            item as CommandTemplateValue,
            imports,
            options,
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
        options,
      ),
    } as CommandTemplates.CommandTemplateObjectConfig;
  }
  return value;
}

export function readResolvedRecipeConfig(
  file: string,
  stack: string[] = [],
  options: ReadResolvedRecipeConfigOptions = {},
): TemplateRecipeConfig | undefined {
  const path = resolveRecipePath(
    file,
    stack.length > 0 ? dirname(stack.at(-1)!) : Paths.getRecipeRoot(),
  );
  if (stack.includes(path)) {
    throw new Error(`Cyclic recipe import: ${[...stack, path].join(" -> ")}`);
  }
  if (stack.length >= MAX_RECIPE_IMPORT_DEPTH) {
    throw new Error(
      `Recipe import depth exceeds limit ${MAX_RECIPE_IMPORT_DEPTH}: ${[...stack, path].join(" -> ")}`,
    );
  }
  const raw = readRawRecipeConfig(path);
  if (!raw || !Object.hasOwn(raw, "template")) return undefined;
  const imports: Record<string, ImportedRecipe> = {};
  for (const [alias, binding] of Object.entries(getRecipeImports(raw))) {
    const importPath = resolveRecipeImportPath(
      getImportFrom(binding),
      dirname(path),
    );
    const config = readResolvedRecipeConfig(
      importPath,
      [...stack, path],
      options,
    );
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
  const expandedImportsTemplate = expandImportNodes(template, imports, options);
  const delegated = getDirectDelegatedRecipe(
    expandedImportsTemplate,
    path,
    stack,
    options,
  );
  const expandedTemplate = delegated
    ? applyDelegatedRecipeToNode(
        delegated,
        typeof expandedImportsTemplate === "object" &&
          !Array.isArray(expandedImportsTemplate)
          ? (expandedImportsTemplate as Record<string, unknown>)
          : {},
      )
    : expandRecipeDelegations(expandedImportsTemplate, path, stack, options);
  const recipeName = getRecipeIdFromPath(path);
  const templateWithContext = options.includeActorRecipeContext
    ? withActorRecipeContext(expandedTemplate, {
        file: path,
        name: recipeName,
        path: recipeName,
        role: stack.length > 0 ? "import" : "entry",
      })
    : expandedTemplate;
  const mergedDefaults = mergeDefaults(
    delegated?.defaults,
    isRecord(substituted.defaults) ? substituted.defaults : undefined,
  );
  const artifactSource = isRecord(substituted.artifacts)
    ? substituted.artifacts
    : delegated?.artifacts;
  const mailboxSource = isRecord(substituted.mailbox)
    ? substituted.mailbox
    : delegated?.mailbox;
  return {
    name: recipeName,
    ...(typeof substituted.description === "string" &&
    substituted.description.trim()
      ? { description: substituted.description.trim() }
      : typeof delegated?.description === "string"
        ? { description: delegated.description }
        : {}),
    ...(typeof substituted.disabled === "boolean"
      ? { disabled: substituted.disabled }
      : typeof delegated?.disabled === "boolean"
        ? { disabled: delegated.disabled }
        : {}),
    ...(substituted.async === true
      ? { async: true }
      : substituted.async === false
        ? { async: false }
        : delegated?.async === true
          ? { async: true }
          : delegated?.async === false
            ? { async: false }
            : {}),
    ...(typeof substituted.state_dir === "string"
      ? { state_dir: substituted.state_dir }
      : typeof delegated?.state_dir === "string"
        ? { state_dir: delegated.state_dir }
        : {}),
    ...(Object.keys(imports).length > 0
      ? { imports: getRecipeImports(raw) }
      : {}),
    template: templateWithContext,
    ...(Array.isArray(substituted.args)
      ? { args: substituted.args as string[] }
      : Array.isArray(delegated?.args)
        ? { args: delegated.args }
        : {}),
    ...(mergedDefaults ? { defaults: mergedDefaults } : {}),
    ...(typeof substituted.parallel === "boolean"
      ? { parallel: substituted.parallel }
      : {}),
    ...(typeof substituted.concurrency === "number" ||
    typeof substituted.concurrency === "string"
      ? { concurrency: substituted.concurrency }
      : {}),
    ...(typeof substituted.min_successful === "number" ||
    typeof substituted.min_successful === "string"
      ? { min_successful: substituted.min_successful }
      : {}),
    ...(typeof substituted.label === "string"
      ? { label: substituted.label }
      : {}),
    ...(typeof substituted.when === "string" ||
    typeof substituted.when === "boolean"
      ? { when: substituted.when }
      : {}),
    ...(typeof substituted.timeout === "number" ||
    typeof substituted.timeout === "string"
      ? { timeout: substituted.timeout }
      : {}),
    ...(typeof substituted.delay === "number" ||
    typeof substituted.delay === "string"
      ? { delay: substituted.delay }
      : {}),
    ...(typeof substituted.output === "string"
      ? { output: substituted.output }
      : {}),
    ...(isRecord(artifactSource)
      ? {
          artifacts: Object.fromEntries(
            Object.entries(artifactSource).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
    ...(isRecord(mailboxSource)
      ? {
          mailbox: {
            ...(Array.isArray(mailboxSource.accepts)
              ? {
                  accepts: mailboxSource.accepts.filter(
                    (value): value is TemplateRecipeMailboxEntry =>
                      typeof value === "string" ||
                      (isRecord(value) && typeof value.type === "string"),
                  ),
                }
              : {}),
            ...(Array.isArray(mailboxSource.emits)
              ? {
                  emits: mailboxSource.emits.filter(
                    (value): value is TemplateRecipeMailboxEntry =>
                      typeof value === "string" ||
                      (isRecord(value) && typeof value.type === "string"),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(substituted.retire_when === "children_terminal" ||
    delegated?.retire_when === "children_terminal"
      ? { retire_when: "children_terminal" as const }
      : {}),
    ...(typeof substituted.retry === "number" ||
    typeof substituted.retry === "string"
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
    ...(isRecord(substituted.usage) ? { usage: substituted.usage } : {}),
  };
}

function collectRecipeContextRecords(
  file: string,
  stack: string[],
  importPath: string[],
  alias?: string,
): TemplateRecipeContextRecord[] {
  const path = resolveRecipePath(
    file,
    stack.length > 0 ? dirname(stack.at(-1)!) : Paths.getRecipeRoot(),
  );
  if (stack.includes(path)) {
    throw new Error(`Cyclic recipe import: ${[...stack, path].join(" -> ")}`);
  }
  if (stack.length >= MAX_RECIPE_IMPORT_DEPTH) {
    throw new Error(
      `Recipe import depth exceeds limit ${MAX_RECIPE_IMPORT_DEPTH}: ${[...stack, path].join(" -> ")}`,
    );
  }
  const raw = readRawRecipeConfig(path);
  if (!raw || !Object.hasOwn(raw, "template")) return [];
  const record: TemplateRecipeContextRecord = {
    ...(alias ? { alias } : {}),
    depth: stack.length,
    file: path,
    import_path: importPath,
    name: getRecipeIdFromPath(path),
    recipe: raw,
    role: stack.length === 0 ? "entry" : "import",
  };
  const imports = getRecipeImports(raw);
  const children = Object.entries(imports).flatMap(([childAlias, binding]) => {
    const importFile = resolveRecipeImportPath(
      getImportFrom(binding),
      dirname(path),
    );
    return collectRecipeContextRecords(
      importFile,
      [...stack, path],
      [...importPath, childAlias],
      childAlias,
    );
  });
  return [record, ...children];
}

export function buildRecipeContextRecords(
  file: string,
): TemplateRecipeContextRecord[] {
  return collectRecipeContextRecords(file, [], []);
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
