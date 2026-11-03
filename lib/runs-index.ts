/**
 * Async run state index.
 * Owns: directory discovery, locked catalog registration/rebuild, same-session location navigation, and legacy inventory.
 * Excludes: launch wiring, model delivery, work/native authority, and retained-generation storage.
 */

import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

import { acquireFileMutationLock, writeTextAtomic } from "./file-state.ts";
import { observeRunContextExportLocation, readRunContextIdentity, runContextExportPath, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, type RunContextIndexIdentity } from "./runs-context-index.ts";
import { RUN_DELIVERY_MODEL_MAX_BYTES } from "./limits.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export interface RunStateIndexEntry {
  ownerId?: string;
  recipe?: string;
  run: string;
  run_instance_id?: string;
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

export interface RunStateDiscoveryIssue {
  path: string;
  reason: "depth_truncated" | "unreadable";
}

export interface RunStateDiscoveryResult {
  issues: RunStateDiscoveryIssue[];
  stateDirs: string[];
}

export function discoverRunStateDirs(
  stateRoot: string,
  maxDepth = 8,
): RunStateDiscoveryResult {
  const issues: RunStateDiscoveryIssue[] = [];
  const stateDirs: string[] = [];
  const seen = new Set<string>();
  const visit = (directory: string, depth: number): void => {
    const canonical = resolve(directory);
    if (!existsSync(directory) || seen.has(canonical)) return;
    seen.add(canonical);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      issues.push({ path: directory, reason: "unreadable" });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(directory, entry.name);
      if (existsSync(join(child, "run.json"))) stateDirs.push(child);
      if (depth + 1 < maxDepth) visit(child, depth + 1);
      else {
        try {
          if (
            readdirSync(child, { withFileTypes: true }).some((item) =>
              item.isDirectory(),
            )
          ) {
            issues.push({ path: child, reason: "depth_truncated" });
          }
        } catch {
          issues.push({ path: child, reason: "unreadable" });
        }
      }
    }
  };
  visit(stateRoot, 0);
  return {
    issues: issues.sort((left, right) => left.path.localeCompare(right.path)),
    stateDirs: [...new Set(stateDirs)].sort(),
  };
}

export function listRunStateDirs(stateRoot: string): string[] {
  return discoverRunStateDirs(stateRoot).stateDirs;
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

interface DirectoryRegistration {
  entry: RunStateIndexEntry;
  unchanged: () => boolean;
}
interface RunStateCatalog {
  entries: RunStateIndexEntry[];
  [key: string]: unknown;
}

function prepareDirectoryRegistration(stateDir: string, status: Record<string, unknown>): DirectoryRegistration {
  if (!status || typeof status !== "object" || typeof status.run !== "string" || !status.run ||
      typeof status.run_instance_id !== "string" || !status.run_instance_id ||
      typeof status.state_dir !== "string" || typeof status.status !== "string" || !status.status ||
      (Object.hasOwn(status, "ownerId") && (typeof status.ownerId !== "string" || !status.ownerId))) {
    throw new Error("Run state directory registration identity is invalid.");
  }
  const reading = readRunContextIdentity(resolve(stateDir), { run: status.run, run_instance_id: status.run_instance_id,
    ...(Object.hasOwn(status, "ownerId") ? { ownerId: status.ownerId } : {}) });
  if (reading.state !== "available" || status.state_dir !== reading.local_path) {
    throw new Error("Run state directory registration identity is unavailable.");
  }
  const progress = status.progress && typeof status.progress === "object" ? status.progress as Record<string, unknown> : undefined;
  const entry: RunStateIndexEntry = { run: reading.identity.run, run_instance_id: reading.identity.run_instance_id,
    state_dir: reading.local_path, status: status.status,
    ...(reading.identity.ownerId === undefined ? {} : { ownerId: reading.identity.ownerId }),
    ...(typeof status.recipe === "string" ? { recipe: status.recipe } : {}),
    ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
    ...(typeof progress?.updatedAt === "string" ? { updated_at: progress.updatedAt }
      : typeof status.createdAt === "string" ? { updated_at: status.createdAt } : {}) };
  return { entry, unchanged: reading.unchanged };
}

function readCatalog(path: string): RunStateCatalog | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let bytes: Buffer;
  let failed = false;
  let failure: unknown;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Run state catalog requires a regular file.");
    bytes = readFileSync(fd);
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { closeSync(fd); }
    catch (error) { throw failed ? new AggregateError([failure, error], "Run state catalog read and close failed.") : error; }
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as RunStateCatalog).entries)) {
    throw new Error("Run state catalog is invalid.");
  }
  const catalog = value as RunStateCatalog;
  for (const row of catalog.entries) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.run !== "string" ||
        typeof row.state_dir !== "string" || typeof row.status !== "string" ||
        (Object.hasOwn(row, "ownerId") && typeof row.ownerId !== "string") ||
        (Object.hasOwn(row, "run_instance_id") && typeof row.run_instance_id !== "string")) {
      throw new Error("Run state catalog entry is invalid.");
    }
  }
  return catalog;
}

