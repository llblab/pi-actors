/**
 * Generation-bound outcome protocol and durable stop-request state.
 * Owns: bounded stop records, process binding, lifecycle-locked stop persistence, canonical result classification and primary/artifact binding data schemas.
 * Excludes: lock acquisition, primary body admission/publication, deadline eligibility, signals, exit proof and delivery.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import { RUN_COMPLETION_MODEL_MAX_BYTES, RUN_DELIVERY_MODEL_MAX_BYTES } from "./limits.ts";
import { runProcessIdentityDigest } from "./runs-process.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export const RUN_PRIMARY_TEXT_PROTOCOL = "run-primary-text-v1";
export const RUN_ARTIFACT_INVENTORY_PROTOCOL = "run-artifact-inventory-v1";
export const RUN_RESULT_DIAGNOSTICS_PROTOCOL = "run-result-diagnostics-v1";
export const RUN_RESULT_DIAGNOSTIC_FIELDS = ["command", "error", "failure_reason"] as const;
export type RunResultDiagnosticField = typeof RUN_RESULT_DIAGNOSTIC_FIELDS[number];
export type RunResultDiagnosticCandidate = Readonly<Partial<Record<RunResultDiagnosticField, string>>>;
export const RUN_RESULT_DIAGNOSTIC_EXCERPT_CHARS = 1_000;
export interface RunResultDiagnosticExcerpt {
  readonly text: string;
  readonly bytes_total: number;
  readonly shown_bytes: Readonly<{ start: number; end: number }>;
  readonly chars_total: number;
  readonly chars_shown: number;
  readonly chars_omitted: number;
  readonly truncated: boolean;
}
export type RunResultDiagnosticPacketExcerpt = Readonly<RunResultDiagnosticExcerpt & { field: RunResultDiagnosticField }>;
export interface RunResultDiagnosticsReference {
  readonly source: Readonly<{ path: string; run_instance_id: string; sha256: string }>;
  readonly bytes_total: number;
  readonly fields: readonly RunResultDiagnosticField[];
}
export type RunResultDiagnosticsBinding =
  | { readonly result_diagnostics: Readonly<RunResultDiagnosticsReference> }
  | { readonly result_diagnostics: null; readonly result_diagnostics_unavailable: string };
export interface RunArtifactInventoryReference {
  readonly source: Readonly<{ path: string; run_instance_id: string; sha256: string }>;
  readonly bytes_total: number;
  readonly declarations_total: number;
}
export type RunArtifactInventoryBinding =
  | { readonly artifact_inventory: Readonly<RunArtifactInventoryReference> }
  | { readonly artifact_inventory: null; readonly artifact_inventory_unavailable: string };

export interface RunPrimaryTextOutput {
  readonly text_basis?: "actor_response";
  readonly upstream_truncated?: boolean;
  readonly source: { readonly path: string; readonly run_instance_id: string; readonly sha256: string };
  readonly bytes_total: number;
  readonly shown_bytes: { readonly start: number; readonly end: number };
  readonly chars_total: number;
  readonly chars_shown: number;
  readonly chars_omitted: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}
/** Completion-only admitted source text; this data is not an independent publication or read grant. */
export interface RunCompletionText {
  readonly text: string;
  readonly shown_bytes: Readonly<{ start: number; end: number }>;
}

/** Prefix presentation only; preserve Unicode scalars and never split an admitted CRLF. */
export function projectRunCompletionText(text: string, maxBytes: number): Readonly<RunCompletionText> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > RUN_COMPLETION_MODEL_MAX_BYTES ||
      Buffer.from(text).toString("utf8") !== text) throw new Error("Completion text prefix is invalid.");
  const bytes = Buffer.from(text); let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end < bytes.length && bytes[end - 1] === 13 && bytes[end] === 10) end--;
  return Object.freeze({ text: bytes.subarray(0, end).toString("utf8"), shown_bytes: Object.freeze({ start: 0, end }) });
}

