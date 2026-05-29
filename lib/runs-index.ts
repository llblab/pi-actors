/**
 * Async run state index.
 * Owns recursive run-state discovery, index rebuild/read, and status filtering.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";

export interface RunStateIndexEntry {
  ownerId?: string;
  recipe?: string;
  run: string;
  state_dir: string;
  status: string;
  tool?: string;
  updated_at?: string;
}

export type RunStatusReader = (runOrDir: string) => Record<string, unknown>;

function matchesStatusFilter(
  status: unknown,
  filter: string | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "active") return status === "running";
  if (filter === "terminal") return status !== "running";
  return status === filter;
}

export function listRunStateDirs(
  stateRoot: string,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (!existsSync(stateRoot) || seen.has(resolve(stateRoot))) return [];
  seen.add(resolve(stateRoot));
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(stateRoot, entry.name);
    if (existsSync(join(child, "run.json"))) result.push(child);
    if (depth + 1 < 8) result.push(...listRunStateDirs(child, depth + 1, seen));
  }
  return result;
}

function runIndexPath(stateRoot: string): string {
  return join(stateRoot, "index.json");
}

function indexEntryFromStatus(
  status: Record<string, unknown>,
): RunStateIndexEntry {
  const progress =
    status.progress && typeof status.progress === "object"
      ? (status.progress as Record<string, unknown>)
      : {};
  return {
    ...(typeof status.ownerId === "string" ? { ownerId: status.ownerId } : {}),
    ...(typeof status.recipe === "string" ? { recipe: status.recipe } : {}),
    run: String(status.run),
    state_dir: String(status.state_dir),
    status: String(status.status),
    ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
    updated_at:
      typeof progress.updatedAt === "string"
        ? progress.updatedAt
        : typeof status.createdAt === "string"
          ? status.createdAt
          : new Date(0).toISOString(),
  };
}

export function rebuildRunStateIndex(
  stateRoot: string,
  getRunStatus: RunStatusReader,
): RunStateIndexEntry[] {
  mkdirSync(stateRoot, { recursive: true });
  const entries = listRunStateDirs(stateRoot)
    .flatMap((stateDir) => {
      try {
        return [indexEntryFromStatus(getRunStatus(stateDir))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  writeJsonAtomic(runIndexPath(stateRoot), {
    entries,
    rebuilt_at: new Date().toISOString(),
  });
  return entries;
}

export function readRunStateIndex(
  stateRoot: string,
  readJson: (path: string) => Record<string, unknown> | undefined,
): RunStateIndexEntry[] | undefined {
  const index = readJson(runIndexPath(stateRoot));
  if (!index || typeof index !== "object") return undefined;
  const entries = (index as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return undefined;
  const valid = entries.filter((entry): entry is RunStateIndexEntry => {
    const record =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    return (
      typeof record.run === "string" &&
      typeof record.state_dir === "string" &&
      typeof record.status === "string"
    );
  });
  if (valid.some((entry) => !existsSync(join(entry.state_dir, "run.json"))))
    return undefined;
  const indexedDirs = new Set(valid.map((entry) => resolve(entry.state_dir)));
  const stateDirs = listRunStateDirs(stateRoot).map((stateDir) =>
    resolve(stateDir),
  );
  if (stateDirs.some((stateDir) => !indexedDirs.has(stateDir)))
    return undefined;
  return valid;
}

function compactIndexEntry(entry: RunStateIndexEntry): Record<string, unknown> {
  return {
    run: entry.run,
    state_dir: entry.state_dir,
    status: entry.status,
    ...(entry.tool ? { tool: entry.tool } : {}),
    ...(entry.recipe ? { recipe: entry.recipe } : {}),
  };
}

export function listRuns(
  stateRoot: string,
  getRunStatus: RunStatusReader,
  readJson: (path: string) => Record<string, unknown> | undefined,
  statusFilter?: string,
): Array<Record<string, unknown>> {
  if (!existsSync(stateRoot)) return [];
  const indexed = readRunStateIndex(stateRoot, readJson);
  const entries = indexed ?? rebuildRunStateIndex(stateRoot, getRunStatus);
  return entries
    .filter((entry) => matchesStatusFilter(entry.status, statusFilter))
    .map(compactIndexEntry);
}
