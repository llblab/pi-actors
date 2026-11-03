/**
 * Run context-index metadata, deterministic references and admitted publication.
 * Owns: bounded identity/index reads, role schema, regular references and admitted index publication.
 * Excludes: role-body reads/creation/redaction, model exposure authorization, lifecycle admission and native authority.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { writeTextAtomic } from "./file-state.ts";
import { readOwnedRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.ts";

export const RUN_CONTEXT_INDEX_FILE = "context-index.json";
export const RUN_CONTEXT_INDEX_METADATA_MAX_BYTES = 16 * 1024;
/** Canonical run.json input, not an index/marker/model-output allowance. */
export const RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES = 1024 * 1024;

const EXPORTS = {
  recipe: ["recipe.json", "application/json", false],
  result: ["result.json", "application/json", false],
  trace: ["trace.jsonl", "application/x-ndjson", true],
  control: ["control.json", "application/json", true],
  execution: ["execution.json", "application/json", true],
  artifacts: ["artifacts.json", "application/json", false],
  sessions: ["sessions.json", "application/json", true],
  stdout: ["stdout.log", "text/plain", true],
  stderr: ["stderr.log", "text/plain", true],
} as const;

export type RunContextRole = keyof typeof EXPORTS;
export function runContextExportPath(role: RunContextRole): string {
  return "evidence/" + EXPORTS[role][0];
}
export interface RunContextIndexIdentity {
  readonly run: string;
  readonly run_instance_id: string;
  readonly ownerId?: string;
}
export interface RunContextCoverage {
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly history_complete?: boolean;
}
export type RunContextEntry =
  | { readonly availability: "available"; readonly path: string; readonly media_type: string;
      readonly bytes_total: number; readonly mutable: boolean; readonly coverage: Readonly<RunContextCoverage> }
  | { readonly availability: "pending" | "not_applicable"; readonly path: null }
  | { readonly availability: "unavailable"; readonly path: null; readonly reason: string };
export interface RunContextIndex {
  readonly schema: "run-context-index-v1";
  readonly run: string;
  readonly run_instance_id: string;
  readonly updated_at: string;
  readonly entries: Readonly<Record<RunContextRole, Readonly<RunContextEntry>>>;
}
export type RunContextIndexReading =
  | { readonly state: "available"; readonly index: Readonly<RunContextIndex>;
      readonly identity: Readonly<RunContextIndexIdentity>; readonly local_path: string }
  | { readonly state: "unavailable"; readonly reason: "identity_unavailable" | "identity_mismatch" |
      "index_unavailable" | "index_invalid" | "role_unavailable" | "observation_changed" };

export type RunContextIdentityReading =
  | { readonly state: "available"; readonly identity: Readonly<RunContextIndexIdentity>;
      readonly local_path: string; readonly unchanged: () => boolean }
  | { readonly state: "unavailable"; readonly reason: "identity_unavailable" | "identity_mismatch" | "observation_changed" };

export type RunContextExportLocationReading =
  | { readonly state: "available"; readonly identity: Readonly<RunContextIndexIdentity>;
      readonly path: string; readonly local_path: string; readonly bytes_total: number;
      readonly mutable: true; readonly unchanged: () => boolean }
  | { readonly state: "unavailable"; readonly reason: "role_invalid" | "identity_unavailable" | "identity_mismatch" |
      "observation_changed" | "export_missing" | "export_unavailable" | "export_size_unrepresentable" };