export function decodeRunCompletionText(primary: Readonly<RunPrimaryTextBinding> | undefined, value: unknown): Readonly<RunCompletionText> {
  const data = primaryData(value), range = primaryData(data?.shown_bytes), output = primary?.output;
  if (!data || Object.keys(data).some(key => key !== "text" && key !== "shown_bytes") || !range ||
      Object.keys(range).some(key => key !== "start" && key !== "end") || !output || typeof data.text !== "string" ||
      range.start !== 0 || !Number.isSafeInteger(range.end) || Number(range.end) < 0 ||
      Number(range.end) > Math.min(output.bytes_total, RUN_COMPLETION_MODEL_MAX_BYTES) ||
      Buffer.byteLength(data.text) !== range.end || Buffer.from(data.text).toString("utf8") !== data.text ||
      [...data.text].length > output.chars_total ||
      (range.end === output.bytes_total && (createHash("sha256").update(data.text).digest("hex") !== output.source.sha256 ||
        [...data.text].length !== output.chars_total))) throw new Error("Completion source text is invalid.");
  const end = Math.min(Number(range.end), output.shown_bytes.end), start = output.shown_bytes.start;
  if (end > start && !Buffer.from(data.text).subarray(start, end).equals(Buffer.from(output.preview).subarray(0, end - start))) {
    throw new Error("Completion source text does not match its recorded preview.");
  }
  return Object.freeze({ text: data.text, shown_bytes: Object.freeze({ start: 0, end: Number(range.end) }) });
}

export type RunPrimaryTextBinding =
  | { readonly output: Readonly<RunPrimaryTextOutput> }
  | { readonly output: null; readonly output_unavailable: string };

function primaryData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(field => Object.hasOwn(field, "value"))
    ? Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value])) : undefined;
}

/** Curated JSON-data schema only; neither decoding nor a protocol marker admits a body, producer or work. */
export function decodeRunPrimaryTextBinding(stateDir: string, generation: string, value: unknown): Readonly<RunPrimaryTextBinding> {
  const input = primaryData(value);
  if (input?.output === null && typeof input.output_unavailable === "string" && /^[a-z_]{1,80}$/.exec(input.output_unavailable)?.[0] === input.output_unavailable) {
    return Object.freeze({ output: null, output_unavailable: input.output_unavailable });
  }
  const output = primaryData(input?.output);
  if (!output || typeof output !== "object") throw new Error("Run primary text binding is invalid.");
  const source = primaryData(output.source); const range = primaryData(output.shown_bytes);
  const { preview, bytes_total: bytes, chars_total: total, chars_shown: shown, chars_omitted: omitted } = output;
  if ((output.text_basis !== undefined && output.text_basis !== "actor_response") ||
    (output.text_basis === "actor_response" ? typeof output.upstream_truncated !== "boolean" : output.upstream_truncated !== undefined) ||
    !source || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path ||
    dirname(source.path) !== join(stateDir, "evidence") || /^primary-[a-f0-9]{64}\.txt$/.exec(basename(source.path))?.[0] !== basename(source.path) || source.run_instance_id !== generation ||
    typeof source.sha256 !== "string" || source.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(source.sha256) || !range ||
    ![bytes, total, shown, omitted, range.start, range.end].every(number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0) ||
    Number(range.start) > Number(range.end) || Number(range.end) > Number(bytes) || typeof preview !== "string" || Buffer.byteLength(preview) !== Number(range.end) - Number(range.start) ||
    Buffer.from(preview).toString("utf8") !== preview || [...preview].length !== shown || Number(shown) + Number(omitted) !== total || Number(total) > Number(bytes) || typeof output.redacted !== "boolean" || output.truncated !== (Number(omitted) > 0)) {
    throw new Error("Run primary text binding is invalid.");
  }
  const binding = { output: { ...(output.text_basis === "actor_response" ? { text_basis: "actor_response" as const, upstream_truncated: output.upstream_truncated as boolean } : {}),
    source: Object.freeze({ path: source.path, run_instance_id: generation, sha256: source.sha256 }),
    bytes_total: Number(bytes), shown_bytes: Object.freeze({ start: Number(range.start), end: Number(range.end) }), chars_total: Number(total), chars_shown: Number(shown), chars_omitted: Number(omitted),
    preview, truncated: output.truncated, redacted: output.redacted } };
  if (Buffer.byteLength(JSON.stringify(binding)) > RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Run primary text binding is too large.");
  return Object.freeze({ output: Object.freeze(binding.output) });
}

/** Inspect completion shape without invoking getters/custom thenables; this grants no source authority. */
function synchronousBindingData(value: unknown, label: string): Record<string, unknown> | undefined {
  for (let target = value && typeof value === "object" ? value : null; target; target = Object.getPrototypeOf(target)) {
    const then = Object.getOwnPropertyDescriptor(target, "then");
    if (then && (!Object.hasOwn(then, "value") || typeof then.value === "function")) throw new Error(`${label} binding must complete synchronously.`);
  }
  const input = primaryData(value);
  if (input && Object.hasOwn(input, "then")) throw new Error(`${label} binding must complete synchronously.`);
  return input;
}

/** Data schema only; copied actor fields/markers cannot publish or authorize inventory/body reads. */
export function decodeRunArtifactInventoryBinding(stateDir: string, generation: string, value: unknown): Readonly<RunArtifactInventoryBinding> {
  const input = synchronousBindingData(value, "Run artifact inventory");
  if (input?.artifact_inventory === null && typeof input.artifact_inventory_unavailable === "string" &&
    /^[a-z_]{1,80}$/u.exec(input.artifact_inventory_unavailable)?.[0] === input.artifact_inventory_unavailable) {
    return Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: input.artifact_inventory_unavailable });
  }
  const inventory = primaryData(input?.artifact_inventory); const source = primaryData(inventory?.source);
  if (!inventory || !source || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path ||
    dirname(source.path) !== join(stateDir, "evidence") || /^artifact-inventory-[a-f0-9]{64}\.json$/u.exec(basename(source.path))?.[0] !== basename(source.path) ||
    source.run_instance_id !== generation || typeof source.sha256 !== "string" || source.sha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    typeof inventory.bytes_total !== "number" || !Number.isSafeInteger(inventory.bytes_total) || inventory.bytes_total <= 0 ||
    typeof inventory.declarations_total !== "number" || !Number.isSafeInteger(inventory.declarations_total) || inventory.declarations_total <= 0 || inventory.declarations_total > inventory.bytes_total) {
    throw new Error("Run artifact inventory binding is invalid.");
  }
  const binding = Object.freeze({ artifact_inventory: Object.freeze({ source: Object.freeze({ path: source.path, run_instance_id: generation, sha256: source.sha256 }),
    bytes_total: inventory.bytes_total, declarations_total: inventory.declarations_total }) });
  if (Buffer.byteLength(JSON.stringify(binding)) > RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Run artifact inventory binding is too large.");
  return binding;
}

