/**
 * Run retirement owner.
 * Owns: lifecycle-serialized manual archive/prune, age-based cleanup and shared ownership/scope fences.
 * Excludes: native closure proof, process actuation and ordinary non-Run temp cleanup.
 */

import { createHash, randomUUID } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { acquireFileMutationLock, writeJsonAtomic, writeTextAtomic } from "./file-state.ts";
import * as Limits from "./limits.ts";
import { readJsonFileResilient, readJsonlFileResilient } from "./state-readers.ts";
import { readRunContextIdentity, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "./runs-context-index.ts";
import { readProcessLiveness } from "./runs-process.ts";
import { acquireStateStartLock, assertNoActiveRunState } from "./runs-start.ts";
import {
  resolveArtifactManifest,
  type RunArtifactDeclaration,
} from "./runs-artifacts.ts";
import { assertNoRetainedDescendantLaunchScope } from "./runs-descendant-launches.ts";
import { safeRunId } from "./runs-identity.ts";
import { assertNoRetainedNativeLaunchScope } from "./runs-native-launches.ts";
import { assertOwnedRunStateDirectory } from "./runs-ownership.ts";

export type RunRetentionAction = "archive" | "prune";
export type RunRetentionOutcome = "queued" | "handled" | "failed";

export const DEFAULT_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIREMENT_FAILURE_MESSAGE = "Run retirement failed; effects may already exist.";

export interface RunRetentionExpectation {
  onLocked?(): void;
  ownerId?: string;
  runInstanceId?: string;
}

function assertRetirableDirectory(status: Record<string, unknown>): void {
  const stateDir = String(status.state_dir);
  assertOwnedRunStateDirectory(stateDir, String(status.run ?? basename(stateDir)));
  assertNoRetainedDescendantLaunchScope(stateDir);
  assertNoRetainedNativeLaunchScope(stateDir);
}

/** Manual API preserves its existing status/expected contract, not a native closure claim. */
export function retainRun(
  stateDir: string,
  action: RunRetentionAction,
  expected: RunRetentionExpectation,
  readStatus: (stateDir: string) => Record<string, unknown>,
  options: { preserveArtifacts?: boolean } = {},
): Record<string, unknown> {
  const release = acquireStateStartLock(stateDir);
  let status: Record<string, unknown> | undefined;
  let evidenceId: string | undefined;
  const failures: unknown[] = [];
  try {
    expected.onLocked?.();
    status = readStatus(stateDir);
    if (expected.ownerId !== undefined && status.ownerId !== expected.ownerId) {
      return { [`${action}d`]: false, reason: "ownership changed", status };
    }
    if (expected.runInstanceId !== undefined && status.run_instance_id !== expected.runInstanceId) {
      return { [`${action}d`]: false, reason: "run generation changed", status };
    }
    if (status.status === "running") throw new Error("Only terminal runs can be archived or pruned.");
    if (resolve(String(status.state_dir)) !== resolve(stateDir)) throw new Error("Run retirement state directory changed.");
    evidenceId = appendRunRetentionEvidence(status, action, "queued");
    const result = action === "archive" ? archiveTerminalRun(status) : pruneTerminalRun(status, options);
    appendRunRetentionEvidence(status, action, "handled", { id: evidenceId, result });
    return { ...result, retention_id: evidenceId };
  } catch (error) {
    failures.push(error);
    if (status && evidenceId) {
      let text: string;
      try { text = String(error instanceof Error ? error.message : error); }
      catch (formattingError) { text = "failure text unavailable"; failures.push(formattingError); }
      try { appendRunRetentionEvidence(status, action, "failed", { error: text, id: evidenceId }); }
      catch (recordingError) { failures.push(recordingError); }
    }
  } finally {
    try { release(); }
    catch (releaseError) {
      if (failures.length) throw new AggregateError([...failures, releaseError], RETIREMENT_FAILURE_MESSAGE, { cause: failures[0] });
      throw releaseError;
    }
  }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, RETIREMENT_FAILURE_MESSAGE, { cause: failures[0] });
}