function publishDirectoryRegistrations(stateRoot: string, registrations: DirectoryRegistration[], explicit: boolean): RunStateIndexEntry[] {
  mkdirSync(stateRoot, { recursive: true });
  const path = runIndexPath(stateRoot);
  const release = acquireFileMutationLock(path);
  let failed = false;
  let failure: unknown;
  try {
    const catalog = readCatalog(path) ?? { entries: [] };
    let entries = [...catalog.entries];
    const assertCurrent = (): void => {
      if (registrations.some(registration => !registration.unchanged())) {
        throw new Error("Run state directory registration observation changed.");
      }
    };
    assertCurrent();
    for (const { entry } of registrations) {
      const position = entries.findIndex(row => row.state_dir === entry.state_dir);
      const previous = entries[position];
      const sameGeneration = previous && previous.run === entry.run && previous.ownerId === entry.ownerId &&
        previous.run_instance_id === entry.run_instance_id;
      const merged = sameGeneration ? { ...previous, ...entry } : { ...entry };
      for (const optional of ["ownerId", "recipe", "tool", "updated_at"] as const) {
        if (!Object.hasOwn(entry, optional)) delete merged[optional];
      }
      const remaining = entries.filter(row => row.state_dir !== entry.state_dir);
      if (!explicit && sameGeneration) remaining.splice(position, 0, merged);
      else remaining.unshift(merged);
      entries = remaining;
    }
    writeTextAtomic(path, `${JSON.stringify({ ...catalog, entries, rebuilt_at: new Date().toISOString() }, null, 2)}\n`,
      { onBeforeReplace: assertCurrent });
    return entries;
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { release(); }
    catch (error) { throw failed ? new AggregateError([failure, error], "Run state catalog publication and release failed.") : error; }
  }
}

/** Kernel metadata registration only; never a producer, work or visibility capability. */
export function registerRunStateDirectory(stateRoot: string, stateDir: string, status: Record<string, unknown>): void {
  publishDirectoryRegistrations(stateRoot, [prepareDirectoryRegistration(stateDir, status)], true);
}

export function rebuildRunStateIndex(
  stateRoot: string,
  getRunStatus: RunStatusReader,
): RunStateIndexEntry[] {
  const registrations = listRunStateDirs(stateRoot).flatMap(stateDir => {
    try { return [prepareDirectoryRegistration(stateDir, getRunStatus(stateDir))]; }
    catch { return []; }
  });
  return publishDirectoryRegistrations(stateRoot, registrations, false);
}

function observeRunInventory(stateDirs: string[], getRunStatus: RunStatusReader): RunStateIndexEntry[] {
  return stateDirs.flatMap(stateDir => {
    try { return [indexEntryFromStatus(getRunStatus(stateDir))]; }
    catch { return []; }
  });
}

export interface RunNavigationFile {
  readonly role: string;
  readonly format_hint: "json" | "jsonl" | "text";
  readonly state: "present" | "missing" | "unavailable";
  readonly path: string | null;
  readonly bytes_total?: number;
  readonly mutable: true;
}
export interface RunNavigationItem {
  readonly run: string;
  readonly run_instance_id: string | null;
  readonly state: "available" | "unavailable";
  readonly directory: string | null;
  readonly depth: number;
  readonly files: readonly Readonly<RunNavigationFile>[];
  readonly reason?: string;
}
export interface RunNavigationPriority {
  readonly root_order: "latest_registration" | "failed_subtrees_first";
  /** Observed data for ordering only; exact map identity admission remains independent. */
  readonly failed: readonly Readonly<RunContextIndexIdentity & { state_dir: string }>[];
}

export type RunSessionNavigation =
  | { readonly state: "unavailable"; readonly reason: "session_unavailable" | "catalog_unavailable" | "response_too_large" }
  | { readonly state: "available"; readonly session_id: string; readonly content_scope: "file_locations_only";
      readonly lineage_scope: "direct_session_owned_rows"; readonly file_inventory_scope: "canonical_starting_locations";
      readonly priority?: Readonly<{ root_order: RunNavigationPriority["root_order"]; basis: "observed_failed_rows" }>;
      readonly items: readonly Readonly<RunNavigationItem>[];
      readonly shown: number; readonly omitted: number; readonly total: number };

