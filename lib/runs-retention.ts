/**
 * Async run retention operations.
 * Owns: terminal-run archive and prune filesystem behavior.
 */

import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { acquireFileMutationLock, writeJsonAtomic, writeTextAtomic } from "./file-state.ts";
import * as Limits from "./limits.ts";
import { readJsonlFileResilient } from "./state-readers.ts";
import {
  resolveArtifactManifest,
  type RunArtifactDeclaration,
} from "./runs-artifacts.ts";
import { safeRunId } from "./runs-identity.ts";
import { assertOwnedRunStateDirectory } from "./runs-ownership.ts";

export type RunRetentionAction = "archive" | "prune";
export type RunRetentionOutcome = "queued" | "handled" | "failed";

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
  } finally { release(); }
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
  assertOwnedRunStateDirectory(stateDir, run);
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
  assertOwnedRunStateDirectory(stateDir, run);
  const manifest = resolveArtifactManifest(
    status.artifacts as Record<string, RunArtifactDeclaration> | undefined,
  );
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