/** Curated diagnostic reference data only, never candidate/producer/publication/body permission. */
export function decodeRunResultDiagnosticsBinding(stateDir: string, generation: string, value: unknown): Readonly<RunResultDiagnosticsBinding> {
  const input = synchronousBindingData(value, "Run result diagnostics");
  if (input?.result_diagnostics === null && typeof input.result_diagnostics_unavailable === "string" &&
    /^[a-z_]{1,80}$/u.exec(input.result_diagnostics_unavailable)?.[0] === input.result_diagnostics_unavailable) {
    return Object.freeze({ result_diagnostics: null, result_diagnostics_unavailable: input.result_diagnostics_unavailable });
  }
  const reference = primaryData(input?.result_diagnostics); const source = primaryData(reference?.source);
  const list = Array.isArray(reference?.fields) ? Object.getOwnPropertyDescriptors(reference.fields as object) : undefined;
  const fields = list && Object.values(list).every(field => Object.hasOwn(field, "value")) &&
    Number.isSafeInteger(list.length?.value) && list.length!.value > 0 && list.length!.value <= RUN_RESULT_DIAGNOSTIC_FIELDS.length
    ? Array.from({ length: list.length!.value as number }, (_, index) => list[String(index)]?.value) : undefined;
  if (!reference || !source || typeof source.path !== "string" || !isAbsolute(source.path) || resolve(source.path) !== source.path ||
    dirname(source.path) !== join(stateDir, "evidence") || /^result-diagnostics-[a-f0-9]{64}\.json$/u.exec(basename(source.path))?.[0] !== basename(source.path) ||
    source.run_instance_id !== generation || typeof source.sha256 !== "string" || source.sha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    typeof reference.bytes_total !== "number" || !Number.isSafeInteger(reference.bytes_total) || reference.bytes_total <= 0 || !fields ||
    fields.some((field, index) => !RUN_RESULT_DIAGNOSTIC_FIELDS.includes(field as RunResultDiagnosticField) || fields.indexOf(field) !== index) ||
    JSON.stringify(fields) !== JSON.stringify(RUN_RESULT_DIAGNOSTIC_FIELDS.filter(field => fields.includes(field)))) throw new Error("Run result diagnostics binding is invalid.");
  const binding = Object.freeze({ result_diagnostics: Object.freeze({ source: Object.freeze({ path: source.path, run_instance_id: generation, sha256: source.sha256 }),
    bytes_total: reference.bytes_total, fields: Object.freeze(fields as RunResultDiagnosticField[]) }) });
  if (Buffer.byteLength(JSON.stringify(binding)) > RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Run result diagnostics binding is too large.");
  return binding;
}

/** Frozen literal prefix metadata only; a valid excerpt/reference DTO does not authorize source publication. */
export function decodeRunResultDiagnosticExcerpt(reference: Readonly<RunResultDiagnosticsReference>, value: unknown): RunResultDiagnosticPacketExcerpt {
  const input = primaryData(value); const range = primaryData(input?.shown_bytes);
  if (!input || !range || !reference.fields.includes(input.field as RunResultDiagnosticField) || typeof input.text !== "string" ||
    Buffer.from(input.text, "utf8").toString("utf8") !== input.text || ![input.bytes_total, input.chars_total, input.chars_shown, input.chars_omitted, range.start, range.end]
      .every(number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0) ||
    range.start !== 0 || Number(range.end) > Number(input.bytes_total) || Buffer.byteLength(input.text) !== range.end ||
    Array.from(input.text).length !== input.chars_shown || Number(input.chars_shown) > RUN_RESULT_DIAGNOSTIC_EXCERPT_CHARS ||
    Number(input.chars_shown) + Number(input.chars_omitted) !== input.chars_total || Number(input.chars_total) > Number(input.bytes_total) ||
    input.truncated !== (Number(input.chars_omitted) > 0)) throw new Error("Run result diagnostic excerpt is invalid.");
  const excerpt = Object.freeze({ field: input.field as RunResultDiagnosticField, text: input.text, bytes_total: Number(input.bytes_total),
    shown_bytes: Object.freeze({ start: 0, end: Number(range.end) }), chars_total: Number(input.chars_total), chars_shown: Number(input.chars_shown),
    chars_omitted: Number(input.chars_omitted), truncated: input.truncated as boolean });
  if (Buffer.byteLength(JSON.stringify(excerpt)) > RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Run result diagnostic excerpt is too large.");
  return excerpt;
}

export const RUN_OUTCOME_PROTOCOL = "run-outcome-v1" as const;
export const RUN_STOP_CLAIM_FILE = "stop-claim.json";
const MAX_STOP_CLAIM_BYTES = 16_384;

export type RunStopReason = "manual_kill" | "max_runtime";

export interface RunStopClaim {
  version: 1;
  claim_id: string;
  run: string;
  run_instance_id: string;
  ownerId?: string;
  pid: number;
  process_identity_digest: string;
  reason: RunStopReason;
  requested_at: string;
}

export type RunStopClaimReading =
  | { state: "absent" | "stale" | "invalid" }
  | { state: "pending"; claim: Readonly<RunStopClaim> };


function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && new Date(time).toISOString() === value;
}

function decodeStopClaim(value: unknown): RunStopClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 ||
    typeof record.claim_id !== "string" || !/^[0-9a-f-]{36}$/.test(record.claim_id) ||
    typeof record.run !== "string" || !record.run ||
    typeof record.run_instance_id !== "string" || !record.run_instance_id ||
    (record.ownerId !== undefined && (typeof record.ownerId !== "string" || !record.ownerId)) ||
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
    typeof record.process_identity_digest !== "string" || !/^[0-9a-f]{64}$/.test(record.process_identity_digest) ||
    (record.reason !== "manual_kill" && record.reason !== "max_runtime") ||
    !isCanonicalTimestamp(record.requested_at)) return undefined;
  return {
    version: 1,
    claim_id: record.claim_id,
    run: record.run,
    run_instance_id: record.run_instance_id,
    ...(typeof record.ownerId === "string" ? { ownerId: record.ownerId } : {}),
    pid: Number(record.pid),
    process_identity_digest: record.process_identity_digest,
    reason: record.reason,
    requested_at: record.requested_at,
  };
}