export type RunDirectoryNavigation =
  | { readonly state: "unavailable"; readonly reason: "session_unavailable" | "session_mismatch" | "session_changed" |
      "identity_unavailable" | "identity_mismatch" | "observation_changed" | "navigation_unavailable" | "response_too_large" }
  | { readonly state: "available"; readonly content_scope: "file_locations_only";
      readonly file_inventory_scope: "canonical_starting_locations"; readonly run: string; readonly run_instance_id: string;
      readonly directory: string; readonly files: readonly Readonly<RunNavigationFile>[] };

const NAVIGATION_FILES = [
  ["context_index", "context-index.json", "json"], ["result", "result.json", "json"], ["metadata", "run.json", "json"],
  ["execution", "execution.json", "json"], ["trace", "trace.jsonl", "jsonl"], ["control", "controls.jsonl", "jsonl"],
  ["stdout", "stdout.log", "text"], ["stderr", "stderr.log", "text"],
] as const;

function navigationFiles(directory: string, expected: RunContextIndexIdentity): {
  files: readonly Readonly<RunNavigationFile>[]; unchanged: () => boolean;
} {
  const files: Readonly<RunNavigationFile>[] = NAVIGATION_FILES.map(([role, leaf, format_hint]) => {
    const path = join(directory, leaf);
    try {
      const observed = lstatSync(path);
      if (!observed.isFile() || !Number.isSafeInteger(observed.size) || observed.size < 0) {
        return Object.freeze({ role, format_hint, state: "unavailable" as const, path: null, mutable: true as const });
      }
      return Object.freeze({ role, format_hint, state: "present" as const, path, bytes_total: observed.size, mutable: true as const });
    } catch (error) {
      return Object.freeze({ role, format_hint, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" as const : "unavailable" as const,
        path: null, mutable: true as const });
    }
  });
  const sessions = observeRunContextExportLocation(directory, expected, "sessions");
  files.splice(4, 0, Object.freeze({ role: "published_sessions", format_hint: "json", mutable: true,
    state: sessions.state === "available" ? "present" : sessions.reason === "export_missing" ? "missing" : "unavailable",
    path: sessions.state === "available" ? sessions.local_path : null,
    ...(sessions.state === "available" ? { bytes_total: sessions.bytes_total } : {}) }));
  return { files: Object.freeze(files), unchanged: sessions.state === "available" ? sessions.unchanged : () => true };
}

/** Pure data decoder for frozen location packets; schema validity never grants read/publication/work authority. */
export function decodeRunDirectoryNavigation(value: unknown): Readonly<RunDirectoryNavigation> {
  const invalid = (): never => { throw new Error("Run file navigation data is invalid"); };
  const record = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors)) {
      if (!fields.includes(key) || !Object.hasOwn(descriptors[key], "value")) return invalid();
      result[key] = descriptors[key].value;
    }
    return result;
  };
  const string = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && Buffer.from(value).toString("utf8") === value;
  const base = record(value, ["state", "reason", "run", "run_instance_id", "directory", "content_scope", "file_inventory_scope", "files"]);
  if (base.state === "unavailable") {
    const reasons = ["session_unavailable", "session_mismatch", "session_changed", "identity_unavailable", "identity_mismatch", "observation_changed", "navigation_unavailable", "response_too_large"];
    if (Object.keys(base).length !== 2 || !reasons.includes(base.reason as string)) return invalid();
    return Object.freeze({ state: "unavailable", reason: base.reason as Extract<RunDirectoryNavigation, { state: "unavailable" }>["reason"] });
  }
  if (base.state !== "available" || Object.keys(base).length !== 7 || !string(base.run) || !string(base.run_instance_id) || !string(base.directory) ||
    base.directory !== resolve(base.directory) || base.content_scope !== "file_locations_only" ||
    base.file_inventory_scope !== "canonical_starting_locations" || !Array.isArray(base.files)) return invalid();
  const slots: readonly (readonly [string, string, string])[] = [...NAVIGATION_FILES.slice(0, 4),
    ["published_sessions", runContextExportPath("sessions"), "json"], ...NAVIGATION_FILES.slice(4)];
  if (base.files.length !== slots.length || Object.keys(base.files).length !== slots.length) return invalid();
  const directory = base.directory, sourceFiles = base.files;
  const files = slots.map(([role, leaf, format], index): Readonly<RunNavigationFile> => {
    const descriptor = Object.getOwnPropertyDescriptor(sourceFiles, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
    const file = record(descriptor.value, ["role", "format_hint", "state", "path", "bytes_total", "mutable"]);
    if (file.role !== role || file.format_hint !== format || file.mutable !== true) return invalid();
    if (file.state === "present") {
      if (file.path !== join(directory, leaf) || typeof file.bytes_total !== "number" || !Number.isSafeInteger(file.bytes_total) || file.bytes_total < 0) return invalid();
      return Object.freeze({ role, format_hint: format as RunNavigationFile["format_hint"], state: "present", path: file.path as string, bytes_total: file.bytes_total, mutable: true });
    }
    if ((file.state !== "missing" && file.state !== "unavailable") || file.path !== null || file.bytes_total !== undefined) return invalid();
    return Object.freeze({ role, format_hint: format as RunNavigationFile["format_hint"], state: file.state, path: null, mutable: true });
  });
  const answer = Object.freeze({ state: "available" as const, content_scope: "file_locations_only" as const,
    file_inventory_scope: "canonical_starting_locations" as const, run: base.run, run_instance_id: base.run_instance_id,
    directory, files: Object.freeze(files) });
  return Buffer.byteLength(JSON.stringify(answer), "utf8") <= RUN_DELIVERY_MODEL_MAX_BYTES ? answer : invalid();
}

