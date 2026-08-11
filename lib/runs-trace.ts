/**
 * Run Trace event journal.
 * Zones: structured event validation, bounded append, resilient bounded reads
 * Owns Run-local semantic Trace events; lifecycle projection and owner attention delivery stay in adapters.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Limits from "./limits.ts";
import { readJsonlFileResilient } from "./state-readers.ts";

export interface TraceEvent {
  id: string;
  ts: string;
  kind: string;
  summary?: string;
  data?: unknown;
  level?: "info" | "warning" | "error";
  attention?: "notify" | "followup";
}

export interface AppendTraceEventInput {
  kind: string;
  summary?: string;
  data?: unknown;
  level?: TraceEvent["level"];
  attention?: TraceEvent["attention"];
}

const KIND_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
const TRACE_INPUT_FIELDS = new Set([
  "attention",
  "data",
  "kind",
  "level",
  "summary",
]);
const FORBIDDEN_FIELDS = new Set([
  "body",
  "correlation_id",
  "from",
  "metadata",
  "reply_to",
  "to",
  "type",
]);

export function runTraceFile(stateDir: string): string {
  return join(stateDir, "trace.jsonl");
}

function normalizeTraceEventInput(input: unknown): AppendTraceEventInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Trace event must be an object");
  }
  const record = input as Record<string, unknown>;
  const forbidden = Object.keys(record).filter((key) => FORBIDDEN_FIELDS.has(key));
  if (forbidden.length > 0) {
    throw new Error(`Trace event fields are removed: ${forbidden.sort().join(", ")}`);
  }
  const unknown = Object.keys(record).filter((key) => !TRACE_INPUT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unsupported Trace event fields: ${unknown.sort().join(", ")}`);
  }
  if (typeof record.kind !== "string" || !KIND_PATTERN.test(record.kind)) {
    throw new Error("Trace event kind must be a lowercase semantic token");
  }
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new Error("Trace event summary must be a string");
  }
  if (
    record.level !== undefined &&
    record.level !== "info" &&
    record.level !== "warning" &&
    record.level !== "error"
  ) {
    throw new Error("Trace event level must be info, warning, or error");
  }
  if (
    record.attention !== undefined &&
    record.attention !== "notify" &&
    record.attention !== "followup"
  ) {
    throw new Error("Trace event attention must be notify or followup");
  }
  return {
    kind: record.kind,
    ...(record.summary !== undefined
      ? { summary: record.summary.slice(0, 1_000) }
      : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
    ...(record.level !== undefined
      ? { level: record.level as TraceEvent["level"] }
      : {}),
    ...(record.attention !== undefined
      ? { attention: record.attention as TraceEvent["attention"] }
      : {}),
  };
}

export function appendRunTraceEvent(
  stateDir: string,
  input: AppendTraceEventInput,
): TraceEvent {
  const normalized = normalizeTraceEventInput(input);
  const event: TraceEvent = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...normalized,
  };
  let encoded: string;
  try {
    encoded = JSON.stringify(event);
  } catch {
    throw new Error("Trace event data must be JSON-serializable");
  }
  if (Buffer.byteLength(encoded) > Limits.TRACE_EVENT_MAX_BYTES) {
    throw new Error(`Trace event exceeds ${Limits.TRACE_EVENT_MAX_BYTES} bytes`);
  }
  writeFileSync(runTraceFile(stateDir), `${encoded}\n`, { flag: "a" });
  return event;
}

export function readRunTraceEvents(
  stateDir: string,
  limit = Limits.TRACE_EVENT_MAX_READ,
): TraceEvent[] {
  const records = readJsonlFileResilient<TraceEvent>(runTraceFile(stateDir)).records;
  return records.slice(-Math.max(1, Math.min(limit, Limits.TRACE_EVENT_MAX_READ)));
}
