/**
 * Extension temp-directory helpers
 * Zones: temp directory, cleanup, runtime files
 * Owns pi-agent tmp directory preparation and stale-entry cleanup
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function cleanupStaleTempEntries(
  tempDir: string,
  maxAgeMs = DEFAULT_TEMP_MAX_AGE_MS,
  now = Date.now(),
  preservedEntries = new Set(["runs"]),
): Promise<number> {
  let entries: Array<{ name: string }>;
  let removed = 0;
  try {
    entries = await readdir(tempDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (preservedEntries.has(entry.name)) continue;
    const path = join(tempDir, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await rm(path, { force: true, recursive: true });
      removed += 1;
    } catch {
      // Ignore temp cleanup races.
    }
  }
  return removed;
}

export async function prepareExtensionTempDir(
  tempDir: string,
  maxAgeMs = DEFAULT_TEMP_MAX_AGE_MS,
): Promise<number> {
  await mkdir(tempDir, { recursive: true });
  return cleanupStaleTempEntries(tempDir, maxAgeMs);
}