/** One exact current-session Run's physical starting locations; no catalog/body reads or authority recovery. */
export function readRunDirectoryNavigation(stateDir: string, expected: unknown, sessionId: string | undefined): Readonly<RunDirectoryNavigation> {
  const unavailable = (reason: Extract<RunDirectoryNavigation, { state: "unavailable" }>["reason"]): Readonly<RunDirectoryNavigation> =>
    Object.freeze({ state: "unavailable", reason });
  if (typeof sessionId !== "string" || !sessionId) return unavailable("session_unavailable");
  const owner = expected && typeof expected === "object" ? Object.getOwnPropertyDescriptor(expected, "ownerId") : undefined;
  if (!owner || !Object.hasOwn(owner, "value") || owner.value !== sessionId) return unavailable("session_mismatch");
  const identity = readRunContextIdentity(stateDir, expected);
  if (identity.state !== "available") return unavailable(identity.reason);
  const observed = navigationFiles(identity.local_path, identity.identity);
  const value = Object.freeze({ state: "available" as const, content_scope: "file_locations_only" as const,
    file_inventory_scope: "canonical_starting_locations" as const, run: identity.identity.run,
    run_instance_id: identity.identity.run_instance_id, directory: identity.local_path, files: observed.files });
  if (!identity.unchanged() || !observed.unchanged()) return unavailable("observation_changed");
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= RUN_DELIVERY_MODEL_MAX_BYTES ? value : unavailable("response_too_large");
}