/** Filesystem age selects candidates; it grants neither retirement nor native scope authority. */
export async function cleanupStaleRunEntries(
  runsDir: string,
  maxAgeMs = DEFAULT_RUN_MAX_AGE_MS,
  now = Date.now(),
): Promise<number> {
  let entries;
  const root = resolve(runsDir);
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return 0; }
  let removed = 0;
  const readJson = (path: string) => {
    const reading = readJsonFileResilient<Record<string, unknown> | undefined>(path, undefined,
      { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
    if (reading.diagnostics.length) throw new Error("Run retirement metadata is unavailable.");
    return reading.value;
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stateDir = join(root, entry.name);
    try {
      const selected = lstatSync(stateDir);
      if (now - Math.min(selected.birthtimeMs || selected.mtimeMs, selected.mtimeMs) <= maxAgeMs) continue;
      const candidate = readRunContextIdentity(stateDir, readJson(join(stateDir, "run.json")));
      if (candidate.state !== "available") continue;
      const release = acquireStateStartLock(stateDir);
      try {
        if (!candidate.unchanged()) continue;
        const current = lstatSync(stateDir);
        if (now - Math.min(current.birthtimeMs || current.mtimeMs, current.mtimeMs) <= maxAgeMs) continue;
        const meta = readJson(join(stateDir, "run.json"));
        if (!meta || typeof meta.pid !== "number" || !candidate.unchanged()) continue;
        assertNoActiveRunState(stateDir, readJson, "");
        if (readProcessLiveness(meta.pid) !== "dead" || !candidate.unchanged()) continue;
        pruneTerminalRun(meta);
        removed++;
      } finally { release(); }
    } catch {
      // Best-effort startup cleanup retains unavailable, replaced or still-fenced candidates.
    }
  }
  return removed;
}

export function appendRunRetentionEvidence(
  status: Record<string, unknown>,
  action: RunRetentionAction,
  outcome: RunRetentionOutcome,
  options: { error?: string; id?: string; result?: Record<string, unknown> } = {},
): string {
  const stateDir = String(status.state_dir);
  const path = join(dirname(stateDir), "retention.jsonl");
  const id = options.id ?? randomUUID();
  const record = {
    action,
    ...(options.error ? { error: options.error } : {}),
    id,
    outcome,
    ...(options.result ? { result: options.result } : {}),
    run: String(status.run ?? basename(stateDir)),
    ...(typeof status.run_instance_id === "string" ? { run_instance_id: status.run_instance_id } : {}),
    ts: new Date().toISOString(),
  };
  const release = acquireFileMutationLock(path);
  let writeFailed = false, writeFailure: unknown;
  try {
    const records = [...readJsonlFileResilient<Record<string, unknown>>(path).records, record]
      .slice(-Limits.RUN_RETENTION_MAX_RECORDS);
    let content = encodeRecords(records);
    while (records.length && Buffer.byteLength(content) > Limits.RUN_RETENTION_MAX_BYTES) {
      records.shift();
      content = encodeRecords(records);
    }
    if (!records.includes(record)) throw new Error("Run retention record exceeds journal byte limit");
    writeTextAtomic(path, content);
  } catch (error) {
    writeFailed = true; writeFailure = error;
    throw error;
  } finally {
    try { release(); }
    catch (releaseError) {
      if (writeFailed) throw new AggregateError([writeFailure, releaseError], "Run retention journal append and release failed", { cause: writeFailure });
      throw releaseError;
    }
  }
  return id;
}

function encodeRecords(records: Record<string, unknown>[]): string {
  return records.length ? `${records.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

function retainedArtifactFilename(name: string, path: string): string {
  const readableName = name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "artifact";
  const identity = createHash("sha256")
    .update(`${name}\0${path}`)
    .digest("hex")
    .slice(0, 8);
  return `${readableName}-${identity}--${basename(path)}`;
}

function archivePathFor(run: string, stateDir: string): string {
  const archiveRoot = join(dirname(stateDir), "archived");
  mkdirSync(archiveRoot, { recursive: true });
  return join(
    archiveRoot,
    `${safeRunId(run)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
}

export function archiveTerminalRun(
  status: Record<string, unknown>,
): Record<string, unknown> {
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? basename(stateDir));
  assertRetirableDirectory(status);
  const archiveDir = archivePathFor(run, stateDir);
  renameSync(stateDir, archiveDir);
  mkdirSync(stateDir, { recursive: true });
  const tombstone = {
    archived: true,
    archive_dir: archiveDir,
    original_state_dir: stateDir,
    run,
    status: status.status,
    ts: new Date().toISOString(),
  };
  writeJsonAtomic(join(stateDir, "archive-tombstone.json"), tombstone);
  return tombstone;
}

export function pruneTerminalRun(
  status: Record<string, unknown>,
  options: { preserveArtifacts?: boolean } = {},
  deps: { copyArtifact?: typeof cpSync } = {},
): Record<string, unknown> {
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? basename(stateDir));
  assertRetirableDirectory(status);
  const manifest = options.preserveArtifacts ? resolveArtifactManifest(
    status.artifacts as Record<string, RunArtifactDeclaration> | undefined,
  ) : undefined;
  const preserved: Record<string, string> = {};
  if (options.preserveArtifacts && manifest) {
    const preserveRoot = join(
      dirname(stateDir),
      "preserved-artifacts",
      safeRunId(run),
    );
    mkdirSync(preserveRoot, { recursive: true });
    for (const [name, artifact] of Object.entries(manifest)) {
      if (!artifact.exists) continue;
      const target = join(
        preserveRoot,
        retainedArtifactFilename(name, artifact.path),
      );
      (deps.copyArtifact ?? cpSync)(artifact.path, target, {
        force: true,
        preserveTimestamps: true,
      });
      preserved[name] = target;
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  return {
    pruned: true,
    preserved_artifacts: preserved,
    run,
    state_dir: stateDir,
    ts: new Date().toISOString(),
  };
}