type IndexUnavailable = Extract<RunContextIndexReading, { state: "unavailable" }>;
type FailureReason = IndexUnavailable["reason"];
function unavailable(reason: FailureReason): IndexUnavailable {
  return Object.freeze({ state: "unavailable", reason });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function own(value: Record<string, unknown> | undefined, key: string): unknown {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}
function known(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= RUN_CONTEXT_INDEX_METADATA_MAX_BYTES;
}
function identity(value: unknown): RunContextIndexIdentity | undefined {
  const source = object(value);
  const run = own(source, "run");
  const generation = own(source, "run_instance_id");
  if (!text(run) || /[^A-Za-z0-9_.-]/u.test(run) || !text(generation)) return undefined;
  if (source && Object.hasOwn(source, "ownerId")) {
    return text(source.ownerId) ? { run, run_instance_id: generation, ownerId: source.ownerId } : undefined;
  }
  return source?.ownerId === undefined ? { run, run_instance_id: generation } : undefined;
}
function sameIdentity(left: RunContextIndexIdentity, right: RunContextIndexIdentity): boolean {
  return left.run === right.run && left.run_instance_id === right.run_instance_id && left.ownerId === right.ownerId;
}
function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && sameObject(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Retain the opened object for bounded JSON reads or readability-only role checks; never read role bytes. */
function inspectFile(path: string, metadataMaxBytes?: number): { stamp: BigIntStats; value: unknown } | undefined {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || (metadataMaxBytes !== undefined && before.size > BigInt(metadataMaxBytes))) return undefined;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) return undefined;
    let value: unknown;
    if (metadataMaxBytes !== undefined) {
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!read) break;
        offset += read;
      }
      if (offset !== bytes.length) return undefined;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { value = undefined; }
    }
    if (!sameFile(opened, fstatSync(fd, { bigint: true })) || !sameFile(opened, lstatSync(path, { bigint: true }))) return undefined;
    return { stamp: opened, value };
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function decodeEntry(value: unknown, role: RunContextRole): Readonly<RunContextEntry> | undefined {
  const entry = object(value);
  if (!entry) return undefined;
  const availability = own(entry, "availability");
  const path = own(entry, "path");
  if (availability === "pending" || availability === "not_applicable") {
    return path === null && known(entry, ["availability", "path"]) ? Object.freeze({ availability, path }) : undefined;
  }
  if (availability === "unavailable") {
    const reason = own(entry, "reason");
    return path === null && typeof reason === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(reason) &&
      !/[\r\n]/u.test(reason) && known(entry, ["availability", "path", "reason"])
      ? Object.freeze({ availability, path, reason }) : undefined;
  }
  const [, media, temporal] = EXPORTS[role];
  const mediaType = own(entry, "media_type");
  const bytes = own(entry, "bytes_total");
  const mutable = own(entry, "mutable");
  const coverage = object(own(entry, "coverage"));
  if (availability !== "available" || path !== runContextExportPath(role) || typeof mediaType !== "string" ||
    (mediaType !== media && !(media === "text/plain" && mediaType === "text/plain; charset=utf-8")) ||
    typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || typeof mutable !== "boolean" || !coverage ||
    !known(entry, ["availability", "path", "media_type", "bytes_total", "mutable", "coverage"]) ||
    !known(coverage, ["truncated", "redacted", "history_complete"]) ||
    typeof own(coverage, "truncated") !== "boolean" || typeof own(coverage, "redacted") !== "boolean" ||
    ((temporal || Object.hasOwn(coverage, "history_complete")) && typeof own(coverage, "history_complete") !== "boolean")) return undefined;
  return Object.freeze({ availability, path, media_type: mediaType, bytes_total: bytes, mutable,
    coverage: Object.freeze({ truncated: coverage.truncated as boolean, redacted: coverage.redacted as boolean,
      ...(typeof coverage.history_complete === "boolean" ? { history_complete: coverage.history_complete } : {}) }) });
}

function decodeIndex(value: unknown, expected: RunContextIndexIdentity): Readonly<RunContextIndex> | undefined {
  const source = object(value);
  const entries = object(own(source, "entries"));
  const updated = own(source, "updated_at");
  const time = typeof updated === "string" ? Date.parse(updated) : NaN;
  if (!source || !known(source, ["schema", "run", "run_instance_id", "updated_at", "entries"]) ||
    own(source, "schema") !== "run-context-index-v1" || own(source, "run") !== expected.run ||
    own(source, "run_instance_id") !== expected.run_instance_id || !entries ||
    !Number.isSafeInteger(time) || new Date(time).toISOString() !== updated || !known(entries, Object.keys(EXPORTS))) return undefined;
  const decoded = {} as Record<RunContextRole, Readonly<RunContextEntry>>;
  for (const role of Object.keys(EXPORTS) as RunContextRole[]) {
    const entry = decodeEntry(own(entries, role), role);
    if (!entry) return undefined;
    decoded[role] = entry;
  }
  return Object.freeze({ schema: "run-context-index-v1", run: expected.run, run_instance_id: expected.run_instance_id,
    updated_at: updated as string, entries: Object.freeze(decoded) });
}

interface ContextOwnerObservation {
  root: string;
  directory: BigIntStats;
  marker: BigIntStats;
  meta: BigIntStats;
}

