/**
 * Recipe usage metadata helpers
 * Zones: recipe telemetry, muscle-memory cleanup evidence
 * Owns lightweight launch counters for user-owned recipe files
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { writeJsonAtomic } from "./file-state.ts";

interface RecipeUsageRecord {
  calls?: number;
  last_called?: string;
  fingerprint?: string;
  reset_at?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCalls(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function getRecipeFingerprint(raw: Record<string, unknown>): string {
  const { usage: _usage, ...content } = raw;
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

export function recordRecipeLaunch(path: string, now = new Date()): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw)) return false;
    const usage: RecipeUsageRecord = isRecord(raw.usage) ? raw.usage : {};
    const fingerprint = getRecipeFingerprint(raw);
    const changed = typeof usage.fingerprint === "string" && usage.fingerprint !== fingerprint;
    const nowIso = now.toISOString();
    writeJsonAtomic(path, {
      ...raw,
      usage: {
        ...usage,
        calls: (changed ? 0 : normalizeCalls(usage.calls)) + 1,
        last_called: nowIso,
        fingerprint,
        ...(changed ? { reset_at: nowIso } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}