export function readRunStopClaim(
  stateDir: string,
  meta: Record<string, unknown>,
): RunStopClaimReading {
  const path = join(stateDir, RUN_STOP_CLAIM_FILE);
  try {
    if (!lstatSync(path).isFile()) return { state: "invalid" };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid" };
  }
  const read = readJsonFileResilient<unknown>(path, undefined, { maxBytes: MAX_STOP_CLAIM_BYTES });
  if (read.diagnostics.length) return { state: "invalid" };
  if (read.value && typeof read.value === "object" && !Array.isArray(read.value)) {
    const generation = (read.value as Record<string, unknown>).run_instance_id;
    if (typeof generation === "string" && generation && typeof meta.run_instance_id === "string" &&
      generation !== meta.run_instance_id) return { state: "stale" };
  }
  const claim = decodeStopClaim(read.value);
  if (!claim || meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL ||
    claim.run !== meta.run || claim.run_instance_id !== meta.run_instance_id ||
    claim.ownerId !== meta.ownerId || claim.pid !== meta.pid ||
    claim.process_identity_digest !== runProcessIdentityDigest(meta.process_identity)) {
    return { state: "invalid" };
  }
  return { state: "pending", claim: Object.freeze(claim) };
}

/** Only the control owner may call this after admission under the canonical lifecycle lock. */
export function writeRunStopClaimUnderLock(
  stateDir: string,
  meta: Record<string, unknown>,
  reason: RunStopReason,
): Readonly<RunStopClaim> {
  if (readRunStopClaim(stateDir, meta).state !== "absent") {
    throw new Error("Run stop claim cannot replace existing evidence.");
  }
  const claim = {
    version: 1,
    claim_id: randomUUID(),
    run: meta.run,
    run_instance_id: meta.run_instance_id,
    ...(meta.ownerId !== undefined ? { ownerId: meta.ownerId } : {}),
    pid: meta.pid,
    process_identity_digest: runProcessIdentityDigest(meta.process_identity),
    reason,
    requested_at: new Date().toISOString(),
  };
  const decoded = decodeStopClaim(claim);
  if (!decoded || meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL ||
    Buffer.byteLength(JSON.stringify(claim, null, 2), "utf8") > MAX_STOP_CLAIM_BYTES) {
    throw new Error("Run stop claim identity is unavailable or invalid.");
  }
  writeJsonAtomic(join(stateDir, RUN_STOP_CLAIM_FILE), decoded);
  return Object.freeze(decoded);
}