function readContextOwner(stateDir: string, request: RunContextIndexIdentity):
  { state: "available"; owner: ContextOwnerObservation } | IndexUnavailable {
  try {
    const root = resolve(stateDir);
    const directory = lstatSync(root, { bigint: true });
    const marker = lstatSync(join(root, RUN_STATE_OWNERSHIP_FILE), { bigint: true });
    if (!directory.isDirectory() || !marker.isFile() || marker.size > BigInt(RUN_CONTEXT_INDEX_METADATA_MAX_BYTES)) {
      return unavailable("identity_unavailable");
    }
    const owned = readOwnedRunStateDirectory(root, { maxBytes: RUN_CONTEXT_INDEX_METADATA_MAX_BYTES });
    if (owned.run !== request.run) return unavailable("identity_mismatch");
    const meta = inspectFile(join(owned.stateDir, "run.json"), RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    const value = object(meta?.value);
    const actual = identity(value);
    if (!meta || !value || !actual) return unavailable("identity_unavailable");
    if (!sameIdentity(request, actual) || own(value, "state_dir") !== owned.stateDir) return unavailable("identity_mismatch");
    return { state: "available", owner: { root: owned.stateDir, directory, marker, meta: meta.stamp } };
  } catch { return unavailable("identity_unavailable"); }
}

function ownerUnchanged(owner: ContextOwnerObservation): boolean {
  const current = lstatSync(owner.root, { bigint: true });
  return current.isDirectory() && sameObject(owner.directory, current) &&
    sameFile(owner.marker, lstatSync(join(owner.root, RUN_STATE_OWNERSHIP_FILE), { bigint: true })) &&
    sameFile(owner.meta, lstatSync(join(owner.root, "run.json"), { bigint: true }));
}

/** Shared readonly owner/generation observation without requiring an index or granting body/work authority. */
export function readRunContextIdentity(stateDir: string, expected: unknown): Readonly<RunContextIdentityReading> {
  const request = identity(expected);
  if (!request || !isAbsolute(stateDir)) return Object.freeze({ state: "unavailable", reason: "identity_unavailable" });
  const admission = readContextOwner(stateDir, request);
  if (admission.state === "unavailable") return Object.freeze({ state: "unavailable",
    reason: admission.reason === "identity_mismatch" ? "identity_mismatch" : "identity_unavailable" });
  const unchanged = (): boolean => { try { return ownerUnchanged(admission.owner); } catch { return false; } };
  if (!unchanged()) return Object.freeze({ state: "unavailable", reason: "observation_changed" });
  return Object.freeze({ state: "available", identity: Object.freeze({ ...request }), local_path: admission.owner.root, unchanged });
}

interface ExportObservation { path: string; stamp: BigIntStats; directory: BigIntStats; }
function inspectExport(root: string, entry: Extract<RunContextEntry, { availability: "available" }>): ExportObservation | undefined {
  try {
    const directory = lstatSync(join(root, "evidence"), { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;
    const path = join(root, entry.path);
    const observed = inspectFile(path);
    return observed && observed.stamp.size === BigInt(entry.bytes_total) ? { path, stamp: observed.stamp, directory } : undefined;
  } catch { return undefined; }
}

function exportsUnchanged(root: string, exports: readonly ExportObservation[]): boolean {
  return exports.every(file => {
    const directory = lstatSync(join(root, "evidence"), { bigint: true });
    return directory.isDirectory() && !directory.isSymbolicLink() && sameObject(file.directory, directory) &&
      sameFile(file.stamp, lstatSync(file.path, { bigint: true }));
  });
}

/** Physical fixed-role location only: no index/producer, role-body reads or curated publication certification. */
export function observeRunContextExportLocation(stateDir: string, expected: unknown, role: unknown): Readonly<RunContextExportLocationReading> {
  const refused = (reason: Extract<RunContextExportLocationReading, { state: "unavailable" }>["reason"]): Readonly<RunContextExportLocationReading> => Object.freeze({ state: "unavailable", reason });
  if (typeof role !== "string" || !Object.hasOwn(EXPORTS, role)) return refused("role_invalid");
  const owner = readRunContextIdentity(stateDir, expected);
  if (owner.state === "unavailable") return owner;
  const relative = runContextExportPath(role as RunContextRole);
  try {
    const directory = lstatSync(join(owner.local_path, "evidence"), { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) return refused("export_unavailable");
    const path = join(owner.local_path, relative);
    const stamp = lstatSync(path, { bigint: true });
    if (!stamp.isFile()) return refused("export_unavailable");
    if (stamp.size < 0n || stamp.size > BigInt(Number.MAX_SAFE_INTEGER)) return refused("export_size_unrepresentable");
    const observed: ExportObservation = { path, stamp, directory };
    const unchanged = (): boolean => {
      try { return owner.unchanged() && exportsUnchanged(owner.local_path, [observed]); }
      catch { return false; }
    };
    if (!unchanged()) return refused("observation_changed");
    return Object.freeze({ state: "available", identity: owner.identity, path: relative, local_path: path,
      bytes_total: Number(stamp.size), mutable: true, unchanged });
  } catch (error) { return refused((error as NodeJS.ErrnoException).code === "ENOENT" ? "export_missing" : "export_unavailable"); }
}

/** Kernel-local metadata, not proof that bodies are redacted/immutable or permission to expose local_path. */
export function readRunContextIndex(stateDir: string, expected: unknown): Readonly<RunContextIndexReading> {
  const request = identity(expected);
  if (!request || !isAbsolute(stateDir)) return unavailable("identity_unavailable");
  try {
    const admission = readContextOwner(stateDir, request);
    if (admission.state === "unavailable") return admission;
    const owner = admission.owner;
    const indexPath = join(owner.root, RUN_CONTEXT_INDEX_FILE);
    const captured = inspectFile(indexPath, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
    if (!captured) return unavailable("index_unavailable");
    const index = decodeIndex(captured.value, request);
    if (!index) return unavailable("index_invalid");
    const admitted: ExportObservation[] = [];
    for (const entry of Object.values(index.entries)) {
      if (entry.availability !== "available") continue;
      const observed = inspectExport(owner.root, entry);
      if (!observed) return unavailable("role_unavailable");
      admitted.push(observed);
    }
    // These rechecks reject observed change, not a multi-file atomic-snapshot or sandbox guarantee.
    if (!ownerUnchanged(owner) || !sameFile(captured.stamp, lstatSync(indexPath, { bigint: true })) ||
      !exportsUnchanged(owner.root, admitted)) return unavailable("observation_changed");
    return Object.freeze({ state: "available", index, identity: Object.freeze({ ...request }), local_path: indexPath });
  } catch { return unavailable("index_unavailable"); }
}

export interface RunContextIndexPublication {
  readonly index: Readonly<RunContextIndex>;
  readonly local_path: string;
}

/** Trusted persistence only: the caller must hold evidence admission and supply authorized export-owner metadata, not actor flags. */
export function writeRunContextIndexUnderLock(
  stateDir: string,
  expected: unknown,
  updates: unknown,
): Readonly<RunContextIndexPublication> {
  const request = identity(expected);
  const changes = object(updates);
  if (!request || !isAbsolute(stateDir) || !changes || !known(changes, Object.keys(EXPORTS))) {
    throw new Error("Run context index publication input is invalid.");
  }
  const admission = readContextOwner(stateDir, request);
  if (admission.state === "unavailable") throw new Error("Run context index owner is unavailable or changed.");
  const owner = admission.owner;
  const path = join(owner.root, RUN_CONTEXT_INDEX_FILE);
  let prior: Readonly<RunContextIndex> | undefined;
  let priorStamp: BigIntStats | undefined;
  try {
    const existing = lstatSync(path, { bigint: true });
    if (!existing.isFile()) throw new Error("Run context index target is unavailable or invalid.");
    const captured = inspectFile(path, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES);
    if (!captured || !(prior = decodeIndex(captured.value, request))) {
      throw new Error("Run context index is unavailable, invalid or belongs to another generation.");
    }
    priorStamp = captured.stamp;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries = Object.fromEntries((Object.keys(EXPORTS) as RunContextRole[]).map(role => [
    role, Object.hasOwn(changes, role) ? changes[role] : prior?.entries[role] ??
      { availability: "unavailable", path: null, reason: "export_not_published" },
  ]));
  const candidate = decodeIndex({ schema: "run-context-index-v1", run: request.run, run_instance_id: request.run_instance_id,
    updated_at: new Date().toISOString(), entries }, request);
  if (!candidate) throw new Error("Run context index role metadata is invalid.");
  const admitted: ExportObservation[] = [];
  const finalEntries = { ...candidate.entries };
  for (const role of Object.keys(EXPORTS) as RunContextRole[]) {
    const entry = candidate.entries[role];
    if (entry.availability !== "available") continue;
    const observed = inspectExport(owner.root, entry);
    if (observed) admitted.push(observed);
    else finalEntries[role] = Object.freeze({ availability: "unavailable", path: null, reason: "export_unavailable" });
  }
  const index = Object.freeze({ ...candidate, entries: Object.freeze(finalEntries) });
  const content = JSON.stringify(index, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_INDEX_METADATA_MAX_BYTES) {
    throw new Error("Run context index exceeds its bounded metadata limit.");
  }
  writeTextAtomic(path, content, { onBeforeReplace() {
    let current: BigIntStats | undefined;
    try { current = lstatSync(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!ownerUnchanged(owner) || !exportsUnchanged(owner.root, admitted) ||
      (priorStamp ? !current || !sameFile(priorStamp, current) : current !== undefined)) {
      throw new Error("Run context index observation changed before publication.");
    }
  } });
  return Object.freeze({ index, local_path: path });
}
