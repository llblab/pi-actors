/**
 * Extension temp-directory helpers
 * Zones: temp directory, cleanup, runtime files
 * Owns pi-agent tmp directory preparation and stale-entry cleanup
 */
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
export const DEFAULT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export async function cleanupStaleTempEntries(tempDir, maxAgeMs = DEFAULT_TEMP_MAX_AGE_MS, now = Date.now(), preservedEntries = new Set(["runs", "delivery"])) {
    let entries;
    let removed = 0;
    try {
        entries = await readdir(tempDir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (preservedEntries.has(entry.name))
            continue;
        const path = join(tempDir, entry.name);
        try {
            const info = await stat(path);
            if (now - info.mtimeMs <= maxAgeMs)
                continue;
            await rm(path, { force: true, recursive: true });
            removed += 1;
        }
        catch {
            // Ignore temp cleanup races.
        }
    }
    return removed;
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function isRunEntryAlive(path) {
    try {
        const raw = await readFile(join(path, "run.json"), "utf8");
        const meta = JSON.parse(raw);
        const pid = Number(meta.pid || 0);
        return pid > 0 && isPidAlive(pid);
    }
    catch {
        return false;
    }
}
export async function cleanupStaleRunEntries(runsDir, maxAgeMs = DEFAULT_RUN_MAX_AGE_MS, now = Date.now()) {
    let entries;
    let removed = 0;
    try {
        entries = await readdir(runsDir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const path = join(runsDir, entry.name);
        try {
            const info = await stat(path);
            const timestamp = Math.min(info.birthtimeMs || info.mtimeMs, info.mtimeMs);
            if (now - timestamp <= maxAgeMs)
                continue;
            if (await isRunEntryAlive(path))
                continue;
            await rm(path, { force: true, recursive: true });
            removed += 1;
        }
        catch {
            // Ignore temp cleanup races.
        }
    }
    return removed;
}
export async function prepareExtensionTempDir(tempDir, maxAgeMs = DEFAULT_TEMP_MAX_AGE_MS, runMaxAgeMs = DEFAULT_RUN_MAX_AGE_MS) {
    await mkdir(tempDir, { recursive: true });
    const removedTemp = await cleanupStaleTempEntries(tempDir, maxAgeMs);
    const removedRuns = await cleanupStaleRunEntries(join(tempDir, "runs"), runMaxAgeMs);
    return removedTemp + removedRuns;
}
