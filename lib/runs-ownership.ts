/**
 * Async run state-directory ownership.
 * Owns the marker proof required before launch and destructive retention.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";

export const RUN_STATE_OWNERSHIP_FILE = ".pi-actors-run-state.json";

interface RunStateOwnershipMarker {
  created_at: string;
  ownership_token: string;
  run: string;
  state_dir: string;
  version: 1;
}

function markerPath(stateDir: string): string {
  return join(stateDir, RUN_STATE_OWNERSHIP_FILE);
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertCanonicalDirectory(stateDir: string): string {
  const resolved = resolve(stateDir);
  if (lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Run state directory cannot be a symlink: ${resolved}`);
  }
  const canonical = realpathSync(resolved);
  if (comparablePath(canonical) !== comparablePath(resolved)) {
    throw new Error(`Run state directory has an ambiguous symlink alias: ${resolved}`);
  }
  return resolved;
}

function readMarker(stateDir: string): RunStateOwnershipMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(markerPath(stateDir), "utf8")) as Partial<RunStateOwnershipMarker>;
    if (
      value.version !== 1 ||
      typeof value.run !== "string" ||
      typeof value.state_dir !== "string" ||
      typeof value.ownership_token !== "string" ||
      !value.ownership_token
    ) {
      return undefined;
    }
    return value as RunStateOwnershipMarker;
  } catch {
    return undefined;
  }
}

function assertMarkerMatches(
  marker: RunStateOwnershipMarker | undefined,
  stateDir: string,
  run: string,
): RunStateOwnershipMarker {
  if (!marker) {
    throw new Error(`Run state ownership marker is missing or invalid: ${stateDir}`);
  }
  if (marker.state_dir !== stateDir || marker.run !== run) {
    throw new Error(`Run state ownership marker does not match run ${run}: ${stateDir}`);
  }
  return marker;
}

export function claimRunStateDirectory(stateDir: string, run: string): string {
  const resolved = resolve(stateDir);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Run state directory cannot be a symlink: ${resolved}`);
  }
  mkdirSync(resolved, { recursive: true });
  const canonical = assertCanonicalDirectory(resolved);
  const existing = readMarker(canonical);
  if (existing) {
    assertMarkerMatches(existing, canonical, run);
    return canonical;
  }
  const existingEntries = readdirSync(canonical).filter(
    (entry) => entry !== ".start.lock",
  );
  if (existingEntries.length > 0) {
    throw new Error(`Refusing to claim existing non-run directory: ${canonical}`);
  }
  writeJsonAtomic(markerPath(canonical), {
    created_at: new Date().toISOString(),
    ownership_token: randomUUID(),
    run,
    state_dir: canonical,
    version: 1,
  } satisfies RunStateOwnershipMarker);
  return canonical;
}

export function assertOwnedRunStateDirectory(
  stateDir: string,
  run: string,
): string {
  const canonical = assertCanonicalDirectory(stateDir);
  assertMarkerMatches(readMarker(canonical), canonical, run);
  return canonical;
}
