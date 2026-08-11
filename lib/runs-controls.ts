/**
 * Run Control journal.
 * Zones: durable Control records, claim locks, status transitions, bounded compaction
 * Owns Run-local Control persistence; owner/generation authorization and transport delivery stay in lifecycle adapters.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireFileMutationLock, writeTextAtomic } from "./file-state.ts";
import { readJsonlFileResilient } from "./state-readers.ts";
export const RUN_CONTROL_TERMINAL_LIMIT = 128;

export type RunControlStatus =
  | "queued"
  | "delivered"
  | "claimed"
  | "handled"
  | "failed";

export interface RunControlRecord {
  id: string;
  run_instance_id: string;
  action: string;
  input?: unknown;
  status: RunControlStatus;
  queued_at: string;
  delivered_at?: string;
  claimed_at?: string;
  handled_at?: string;
  failed_at?: string;
  error?: string;
}

export interface ProcessRunControlsResult {
  claimed: number;
  failed: number;
  handled: number;
}

const TERMINAL_STATUSES = new Set<RunControlStatus>(["handled", "failed"]);

export function runControlsFile(stateDir: string): string {
  return join(stateDir, "controls.jsonl");
}

export function readRunControlsFromStateDir(stateDir: string): RunControlRecord[] {
  return readJsonlFileResilient<RunControlRecord>(runControlsFile(stateDir))
    .records;
}

function acquireRunControlsLock(stateDir: string): () => void {
  return acquireFileMutationLock(runControlsFile(stateDir));
}

function compactRunControls(records: RunControlRecord[]): RunControlRecord[] {
  const active = records.filter((record) => !TERMINAL_STATUSES.has(record.status));
  const terminal = records
    .filter((record) => TERMINAL_STATUSES.has(record.status))
    .slice(-RUN_CONTROL_TERMINAL_LIMIT);
  const retained = new Set([...active, ...terminal]);
  return records.filter((record) => retained.has(record));
}

function writeRunControls(stateDir: string, records: RunControlRecord[]): void {
  const compacted = compactRunControls(records);
  writeTextAtomic(
    runControlsFile(stateDir),
    compacted.length
      ? `${compacted.map((record) => JSON.stringify(record)).join("\n")}\n`
      : "",
  );
}

export function appendRunControlInStateDir(
  stateDir: string,
  request: { run_instance_id: string; action: string; input?: unknown },
): RunControlRecord {
  const record: RunControlRecord = {
    id: randomUUID(),
    run_instance_id: request.run_instance_id,
    action: request.action,
    ...(request.input !== undefined ? { input: request.input } : {}),
    status: "queued",
    queued_at: new Date().toISOString(),
  };
  const releaseLock = acquireRunControlsLock(stateDir);
  try {
    writeFileSync(runControlsFile(stateDir), `${JSON.stringify(record)}\n`, {
      flag: "a",
    });
  } finally {
    releaseLock();
  }
  return record;
}

export function updateRunControlStatusInStateDir(
  stateDir: string,
  id: string,
  nextStatus: RunControlStatus,
  metadata: Pick<RunControlRecord, "error"> = {},
  expectedStatuses?: readonly RunControlStatus[],
): boolean {
  const releaseLock = acquireRunControlsLock(stateDir);
  try {
    const records = readRunControlsFromStateDir(stateDir);
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    const record = records[index]!;
    if (expectedStatuses && !expectedStatuses.includes(record.status)) return false;
    if (record.status === nextStatus) return false;
    const timestamp = new Date().toISOString();
    if (nextStatus === "delivered") {
      if (record.delivered_at) return false;
      records[index] = {
        ...record,
        delivered_at: timestamp,
        ...(record.status === "queued" ? { status: "delivered" as const } : {}),
      };
    } else {
      if (TERMINAL_STATUSES.has(record.status) || nextStatus === "queued") return false;
      if (
        (nextStatus === "claimed" &&
          record.status !== "queued" &&
          record.status !== "delivered") ||
        (nextStatus === "handled" && record.status !== "claimed")
      ) {
        return false;
      }
      const timestampKey = `${nextStatus}_at` as const;
      records[index] = {
        ...record,
        ...metadata,
        [timestampKey]: timestamp,
        status: nextStatus,
      };
    }
    writeRunControls(stateDir, records);
    return true;
  } finally {
    releaseLock();
  }
}

export function claimRunControlInStateDir(
  stateDir: string,
  runInstanceId: string,
): RunControlRecord | undefined {
  const releaseLock = acquireRunControlsLock(stateDir);
  try {
    const records = readRunControlsFromStateDir(stateDir);
    const index = records.findIndex(
      (record) =>
        record.run_instance_id === runInstanceId &&
        (record.status === "queued" || record.status === "delivered"),
    );
    if (index < 0) return undefined;
    const claimed: RunControlRecord = {
      ...records[index]!,
      claimed_at: new Date().toISOString(),
      status: "claimed",
    };
    records[index] = claimed;
    writeRunControls(stateDir, records);
    return claimed;
  } finally {
    releaseLock();
  }
}

export async function processRunControlsInStateDir(
  stateDir: string,
  runInstanceId: string,
  handler: (control: RunControlRecord) => Promise<void> | void,
  limit = 1,
): Promise<ProcessRunControlsResult> {
  const result: ProcessRunControlsResult = { claimed: 0, failed: 0, handled: 0 };
  for (let index = 0; index < Math.max(1, limit); index += 1) {
    const control = claimRunControlInStateDir(stateDir, runInstanceId);
    if (!control) break;
    result.claimed += 1;
    try {
      await handler(control);
      if (updateRunControlStatusInStateDir(stateDir, control.id, "handled", {}, ["claimed"])) {
        result.handled += 1;
      }
    } catch (error) {
      if (
        updateRunControlStatusInStateDir(
          stateDir,
          control.id,
          "failed",
          { error: error instanceof Error ? error.message : String(error) },
          ["claimed"],
        )
      ) {
        result.failed += 1;
      }
    }
  }
  return result;
}
