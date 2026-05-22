/**
 * File-discovered recipe registry helpers
 * Zones: recipe discovery, tool exposure, migration diagnostics
 * Owns filename identity discovery across prioritized recipe roots
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { RegisteredTool } from "./config.ts";
import type { TemplateRecipeConfig } from "./recipe-references.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as Schema from "./schema.ts";

export interface DiscoveredRecipe {
  id: string;
  path: string;
  root: string;
  priority: number;
  config?: TemplateRecipeConfig;
  active: boolean;
  shadowed: boolean;
  invalid: boolean;
  disabled: boolean;
  tool: boolean;
  mutableUsage: boolean;
  diagnostics: string[];
  shadows: string[];
}

export interface RecipeDiscoveryResult {
  active: Map<string, DiscoveredRecipe>;
  entries: DiscoveredRecipe[];
  diagnostics: string[];
}

export interface RecipeDiscoverySource {
  root?: string;
  file?: string;
  defaultTool?: boolean;
  mutableUsage?: boolean;
}

function assertToolSafeRepeatConfig(
  config: unknown,
  argTypes: Record<string, { kind: string }>,
  defaults: Record<string, unknown>,
): void {
  if (typeof config === "string" || config === undefined || config === null) return;
  if (Array.isArray(config)) {
    for (const step of config) assertToolSafeRepeatConfig(step, argTypes, defaults);
    return;
  }
  if (typeof config !== "object") return;
  const node = config as { repeat?: unknown; template?: unknown; recover?: unknown };
  if (typeof node.repeat === "string") {
    const trimmed = node.repeat.trim();
    if (!/^\d+$/.test(trimmed)) {
      const match = trimmed.match(/^\{?([A-Za-z_][A-Za-z0-9_-]*)\.length\}?$/);
      if (!match || (argTypes[match[1]]?.kind !== "array" && !Array.isArray(defaults[match[1]])))
        throw new Error(
          "Command template repeat must be a positive integer or {array.length} with an array argument/default.",
        );
    }
  }
  assertToolSafeRepeatConfig(node.template, argTypes, defaults);
  assertToolSafeRepeatConfig(node.recover, argTypes, defaults);
}

function listRecipeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "legacy-tool-registry-migration-report.json",
    )
    .map((entry) => join(root, entry.name))
    .sort();
}

function readDiscoveredRecipe(
  root: string,
  file: string,
  priority: number,
  defaultTool = false,
  mutableUsage = false,
): DiscoveredRecipe {
  const id = RecipeReferences.getRecipeIdFromPath(file);
  try {
    const config = RecipeReferences.readResolvedRecipeConfig(file);
    const invalid = !config;
    const disabled = config?.disabled === true;
    return {
      id,
      path: file,
      root,
      priority,
      config,
      active: false,
      shadowed: false,
      invalid,
      disabled,
      tool: (config?.tool ?? defaultTool) === true && !disabled && !invalid,
      mutableUsage,
      diagnostics: invalid ? [`Invalid recipe: ${file}`] : [],
      shadows: [],
    };
  } catch (error) {
    return {
      id,
      path: file,
      root,
      priority,
      active: false,
      shadowed: false,
      invalid: true,
      disabled: false,
      tool: false,
      mutableUsage,
      diagnostics: [
        `Failed to load recipe ${file}: ${error instanceof Error ? error.message : String(error)}`,
      ],
      shadows: [],
    };
  }
}

function filesForSource(
  source: RecipeDiscoverySource,
): Array<{ root: string; file: string; defaultTool: boolean; mutableUsage: boolean }> {
  const defaultTool = source.defaultTool === true;
  const mutableUsage = source.mutableUsage === true;
  if (source.file)
    return [{ root: source.root ?? source.file, file: source.file, defaultTool, mutableUsage }];
  return source.root
    ? listRecipeFiles(source.root).map((file) => ({
        root: source.root!,
        file,
        defaultTool,
        mutableUsage,
      }))
    : [];
}

export function discoverRecipeSources(
  sources: RecipeDiscoverySource[],
): RecipeDiscoveryResult {
  const entries = sources.flatMap((source, priority) =>
    filesForSource(source).map(({ root, file, defaultTool, mutableUsage }) =>
      readDiscoveredRecipe(root, file, priority, defaultTool, mutableUsage),
    ),
  );
  const byId = new Map<string, DiscoveredRecipe[]>();
  for (const entry of entries) {
    const bucket = byId.get(entry.id) ?? [];
    bucket.push(entry);
    byId.set(entry.id, bucket);
  }

  const active = new Map<string, DiscoveredRecipe>();
  const diagnostics: string[] = [];
  for (const [id, bucket] of byId) {
    bucket.sort(
      (a, b) => a.priority - b.priority || a.path.localeCompare(b.path),
    );
    const winner = bucket[0];
    winner.active = true;
    winner.shadows = bucket.slice(1).map((entry) => entry.path);
    active.set(id, winner);
    for (const shadow of bucket.slice(1)) shadow.shadowed = true;
    if (winner.invalid)
      diagnostics.push(
        `Recipe ${id} is invalid and blocks lower-priority recipes`,
      );
    if (winner.disabled)
      diagnostics.push(
        `Recipe ${id} is disabled and blocks lower-priority recipes`,
      );
    if (winner.shadows.length > 0)
      diagnostics.push(
        `Recipe ${id} shadows ${winner.shadows.length} lower-priority recipe(s)`,
      );
    diagnostics.push(...winner.diagnostics);
  }

  return { active, entries, diagnostics };
}

export function discoverRecipes(roots: string[]): RecipeDiscoveryResult {
  return discoverRecipeSources(roots.map((root) => ({ root })));
}

function recipeUsage(config: TemplateRecipeConfig | undefined): Record<string, unknown> | undefined {
  const usage = (config as { usage?: unknown } | undefined)?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined;
}

function cleanupRecommendation(entry: DiscoveredRecipe): Record<string, unknown> | undefined {
  if (entry.invalid) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "invalid recipe blocks lower-priority entries with the same id",
      actions: ["fix", "delete", "archive"],
    };
  }
  if (entry.shadowed) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "shadowed by a higher-priority recipe",
      actions: ["merge", "delete", "archive"],
    };
  }
  if (entry.disabled) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "disabled recipe is retained but not exposed as a tool",
      actions: ["keep disabled", "delete", "archive"],
    };
  }
  const usage = recipeUsage(entry.config);
  const calls = Number(usage?.calls ?? 0);
  if (entry.mutableUsage && entry.tool && calls === 0) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "active user tool has no recorded launches",
      actions: ["keep as tool", "set tool false", "delete", "archive"],
    };
  }
  if (entry.mutableUsage && !entry.tool) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "user recipe is a component, not an active tool",
      actions: ["keep component", "enable tool", "merge", "delete", "archive"],
    };
  }
  if (entry.shadows.length > 0) {
    return {
      id: entry.id,
      path: entry.path,
      reason: `overrides ${entry.shadows.length} lower-priority recipe(s)`,
      actions: ["keep override", "merge", "delete", "archive"],
    };
  }
  return undefined;
}

function recommendationForEntry(
  entry: DiscoveredRecipe,
  activePath: string | undefined,
): Record<string, unknown> | undefined {
  const recommendation = cleanupRecommendation(entry);
  if (!recommendation) return undefined;
  if (entry.shadowed && activePath) {
    return {
      ...recommendation,
      reason: `shadowed by ${activePath}`,
    };
  }
  return recommendation;
}

export function summarizeDiscovery(result: RecipeDiscoveryResult): Record<string, unknown> {
  const recommendations = result.entries
    .map((entry) => recommendationForEntry(entry, result.active.get(entry.id)?.path))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)) || String(a.path).localeCompare(String(b.path)));
  return {
    active: [...result.active.values()].map((entry) => ({
      id: entry.id,
      path: entry.path,
      description: entry.config?.description,
      tool: entry.tool,
      disabled: entry.disabled,
      invalid: entry.invalid,
      shadows: entry.shadows,
      ...(recipeUsage(entry.config) ? { usage: recipeUsage(entry.config) } : {}),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    shadowed: result.entries
      .filter((entry) => entry.shadowed)
      .map((entry) => ({ id: entry.id, path: entry.path, shadowedBy: result.active.get(entry.id)?.path }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)),
    invalid: result.entries
      .filter((entry) => entry.invalid)
      .map((entry) => ({ id: entry.id, path: entry.path, diagnostics: entry.diagnostics }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    disabled: result.entries
      .filter((entry) => entry.disabled)
      .map((entry) => ({ id: entry.id, path: entry.path }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    recommendations,
    diagnostics: result.diagnostics,
  };
}

export function toRegisteredTool(entry: DiscoveredRecipe): RegisteredTool | undefined {
  if (!entry.tool || entry.invalid || entry.disabled || !entry.config) return undefined;
  const cfg = entry.config;
  const template = entry.path;
  const description = cfg.description ?? `Execute template recipe: ${entry.id}`;
  const argTemplate = cfg.template;
  const argTemplateConfig =
    typeof argTemplate === "object" && !Array.isArray(argTemplate)
      ? {
          ...argTemplate,
          ...(cfg.args !== undefined ? { args: cfg.args } : {}),
          defaults: { ...(argTemplate.defaults ?? {}), ...(cfg.defaults ?? {}) },
        }
      : { args: cfg.args, defaults: cfg.defaults ?? {}, template: argTemplate };
  const explicitArgTypes = Object.fromEntries(
    (cfg.args ?? []).map((arg) => {
      const parsed = Schema.parseToolArgToken(String(arg));
      return [parsed.arg, parsed.type];
    }),
  );
  assertToolSafeRepeatConfig(argTemplateConfig, explicitArgTypes, cfg.defaults ?? {});
  const argTypes = Schema.getTemplateArgTypes(argTemplateConfig);
  return {
    name: entry.id,
    description,
    template,
    recipe: cfg,
    args: Schema.getToolArgNames(argTemplateConfig),
    defaults: Object.fromEntries(
      Object.entries(cfg.defaults ?? {}).map(([key, value]) => [key, String(value)]),
    ),
    ...(Object.keys(argTypes).length > 0 ? { argTypes } : {}),
    ...(entry.mutableUsage ? { sourcePath: entry.path } : {}),
    ...(cfg.args ? { storedArgs: cfg.args } : {}),
    ...(cfg.defaults
      ? {
          storedDefaults: Object.fromEntries(
            Object.entries(cfg.defaults).map(([key, value]) => [key, String(value)]),
          ),
        }
      : {}),
  };
}