/** Current Kernel session selection only; no body reads, scans, producer key or old manager retention. */
export function readRunSessionNavigation(stateRoot: string, sessionId: string, priority?: RunNavigationPriority): Readonly<RunSessionNavigation> {
  const unavailable = (reason: Extract<RunSessionNavigation, { state: "unavailable" }>["reason"]): Readonly<RunSessionNavigation> => Object.freeze({ state: "unavailable", reason });
  if (typeof sessionId !== "string" || !sessionId) return unavailable("session_unavailable");
  let catalog: RunStateCatalog | undefined;
  try { catalog = readCatalog(runIndexPath(stateRoot)); }
  catch { return unavailable("catalog_unavailable"); }
  if (!catalog) return unavailable("catalog_unavailable");
  const selected = catalog.entries.filter(row => row.ownerId === sessionId);
  if (new Set(selected.map(row => row.state_dir)).size !== selected.length) return unavailable("catalog_unavailable");
  const key = (row: { run: string; run_instance_id?: unknown; state_dir: string }) => JSON.stringify([row.run, row.run_instance_id, row.state_dir]);
  const nodes = selected.map(row => {
    const invalid = (reason: string): Readonly<RunNavigationItem> => Object.freeze({ run: row.run,
      run_instance_id: typeof row.run_instance_id === "string" ? row.run_instance_id : null,
      state: "unavailable", directory: null, depth: 0, files: Object.freeze([]), reason });
    if (typeof row.run_instance_id !== "string" || !row.run_instance_id) return { key: key(row), item: invalid("generation_unavailable"), parent: undefined, unchanged: () => true };
    const identity = readRunContextIdentity(row.state_dir, { run: row.run, run_instance_id: row.run_instance_id, ownerId: sessionId });
    if (identity.state !== "available") return { key: key(row), item: invalid(identity.reason), parent: undefined, unchanged: () => true };
    const read = readJsonFileResilient<Record<string, unknown> | undefined>(join(identity.local_path, "run.json"), undefined,
      { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
    if (read.diagnostics.length || !read.value || !identity.unchanged()) {
      return { key: key(row), item: invalid("observation_changed"), parent: undefined, unchanged: () => true };
    }
    const parent = read.value.delivery_parent;
    const p = parent && typeof parent === "object" && !Array.isArray(parent) ? parent as Record<string, unknown> : undefined;
    const parentKey = p && typeof p.run === "string" && typeof p.run_instance_id === "string" && typeof p.state_dir === "string"
      ? key({ run: p.run, run_instance_id: p.run_instance_id, state_dir: p.state_dir }) : undefined;
    const files = navigationFiles(identity.local_path, identity.identity);
    const item: Readonly<RunNavigationItem> = Object.freeze({ run: row.run, run_instance_id: row.run_instance_id,
      state: "available", directory: identity.local_path, depth: 0, files: files.files });
    return { key: key(row), item, parent: parentKey, unchanged: () => identity.unchanged() && files.unchanged() };
  });
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const children = new Map<string, typeof nodes>();
  const roots: typeof nodes = [];
  for (const node of nodes) {
    if (node.parent && byKey.has(node.parent)) {
      const siblings = children.get(node.parent) ?? []; siblings.push(node); children.set(node.parent, siblings);
    } else roots.push(node);
  }
  const failedSubtrees = new Set<string>();
  for (const failure of priority?.failed ?? []) {
    if (failure.ownerId !== sessionId) continue;
    const observedKey = key(failure), node = byKey.get(observedKey);
    if (node?.item.state === "available") failedSubtrees.add(observedKey);
  }
  const pending = [...failedSubtrees];
  while (pending.length) {
    const parent = byKey.get(pending.pop()!)?.parent;
    if (parent && byKey.get(parent)?.item.state === "available" && !failedSubtrees.has(parent)) {
      failedSubtrees.add(parent); pending.push(parent);
    }
  }
  // Stable partition preserves catalog recency among peers; a failed descendant never precedes its own ancestors.
  const preferFailed = (peers: typeof nodes): typeof nodes => [
    ...peers.filter(node => failedSubtrees.has(node.key)), ...peers.filter(node => !failedSubtrees.has(node.key)),
  ];
  const ordered: Readonly<RunNavigationItem>[] = [];
  const seen = new Set<string>();
  const orderedRoots = priority?.root_order === "failed_subtrees_first" ? preferFailed(roots) : roots;
  const stack = orderedRoots.slice().reverse().map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (seen.has(node.key)) continue;
    seen.add(node.key);
    ordered.push(Object.freeze({ ...node.item, depth }));
    for (const child of preferFailed(children.get(node.key) ?? []).reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  for (const node of nodes) if (!seen.has(node.key)) ordered.push(Object.freeze({ ...node.item,
    state: "unavailable", reason: "lineage_cycle", directory: null, files: Object.freeze([]) }));
  const items: Readonly<RunNavigationItem>[] = [];
  const result = () => Object.freeze({ state: "available" as const, session_id: sessionId,
    content_scope: "file_locations_only" as const, lineage_scope: "direct_session_owned_rows" as const,
    file_inventory_scope: "canonical_starting_locations" as const,
    ...(priority ? { priority: Object.freeze({ root_order: priority.root_order, basis: "observed_failed_rows" as const }) } : {}),
    items: Object.freeze(items.slice()), shown: items.length, omitted: ordered.length - items.length, total: ordered.length });
  if (Buffer.byteLength(JSON.stringify(result())) > RUN_DELIVERY_MODEL_MAX_BYTES) return unavailable("response_too_large");
  for (const item of ordered) {
    items.push(item);
    if (Buffer.byteLength(JSON.stringify(result())) > RUN_DELIVERY_MODEL_MAX_BYTES) { items.pop(); break; }
  }
  const answer = result();
  return nodes.some(node => !node.unchanged()) ? unavailable("catalog_unavailable") : answer;
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
  // The catalog locates directories; registration-time status cannot decide current inventory or filters.
  const entries = observeRunInventory(indexed ? indexed.map(entry => entry.state_dir) : listRunStateDirs(stateRoot), getRunStatus);
  if (!indexed) entries.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return entries
    .filter((entry) => matchesStatusFilter(entry.status, statusFilter))
    .map(compactIndexEntry);
}
