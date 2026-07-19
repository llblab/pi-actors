/**
 * Recipe usage and name-based lineage metadata.
 * Zones: recipe lineage, launch telemetry, revision history, migration
 * Owns priority-compatible recipe names and lifetime/revision counters for user recipes.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";

interface RecipeUsageCounters {
  calls?: number;
  direct_calls?: number;
  fingerprint?: string;
  last_called?: string;
  launch_kind?: string;
  reset_at?: string;
  reset_reason?: string;
  spawn_calls?: number;
  tool_calls?: number;
}

interface RecipeUsageIndex {
  paths: Record<string, string>;
}

interface RecipeLineageEvent {
  at: string;
  from?: string;
  review_epoch?: string;
  to?: string;
  rollback_revision?: number;
  revision?: number;
  type: "created" | "demoted" | "merged" | "promoted" | "renamed" | "replaced" | "reviewed" | "revised" | "rollback" | "split";
}

interface RecipeRevisionRecord {
  fingerprint: string;
  first_seen: string;
  revision: number;
}

interface RecipeUsageRecord extends RecipeUsageCounters {
  calls: number;
  current_path: string;
  fingerprint: string;
  first_seen: string;
  former_names: string[];
  former_paths: string[];
  lifetime_calls: number;
  lineage_events: RecipeLineageEvent[];
  lineage_name: string;
  review_epochs: string[];
  reviewed_fingerprints: string[];
  rollback_of_revision?: number;
  revision: number;
  revision_calls: number;
  revision_direct_calls: number;
  revision_spawn_calls: number;
  revision_tool_calls: number;
  revisions: RecipeRevisionRecord[];
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

function readRecipeSource(path: string): { fingerprint: string } | undefined {
  const bytes = readFileSync(path);
  if (extname(path).toLowerCase() !== ".json") {
    return {
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(parsed)) return undefined;
  const { usage: _usage, ...content } = parsed;
  return {
    fingerprint: createHash("sha256")
      .update(stableStringify(content))
      .digest("hex"),
  };
}

function inferRecipeRoot(path: string): string {
  const parent = dirname(resolve(path));
  return basename(parent) === "drafts" ? dirname(parent) : parent;
}

function pathKey(path: string, recipeRoot: string): string {
  const relation = relative(resolve(recipeRoot), resolve(path));
  if (!relation || relation.startsWith("..") || resolve(relation) === relation) {
    throw new Error(`Recipe path escapes recipe root: ${path}`);
  }
  return relation.replaceAll("\\", "/");
}

function recipeName(path: string): string {
  return basename(path).replace(/\.(?:json|md)$/u, "");
}

function lineageFilename(lineageName: string): string {
  if (!lineageName || lineageName === "." || lineageName === "..") {
    throw new Error("Invalid recipe lineage name.");
  }
  return `${encodeURIComponent(lineageName)}.json`;
}

function appendBounded(values: string[], value: string, limit = 64): string[] {
  const next = [...values.filter((item) => item !== value), value];
  return next.slice(Math.max(0, next.length - limit));
}

function appendEvent(
  events: RecipeLineageEvent[],
  event: RecipeLineageEvent,
): RecipeLineageEvent[] {
  return [...events, event].slice(-128);
}

function appendRevision(
  revisions: RecipeRevisionRecord[],
  revision: RecipeRevisionRecord,
): RecipeRevisionRecord[] {
  return [...revisions, revision].slice(-128);
}

export type RecipeLaunchKind = "direct" | "spawn" | "tool";

export function getRecipeUsageIndexPath(recipeRoot: string): string {
  return join(resolve(recipeRoot), ".usage", "index.json");
}

export function getRecipeUsageLedgerPath(
  lineageName: string,
  recipeRoot: string,
): string {
  return join(
    resolve(recipeRoot),
    ".usage",
    "recipes",
    lineageFilename(lineageName),
  );
}

export const RECIPE_REVISION_SNAPSHOT_LIMIT = 32;

export function getRecipeRevisionSnapshotPath(
  lineageName: string,
  revision: number,
  recipeRoot: string,
): string {
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error("Invalid recipe revision snapshot number.");
  }
  const slot = ((revision - 1) % RECIPE_REVISION_SNAPSHOT_LIMIT) + 1;
  return join(
    resolve(recipeRoot),
    ".usage",
    "revisions",
    encodeURIComponent(lineageName),
    `${slot}.json`,
  );
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readIndex(recipeRoot: string): RecipeUsageIndex {
  const value = readJsonRecord(getRecipeUsageIndexPath(recipeRoot));
  const paths = value?.paths;
  return {
    paths: isRecord(paths)
      ? Object.fromEntries(
          Object.entries(paths).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {},
  };
}

function normalizeStoredLedger(
  value: Record<string, unknown>,
  lineageName: string,
): RecipeUsageRecord | undefined {
  return value.lineage_name === lineageName
    ? value as unknown as RecipeUsageRecord
    : undefined;
}

function readLedger(
  lineageName: string,
  recipeRoot: string,
): RecipeUsageRecord | undefined {
  const value = readJsonRecord(getRecipeUsageLedgerPath(lineageName, recipeRoot));
  return value ? normalizeStoredLedger(value, lineageName) : undefined;
}

function readIndexedLedger(
  indexedName: string,
  recipeRoot: string,
): { record: RecipeUsageRecord } | undefined {
  const current = readLedger(indexedName, recipeRoot);
  return current ? { record: current } : undefined;
}

function findRelocatedRecipe(
  index: RecipeUsageIndex,
  fingerprint: string,
  recipeRoot: string,
): { indexedName: string; path: string; record: RecipeUsageRecord } | undefined {
  const candidates = Object.entries(index.paths).flatMap(([oldPath, indexedName]) => {
    if (existsSync(join(recipeRoot, oldPath))) return [];
    const found = readIndexedLedger(indexedName, recipeRoot);
    return found?.record.fingerprint === fingerprint
      ? [{ indexedName, path: oldPath, record: found.record }]
      : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function launchCounterKey(
  kind: RecipeLaunchKind,
): "direct_calls" | "spawn_calls" | "tool_calls" {
  return `${kind}_calls` as "direct_calls" | "spawn_calls" | "tool_calls";
}

function revisionCounterKey(
  kind: RecipeLaunchKind,
): "revision_direct_calls" | "revision_spawn_calls" | "revision_tool_calls" {
  return `revision_${kind}_calls` as
    | "revision_direct_calls"
    | "revision_spawn_calls"
    | "revision_tool_calls";
}

export function readRecipeUsage(
  path: string,
  recipeRoot = inferRecipeRoot(path),
): Record<string, unknown> | undefined {
  try {
    const key = pathKey(path, recipeRoot);
    const indexedName = readIndex(recipeRoot).paths[key];
    if (indexedName) {
      return readIndexedLedger(indexedName, recipeRoot)?.record as unknown as
        | Record<string, unknown>
        | undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function ensureRecipeLineage(
  path: string,
  now = new Date(),
  recipeRoot = inferRecipeRoot(path),
): boolean {
  if (!existsSync(path)) return false;
  const indexPath = getRecipeUsageIndexPath(recipeRoot);
  return withFileMutationLock(indexPath, () => {
    try {
      const source = readRecipeSource(path);
      if (!source) return false;
      const key = pathKey(path, recipeRoot);
      const name = recipeName(path);
      const index = readIndex(recipeRoot);
      const indexedName = index.paths[key];
      if (indexedName) {
        const found = readIndexedLedger(indexedName, recipeRoot);
        if (!found || indexedName !== name) return false;
        if (found.record.fingerprint === source.fingerprint) return true;
        const ledgerPath = getRecipeUsageLedgerPath(name, recipeRoot);
        return withFileMutationLock(ledgerPath, () => {
          const current = readLedger(name, recipeRoot);
          if (!current) return false;
          if (current.fingerprint === source.fingerprint) return true;
          const nowIso = now.toISOString();
          const revision = current.revision + 1;
          writeJsonAtomic(ledgerPath, {
            ...current,
            fingerprint: source.fingerprint,
            lineage_events: appendEvent(current.lineage_events, {
              at: nowIso,
              type: "revised",
            }),
            reset_at: nowIso,
            reset_reason: "recipe content fingerprint changed",
            revision,
            revision_calls: 0,
            revision_direct_calls: 0,
            revision_spawn_calls: 0,
            revision_tool_calls: 0,
            revisions: appendRevision(current.revisions, {
              fingerprint: source.fingerprint,
              first_seen: nowIso,
              revision,
            }),
          });
          return true;
        });
      }
      if (readLedger(name, recipeRoot)) return false;
      const nowIso = now.toISOString();
      const ledgerPath = getRecipeUsageLedgerPath(name, recipeRoot);
      return withFileMutationLock(ledgerPath, () => {
        if (readLedger(name, recipeRoot)) return false;
        writeJsonAtomic(ledgerPath, {
          calls: 0,
          current_path: key,
          fingerprint: source.fingerprint,
          first_seen: nowIso,
          former_names: [],
          former_paths: [],
          lifetime_calls: 0,
          lineage_events: [{ at: nowIso, type: "created" }],
          lineage_name: name,
          review_epochs: [],
          reviewed_fingerprints: [],
          revision: 1,
          revision_calls: 0,
          revision_direct_calls: 0,
          revision_spawn_calls: 0,
          revision_tool_calls: 0,
          revisions: [{ fingerprint: source.fingerprint, first_seen: nowIso, revision: 1 }],
        } satisfies RecipeUsageRecord);
        index.paths[key] = name;
        writeJsonAtomic(indexPath, index);
        return true;
      });
    } catch {
      return false;
    }
  });
}

export function isCurrentRecipeRevisionReviewed(
  path: string,
  recipeRoot = inferRecipeRoot(path),
): boolean {
  const usage = readRecipeUsage(path, recipeRoot);
  return Boolean(
    usage &&
    typeof usage.fingerprint === "string" &&
    Array.isArray(usage.reviewed_fingerprints) &&
    usage.reviewed_fingerprints.includes(usage.fingerprint),
  );
}

export interface RecipeLaunchRecordOptions {
  onMutationLockContention?(): void;
}

export function recordRecipeLaunch(
  path: string,
  now = new Date(),
  kind: RecipeLaunchKind = "direct",
  recipeRoot = inferRecipeRoot(path),
  options: RecipeLaunchRecordOptions = {},
): boolean {
  return withFileMutationLock(recipeRoot, () => {
    if (!existsSync(path)) return false;
    const indexPath = getRecipeUsageIndexPath(recipeRoot);
    return withFileMutationLock(indexPath, () => {
      try {
      const source = readRecipeSource(path);
      if (!source) return false;
      const { fingerprint } = source;
      const key = pathKey(path, recipeRoot);
      const desiredName = recipeName(path);
      const index = readIndex(recipeRoot);
      const relocated = index.paths[key]
        ? undefined
        : findRelocatedRecipe(index, fingerprint, recipeRoot);
      const indexedName = index.paths[key] ?? relocated?.indexedName;
      const found = indexedName
        ? readIndexedLedger(indexedName, recipeRoot)
        : undefined;
      const existingAtDesired = readLedger(desiredName, recipeRoot);
      if (!found && existingAtDesired) return false;
      const stored = found?.record;
      const ledgerPath = getRecipeUsageLedgerPath(desiredName, recipeRoot);
      return withFileMutationLock(ledgerPath, () => {
        const nowIso = now.toISOString();
        const changed = Boolean(stored && stored.fingerprint !== fingerprint);
        const renamed = Boolean(stored && stored.lineage_name !== desiredName);
        const lifetimeCalls = normalizeCalls(
          stored?.lifetime_calls ?? stored?.calls,
        ) + 1;
        const counterKey = launchCounterKey(kind);
        const revisionKey = revisionCounterKey(kind);
        const revision = (stored?.revision ?? 1) + (changed ? 1 : 0);
        let events = stored?.lineage_events ?? [];
        if (renamed) {
          events = appendEvent(events, {
            at: nowIso,
            from: stored!.lineage_name,
            to: desiredName,
            type: "renamed",
          });
        }
        if (changed) events = appendEvent(events, { at: nowIso, type: "revised" });
        if (events.length === 0) events = [{ at: nowIso, type: "created" }];
        const existingRevisions = stored?.revisions ?? [];
        const record: RecipeUsageRecord = {
          ...stored,
          calls: lifetimeCalls,
          current_path: key,
          fingerprint,
          first_seen: stored?.first_seen ?? nowIso,
          former_names: renamed
            ? appendBounded(stored?.former_names ?? [], stored!.lineage_name)
            : relocated
              ? appendBounded(stored?.former_names ?? [], recipeName(relocated.path))
              : stored?.former_names ?? [],
          former_paths: relocated
            ? appendBounded(stored?.former_paths ?? [], relocated.path)
            : stored?.former_paths ?? [],
          lifetime_calls: lifetimeCalls,
          lineage_events: events,
          lineage_name: desiredName,
          review_epochs: stored?.review_epochs ?? [],
          reviewed_fingerprints: stored?.reviewed_fingerprints ?? [],
          revision,
          revision_calls: (changed ? 0 : normalizeCalls(stored?.revision_calls)) + 1,
          revision_direct_calls: changed ? 0 : normalizeCalls(stored?.revision_direct_calls),
          revision_spawn_calls: changed ? 0 : normalizeCalls(stored?.revision_spawn_calls),
          revision_tool_calls: changed ? 0 : normalizeCalls(stored?.revision_tool_calls),
          revisions: changed
            ? appendRevision(existingRevisions, { fingerprint, first_seen: nowIso, revision })
            : existingRevisions.length > 0
              ? existingRevisions
              : [{ fingerprint, first_seen: nowIso, revision }],
          [counterKey]: normalizeCalls(stored?.[counterKey]) + 1,
          [revisionKey]: (changed ? 0 : normalizeCalls(stored?.[revisionKey])) + 1,
          last_called: nowIso,
          launch_kind: kind,
          ...(changed
            ? { reset_at: nowIso, reset_reason: "recipe content fingerprint changed" }
            : {}),
        };
        writeJsonAtomic(ledgerPath, record);
        if (indexedName && indexedName !== desiredName) {
          const oldPath = getRecipeUsageLedgerPath(indexedName, recipeRoot);
          if (existsSync(oldPath)) unlinkSync(oldPath);
        }
        if (relocated) delete index.paths[relocated.path];
        index.paths[key] = desiredName;
        writeJsonAtomic(indexPath, index);
        return true;
      });
      } catch {
        return false;
      }
    });
  }, { onContention: options.onMutationLockContention });
}

export function recordRecipeReview(
  path: string,
  reviewEpoch: string,
  now = new Date(),
  recipeRoot = inferRecipeRoot(path),
): boolean {
  if (!reviewEpoch.trim()) return false;
  const indexPath = getRecipeUsageIndexPath(recipeRoot);
  return withFileMutationLock(indexPath, () => {
    try {
      const key = pathKey(path, recipeRoot);
      const lineageName = readIndex(recipeRoot).paths[key];
      if (!lineageName) return false;
      const ledgerPath = getRecipeUsageLedgerPath(lineageName, recipeRoot);
      return withFileMutationLock(ledgerPath, () => {
        const ledger = readLedger(lineageName, recipeRoot);
        if (!ledger) return false;
        if (ledger.review_epochs.includes(reviewEpoch)) return true;
        writeJsonAtomic(ledgerPath, {
          ...ledger,
          lineage_events: appendEvent(ledger.lineage_events ?? [], {
            at: now.toISOString(),
            review_epoch: reviewEpoch,
            type: "reviewed",
          }),
          review_epochs: appendBounded(ledger.review_epochs, reviewEpoch, 128),
          reviewed_fingerprints: appendBounded(
            ledger.reviewed_fingerprints ?? [],
            ledger.fingerprint,
            128,
          ),
        });
        return true;
      });
    } catch {
      return false;
    }
  });
}

export function recordRecipeRollback(
  path: string,
  rollbackRevision: number,
  now = new Date(),
  recipeRoot = inferRecipeRoot(path),
): boolean {
  if (!Number.isInteger(rollbackRevision) || rollbackRevision <= 0) return false;
  const indexPath = getRecipeUsageIndexPath(recipeRoot);
  return withFileMutationLock(indexPath, () => {
    try {
      const key = pathKey(path, recipeRoot);
      const lineageName = readIndex(recipeRoot).paths[key];
      if (!lineageName) return false;
      const ledgerPath = getRecipeUsageLedgerPath(lineageName, recipeRoot);
      return withFileMutationLock(ledgerPath, () => {
        const ledger = readLedger(lineageName, recipeRoot);
        if (!ledger) return false;
        if (ledger.rollback_of_revision === rollbackRevision) return true;
        writeJsonAtomic(ledgerPath, {
          ...ledger,
          lineage_events: appendEvent(ledger.lineage_events ?? [], {
            at: now.toISOString(),
            revision: ledger.revision,
            rollback_revision: rollbackRevision,
            type: "rollback",
          }),
          rollback_of_revision: rollbackRevision,
        });
        return true;
      });
    } catch {
      return false;
    }
  });
}

export function retireRecipeUsage(
  path: string,
  recipeRoot = inferRecipeRoot(path),
): boolean {
  const indexPath = getRecipeUsageIndexPath(recipeRoot);
  return withFileMutationLock(indexPath, () => {
    try {
      const key = pathKey(path, recipeRoot);
      const index = readIndex(recipeRoot);
      const lineageName = index.paths[key];
      if (!lineageName) return true;
      delete index.paths[key];
      writeJsonAtomic(indexPath, index);
      const ledgerPath = getRecipeUsageLedgerPath(lineageName, recipeRoot);
      if (existsSync(ledgerPath)) unlinkSync(ledgerPath);
      return true;
    } catch {
      return false;
    }
  });
}

export function moveRecipeUsage(
  fromPath: string,
  toPath: string,
  recipeRoot = inferRecipeRoot(fromPath),
): boolean {
  const indexPath = getRecipeUsageIndexPath(recipeRoot);
  return withFileMutationLock(indexPath, () => {
    try {
      const fromKey = pathKey(fromPath, recipeRoot);
      const toKey = pathKey(toPath, recipeRoot);
      const index = readIndex(recipeRoot);
      const oldName = index.paths[fromKey];
      const newName = recipeName(toPath);
      if (!oldName) {
        return index.paths[toKey] === newName && Boolean(readLedger(newName, recipeRoot));
      }
      if (index.paths[toKey]) return false;
      const found = readIndexedLedger(oldName, recipeRoot);
      if (!found || (oldName !== newName && readLedger(newName, recipeRoot))) return false;
      const oldLedgerPath = getRecipeUsageLedgerPath(oldName, recipeRoot);
      const newLedgerPath = getRecipeUsageLedgerPath(newName, recipeRoot);
      return withFileMutationLock(newLedgerPath, () => {
        const fromDraft = fromKey.startsWith("drafts/");
        const toDraft = toKey.startsWith("drafts/");
        const transition: RecipeLineageEvent["type"] = fromDraft && !toDraft
          ? "promoted"
          : !fromDraft && toDraft
            ? "demoted"
            : "renamed";
        writeJsonAtomic(newLedgerPath, {
          ...found.record,
          current_path: toKey,
          former_names: oldName !== newName
            ? appendBounded(found.record.former_names, oldName)
            : found.record.former_names,
          former_paths: appendBounded(found.record.former_paths, fromKey),
          lineage_events: appendEvent(found.record.lineage_events ?? [], {
            at: new Date().toISOString(),
            from: oldName,
            to: newName,
            type: transition,
          }),
          lineage_name: newName,
        });
        index.paths[toKey] = newName;
        delete index.paths[fromKey];
        writeJsonAtomic(indexPath, index);
        if (oldLedgerPath !== newLedgerPath && existsSync(oldLedgerPath)) {
          unlinkSync(oldLedgerPath);
        }
        return true;
      });
    } catch {
      return false;
    }
  });
}