/** Capture markers never imply terminal acceptance, even when their claim is unavailable. */
export function isRunStopResultCapture(result: Record<string, unknown> | undefined): boolean {
  return result?.terminal_acceptance === "after_stop_claim" || result?.stop_claim_id !== undefined;
}

export type RunNaturalOutcomeReading =
  | { state: "absent" | "invalid" | "captured" }
  | { state: "accepted"; status: "done" | "failed" };

export interface RunNaturalOutcomeSnapshot {
  readonly result: Record<string, unknown> | undefined;
  readonly outcome: RunNaturalOutcomeReading;
}

function classifyNaturalOutcome(result: Record<string, unknown>, meta: Record<string, unknown>): RunNaturalOutcomeReading {
  if (typeof meta.run_instance_id !== "string" || !meta.run_instance_id || !Object.hasOwn(result, "code") ||
    result.run_instance_id !== meta.run_instance_id || !Number.isSafeInteger(result.code) ||
    !isCanonicalTimestamp(result.completedAt)) return { state: "invalid" };
  if (result.terminal_acceptance === "after_stop_claim" && typeof result.stop_claim_id === "string") {
    return { state: "captured" };
  }
  if (result.terminal_acceptance !== "natural" || Object.hasOwn(result, "stop_claim_id")) {
    return { state: "invalid" };
  }
  return { state: "accepted", status: result.code === 0 ? "done" : "failed" };
}

function readResultJson(path: string): unknown {
  const read = readJsonFileResilient<unknown>(path, undefined);
  return read.diagnostics.length ? undefined : read.value;
}

/** Read one regular-file result snapshot for both precedence and rendering; data never grants work/stop authority. */
export function readRunNaturalOutcomeSnapshot(
  stateDir: string,
  meta: Record<string, unknown>,
  readResult: (path: string) => unknown = readResultJson,
): Readonly<RunNaturalOutcomeSnapshot> {
  const path = join(stateDir, "result.json");
  try {
    if (!lstatSync(path).isFile()) return Object.freeze<RunNaturalOutcomeSnapshot>({ result: undefined, outcome: { state: "invalid" } });
  } catch (error) {
    return Object.freeze<RunNaturalOutcomeSnapshot>({ result: undefined,
      outcome: { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid" } });
  }
  const value = readResult(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze<RunNaturalOutcomeSnapshot>({ result: undefined, outcome: { state: "invalid" } });
  }
  const result = value as Record<string, unknown>;
  return Object.freeze({ result, outcome: classifyNaturalOutcome(result, meta) });
}

/** Result bodies remain in their existing canonical file; this is admission, not a second store. */
export function readRunNaturalOutcome(
  stateDir: string,
  meta: Record<string, unknown>,
): RunNaturalOutcomeReading {
  return readRunNaturalOutcomeSnapshot(stateDir, meta).outcome;
}
