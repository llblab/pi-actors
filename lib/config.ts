/**
 * Persistent tool registry config helpers
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

import { normalizeStoredArgs } from "./args.ts";
import { normalizeToolName } from "./identity.ts";

export interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  template: string;
  args: string[];
  defaults: Record<string, string>;
}

export interface LoadConfigResult {
  tools: Map<string, RegisteredTool>;
  warnings: string[];
  changed: boolean;
}

export function serializeTools(
  source: Map<string, RegisteredTool>,
): Record<string, RegisteredTool> {
  const entries = [...source.entries()].sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, RegisteredTool> = {};
  for (const [name, cfg] of entries) result[name] = cfg;
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

export function getStoredEntries(raw: unknown): Array<[string | undefined, unknown]> {
  if (Array.isArray(raw)) return raw.map((value) => [undefined, value]);
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>);
  }
  return [];
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
  const rawTemplate =
    typeof record.template === "string" ? record.template.trim() : "";
  if (!rawTemplate && typeof record.script === "string") {
    return {
      changed: false,
      warning: `Tool "${name}" uses legacy script config. Migrate to template because pi-auto-tools v0.2.0 cannot load it.`,
    };
  }
  if (!rawTemplate) {
    return { changed: true, warning: `Tool "${name}" has no template` };
  }
  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : name;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : `Execute command template: ${rawTemplate}`;
  const parsed = normalizeStoredArgs(record.args, record.defaults);
  const cfg = {
    name,
    label,
    description,
    template: rawTemplate,
    args: parsed.args,
    defaults: parsed.defaults,
  };
  const changed =
    record.name !== name ||
    record.template !== rawTemplate ||
    label !== record.label ||
    description !== record.description ||
    JSON.stringify(parsed.args) !== JSON.stringify(record.args ?? []) ||
    JSON.stringify(parsed.defaults) !== JSON.stringify(record.defaults ?? {});
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
        warnings.push(`Duplicate tool kept from last entry: ${result.cfg.name}`);
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
