/**
 * Tool argument parsing helpers
 * Owns comma-separated arg/default parsing and persisted arg normalization
 */

import { normalizeArgName } from "./identity.ts";

export interface ParsedArgs {
  args: string[];
  defaults: Record<string, string>;
  error?: string;
}

export function parseArgToken(value: string): {
  arg: string;
  defaultValue?: string;
} {
  const separatorIndex = value.indexOf("=");
  const rawName =
    separatorIndex === -1 ? value : value.slice(0, separatorIndex);
  const arg = normalizeArgName(rawName);
  const defaultValue =
    separatorIndex === -1 ? undefined : value.slice(separatorIndex + 1).trim();
  return { arg, defaultValue };
}

export function parseArgs(value: string): ParsedArgs {
  const source = value
    .split(",")
    .map((arg) => arg.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const args: string[] = [];
  const defaults: Record<string, string> = {};
  for (const item of source) {
    const parsed = parseArgToken(item);
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

export function normalizeStoredArgs(
  argsValue: unknown,
  defaultsValue: unknown,
): { args: string[]; defaults: Record<string, string> } {
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
    const parsed = parseArgToken(String(item).trim());
    if (!parsed.arg || seen.has(parsed.arg)) continue;
    seen.add(parsed.arg);
    args.push(parsed.arg);
    const storedDefault = rawDefaults[parsed.arg];
    if (typeof storedDefault === "string") defaults[parsed.arg] = storedDefault;
    else if (parsed.defaultValue !== undefined)
      defaults[parsed.arg] = parsed.defaultValue;
  }
  return { args, defaults };
}

export function formatArgs(args: string[]): string {
  return args.length > 0 ? args.join(", ") : "none";
}
