/**
 * Run Control request contract.
 * Zones: public request validation, Run/runtime target normalization, input bounds
 * Owns pure Control validation; journaling, delivery, and lifecycle mutation stay in adapters.
 */

import * as Limits from "./limits.ts";

export interface ControlRequest {
  target: `run:${string}` | "runtime";
  action: string;
  input?: unknown;
  verbose?: boolean;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
const CONTROL_FIELDS = new Set(["action", "input", "target", "verbose"]);
const REMOVED_FIELDS = new Set([
  "body",
  "correlation_id",
  "from",
  "metadata",
  "reply_to",
  "summary",
  "to",
  "type",
]);

function serializedInputBytes(input: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("control.input must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new Error("control.input must be JSON-serializable");
  }
  return Buffer.byteLength(serialized);
}

function normalizeTarget(value: unknown): ControlRequest["target"] {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("control.target is required");
  }
  const target = value.trim();
  if (target === "runtime") return target;
  if (!target.startsWith("run:")) {
    throw new Error(
      `unsupported control target: ${target}; use run:<id> or runtime`,
    );
  }
  const run = target.slice(4);
  if (!RUN_ID_PATTERN.test(run)) {
    throw new Error(`invalid control Run target: ${target}`);
  }
  return `run:${run}`;
}

export function normalizeControlRequest(input: unknown): ControlRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("control request must be an object");
  }
  const record = input as Record<string, unknown>;
  const fields = Object.keys(record);
  const removed = fields.filter((field) => REMOVED_FIELDS.has(field));
  if (removed.length > 0) {
    throw new Error(
      `actor-message fields are removed: ${removed.sort().join(", ")}; use target, action, input, verbose`,
    );
  }
  const unknown = fields.filter((field) => !CONTROL_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new Error(`unsupported control fields: ${unknown.sort().join(", ")}`);
  }
  const target = normalizeTarget(record.target);
  if (typeof record.action !== "string" || !record.action.trim()) {
    throw new Error("control.action is required");
  }
  const action = record.action.trim();
  if (!ACTION_PATTERN.test(action)) {
    throw new Error(`invalid control action: ${action}`);
  }
  if (record.verbose !== undefined && typeof record.verbose !== "boolean") {
    throw new Error("control.verbose must be a boolean");
  }
  if (
    record.input !== undefined &&
    serializedInputBytes(record.input) > Limits.CONTROL_INPUT_MAX_BYTES
  ) {
    throw new Error(
      `control.input exceeds ${Limits.CONTROL_INPUT_MAX_BYTES} bytes`,
    );
  }
  return {
    target,
    action,
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(record.verbose !== undefined ? { verbose: record.verbose } : {}),
  };
}
