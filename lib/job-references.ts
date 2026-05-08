/**
 * Job recipe reference helpers
 * Zones: registry config, template jobs, path resolution
 * Owns detection of command-template strings that intentionally point at job recipe files
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import * as Paths from "./paths.ts";

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

export function isJobRecipeReference(value: unknown): boolean {
  return getJobRecipePath(value) !== undefined;
}
