/**
 * Job recipe reference helpers
 * Zones: registry config, template jobs, path resolution
 * Owns detection of command-template strings that intentionally point at job recipe files
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { CommandTemplateConfig, CommandTemplateValue } from "./command-templates.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Paths from "./paths.ts";

export interface JobRecipeConfig {
  job?: string;
  state_dir?: string;
  stateDir?: string;
  template: CommandTemplateValue;
  values?: Record<string, unknown>;
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

export function resolveJobRecipePath(
  value: string,
  templateRoot = Paths.getJobTemplateRoot(),
): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed.includes("/")) return resolve(trimmed);
  return resolve(templateRoot, trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`);
}

export function getJobRecipePath(
  value: unknown,
  templateRoot = Paths.getJobTemplateRoot(),
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || hasWhitespace(trimmed)) return undefined;
  if (trimmed.endsWith(".json")) return resolveJobRecipePath(trimmed, templateRoot);
  const path = resolveJobRecipePath(trimmed, templateRoot);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return raw && typeof raw === "object" && Object.hasOwn(raw, "template") ? path : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRecipeTemplate(value: unknown): CommandTemplateValue | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const template = value as CommandTemplateConfig[];
  return CommandTemplates.expandCommandTemplateConfigs({ template }).length > 0
    ? template
    : undefined;
}

export function getJobRecipeTemplate(value: unknown): CommandTemplateValue | undefined {
  const path = getJobRecipePath(value);
  if (!path || !existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (Object.hasOwn(raw, "tool")) return undefined;
    return normalizeRecipeTemplate(raw.template);
  } catch {
    return undefined;
  }
}

export function isJobRecipeReference(value: unknown): boolean {
  return getJobRecipePath(value) !== undefined;
}

export function isJobRecipeTool(
  template: unknown,
  jobRecipe: JobRecipeConfig | undefined,
): boolean {
  return jobRecipe !== undefined || isJobRecipeReference(template);
}
