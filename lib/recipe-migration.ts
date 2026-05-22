/**
 * Legacy actors-tools.json to recipe-file migration helpers
 * Zones: registry migration, recipe persistence, compatibility diagnostics
 * Owns one-way migration from legacy tool registry entries into user recipe files
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import * as Config from "./config.ts";
import { writeJsonAtomic } from "./file-state.ts";
import type { TemplateRecipeConfig } from "./recipe-references.ts";
import * as RecipeReferences from "./recipe-references.ts";

export interface LegacyRegistryMigrationResult {
  migrated: string[];
  skipped: string[];
  conflicts: string[];
  invalid: string[];
  archive?: string;
  report?: string;
  warnings: string[];
}

export interface LegacyRegistryMigrationOptions {
  configPath: string;
  recipeRoot: string;
  reservedToolNames: Set<string>;
  archive?: boolean;
}

function recipePathForTool(recipeRoot: string, name: string): string {
  return join(recipeRoot, `${name}.json`);
}

function toRecipeConfig(tool: Config.RegisteredTool): TemplateRecipeConfig {
  return {
    name: tool.name,
    description: tool.description,
    tool: true,
    ...(tool.recipe?.async !== undefined ? { async: tool.recipe.async } : {}),
    ...(tool.recipe?.state_dir ? { state_dir: tool.recipe.state_dir } : {}),
    ...(tool.storedArgs ? { args: tool.storedArgs } : {}),
    ...(tool.storedDefaults ? { defaults: tool.storedDefaults } : {}),
    template: tool.template!,
    ...(tool.recipe?.values ? { values: tool.recipe.values } : {}),
  };
}

function nextArchivePath(configPath: string): string {
  const base = `${configPath}.migrated`;
  if (!existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const path = `${base}.${index}`;
    if (!existsSync(path)) return path;
  }
  return `${base}.${Date.now()}`;
}

export function migrateLegacyToolRegistry(
  options: LegacyRegistryMigrationOptions,
): LegacyRegistryMigrationResult {
  const { configPath, recipeRoot, reservedToolNames } = options;
  const result: LegacyRegistryMigrationResult = {
    migrated: [],
    skipped: [],
    conflicts: [],
    invalid: [],
    warnings: [],
  };
  if (!existsSync(configPath)) return result;

  const loaded = Config.loadToolConfig(configPath, reservedToolNames);
  result.warnings.push(...loaded.warnings);
  mkdirSync(recipeRoot, { recursive: true });

  for (const [name, tool] of loaded.tools) {
    const path = recipePathForTool(recipeRoot, name);
    if (existsSync(path)) {
      result.conflicts.push(name);
      continue;
    }
    const recipe = toRecipeConfig(tool);
    try {
      writeJsonAtomic(path, recipe);
      const parsed = RecipeReferences.readResolvedRecipeConfig(path);
      if (!parsed) {
        result.invalid.push(name);
        continue;
      }
      result.migrated.push(name);
    } catch (error) {
      result.invalid.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (loaded.tools.size === 0) result.skipped.push(basename(configPath));

  const reportPath = join(recipeRoot, "actors-tools-migration-report.json");
  writeJsonAtomic(reportPath, {
    source: configPath,
    migrated: result.migrated,
    skipped: result.skipped,
    conflicts: result.conflicts,
    invalid: result.invalid,
    warnings: result.warnings,
  });
  result.report = reportPath;

  if (
    options.archive !== false &&
    result.conflicts.length === 0 &&
    result.invalid.length === 0
  ) {
    const archive = nextArchivePath(configPath);
    renameSync(configPath, archive);
    result.archive = archive;
  }

  return result;
}
