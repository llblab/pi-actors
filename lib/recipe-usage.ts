/**
 * Recipe usage metadata helpers
 * Zones: recipe telemetry, muscle-memory cleanup evidence
 * Owns lightweight launch counters for user-owned recipe files
 */

import { existsSync, readFileSync } from "node:fs";

import { writeJsonAtomic } from "./file-state.ts";

interface RecipeUsageRecord {
  calls?: number;
  last_called?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCalls(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function recordRecipeLaunch(path: string, now = new Date()): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw)) return false;
    const usage: RecipeUsageRecord = isRecord(raw.usage) ? raw.usage : {};
    writeJsonAtomic(path, {
      ...raw,
      usage: {
        ...usage,
        calls: normalizeCalls(usage.calls) + 1,
        last_called: now.toISOString(),
      },
    });
    return true;
  } catch {
    return false;
  }
}
