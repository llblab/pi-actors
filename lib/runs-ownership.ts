/**
 * Async run state-directory ownership.
 * Owns: marker proof for lifecycle/retention and optional bounded readonly identity admission.
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
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import { readJsonFileResilient } from "./state-readers.ts";

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

function isSystemTempRootAlias(resolved: string, canonical: string): boolean {
  const tempRoot = resolve(tmpdir());
  const relativeStateDir = relative(tempRoot, resolved);
  if (
    relativeStateDir === ".." ||
    relativeStateDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeStateDir)
  ) {
    return false;
  }
  const canonicalTempRoot = realpathSync.native(tempRoot);
  const expectedCanonical = resolve(canonicalTempRoot, relativeStateDir);
  return comparablePath(canonical) === comparablePath(expectedCanonical);
}

function assertCanonicalDirectory(stateDir: string): string {
  const resolved = resolve(stateDir);
  if (lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Run state directory cannot be a symlink: ${resolved}`);
  }
  const canonical = realpathSync.native(resolved);
  if (
    comparablePath(canonical) !== comparablePath(resolved) &&
    !isSystemTempRootAlias(resolved, canonical)
  ) {
    throw new Error(`Run state directory has an ambiguous symlink alias: ${resolved}`);
  }
  return resolved;
}

function readMarker(stateDir: string, maxBytes?: number): RunStateOwnershipMarker | undefined {
  try {
    const path = markerPath(stateDir);
    if (!lstatSync(path).isFile()) return undefined;
    const value = maxBytes === undefined
      ? JSON.parse(readFileSync(path, "utf8")) as Partial<RunStateOwnershipMarker>
      : readJsonFileResilient<Partial<RunStateOwnershipMarker> | undefined>(path, undefined, { maxBytes, strictUtf8: true }).value;
    if (
      !value || value.version !== 1 ||
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

/** Avoid acquiring the same lifecycle resource through a second path while its parent lock is held. */
export function assertDistinctRunStateDirectories(parentStateDir: string, childStateDir: string): void {
  const parent = realpathSync.native(resolve(parentStateDir));
  let child: string;
  try { child = realpathSync.native(resolve(childStateDir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (comparablePath(parent) === comparablePath(child)) {
    throw new Error("Run descendant preparation cannot target its parent state directory.");
  }
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

/** Read only the public marker identity, never its private ownership token. */
export function readOwnedRunStateDirectory(
  stateDir: string,
  options: { maxBytes?: number } = {},
): { run: string; stateDir: string } {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new Error("Run state ownership read budget must be a nonnegative safe integer.");
  }
  const canonical = assertCanonicalDirectory(stateDir);
  const marker = readMarker(canonical, options.maxBytes);
  const checked = assertMarkerMatches(marker, canonical, marker?.run ?? "");
  return { run: checked.run, stateDir: canonical };
}

export function assertOwnedRunStateDirectory(
  stateDir: string,
  run: string,
): string {
  const canonical = assertCanonicalDirectory(stateDir);
  assertMarkerMatches(readMarker(canonical), canonical, run);
  return canonical;
}
