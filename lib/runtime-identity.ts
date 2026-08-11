/**
 * Immutable runtime package identity.
 * Zones: source/installed package version resolution and Run-state schema marker
 * Owns package-local identity reads; runtime status and Run persistence remain in their domains.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_STATE_SCHEMA = "run-kernel-v1" as const;

let cachedVersion: string | undefined;

export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const path of [
    join(moduleDir, "..", "package.json"),
    join(moduleDir, "..", "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (
        pkg.name === "@llblab/pi-actors" &&
        typeof pkg.version === "string" &&
        pkg.version.length > 0 &&
        pkg.version.length <= 128 &&
        pkg.version.trim() === pkg.version
      ) {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    } catch {
      // Source and installed-dist modes resolve through different package ancestors.
    }
  }
  throw new Error("pi-actors package identity is unavailable");
}
