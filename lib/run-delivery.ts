/**
 * Coordinator delivery persistence.
 * Zones: owner-scoped completion streams/batches, delivery phase fencing, bounded receipts
 * Owns atomic stream allocations, immutable member snapshots and bounded projections; excludes logical-session admission, Run discovery, primary authorization and Pi scheduling.
 */

import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { parseDocument } from "yaml";
import { renderYamlMetadata } from "./tools-response.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { withFileMutationLock, writeTextAtomic } from "./file-state.ts";
import * as Limits from "./limits.ts";
import { decodeRunDirectoryNavigation, type RunDirectoryNavigation } from "./runs-index.ts";
import { formatInspectNextAction, formatLiteralBlock, formatMarkdownField, formatRunFileNavigationHandoff } from "./tools-response.ts";
import { decodeRunCompletionText, projectRunCompletionText, type RunCompletionText, decodeRunPrimaryTextBinding, decodeRunArtifactInventoryBinding, decodeRunResultDiagnosticsBinding, decodeRunResultDiagnosticExcerpt, type RunResultDiagnosticsReference, type RunResultDiagnosticPacketExcerpt, type RunPrimaryTextBinding, type RunArtifactInventoryReference } from "./runs-outcomes.ts";

export type RunCompletionDeliveryStatus = "done" | "failed" | "killed" | "exited";
export type RunDeliveryPhase = "pending" | "queued" | "presented";

export type RunCompletionIndexRange =
  | Readonly<{ state: "available"; indices: readonly number[]; next_index: number }>
  | Readonly<{ state: "unavailable"; reason: "range_unavailable"; next_index: number }>;

export type RunCompletionNumbering =
  | Readonly<{ kind: "stream"; session_id: string; stream_id: string; first_index: number; member_order: readonly number[] }>
  | Readonly<{ kind: "unavailable"; session_id: string; stream_id?: string;
      reason: "counter_unavailable" | "range_unavailable" | "stream_state_unavailable"; member_order: readonly number[] }>;

export interface RunCompletionBatchMember {
  artifacts?: Record<string, string>;
  artifact_inventory?: Readonly<RunArtifactInventoryReference> | null;
  artifact_inventory_unavailable?: string;
  result_diagnostics?: Readonly<RunResultDiagnosticsReference> | null;
  result_diagnostics_unavailable?: string;
  diagnostic_excerpt?: RunResultDiagnosticPacketExcerpt;
  parent_run?: string;
  parent_run_instance_id?: string;
  parent_state_dir?: string;
  output?: string;
  primary_text?: Readonly<RunPrimaryTextBinding>;
  completion_text?: Readonly<RunCompletionText>;
  run: string;
  run_instance_id: string;
  state_dir: string;
  status: RunCompletionDeliveryStatus;
  summary: string;
  terminal_at: string;
}

export interface RunCompletionInventorySource {
  readonly path: string;
  readonly sha256: string;
  readonly bytes_total: number;
  readonly members_total: number;
}

export interface RunCompletionFileNavigation {
  readonly member_index: number;
  readonly locations: Readonly<RunDirectoryNavigation>;
}

export interface RunCompletionBatch {
  attempts?: number;
  /** AX capture marker; numbered spellings/absence are retained codecs, never new-capture choices. */
  readonly presentation_format?: "ax_records" | "ax_records_v1" | "ax_records_v2" | "ax_records_v3";
  /** Retained singleton capture; absence preserves older indexed bytes. Never a new-capture selector. */
  readonly single_result?: true;
  /** Captured record-list shape; no public format/version choice or source authority. */
  readonly result_layout?: "records" | "run_headers" | "headings" | "headings_flat_omissions" | "headings_outcomes" | "headings_shared_results" | "headings_shared_kinds" | "frontmatter_v1" | "frontmatter_v2" | "completion_yaml_core_v1";
  /** Immutable scope/order/range data, not a caller-selected format or allocation authority. */
  readonly numbering?: RunCompletionNumbering;
  /** Formatting version/data only; no recipient ownership, read or publication capability. */
  readonly navigation_handoff?: "current_session_request" | "captured_file_locations";
  /** Formatting only; omission counts remain the already-admitted source facts. */
  readonly excerpt_format?: "bracketed_omissions_v1";
  readonly file_navigation?: readonly Readonly<RunCompletionFileNavigation>[];
  readonly text_budget?: number;
  readonly inventory_source?: Readonly<RunCompletionInventorySource>;
  batch_id: string;
  created_at: string;
  last_error?: string;
  last_failed_at?: string;
  members: readonly RunCompletionBatchMember[];
  phase: RunDeliveryPhase;
  presented_at?: string;
  queued_at?: string;
}

export interface RunSteerEnvelope {
  attempts?: number;
  content: string;
  created_at: string;
  event_id: string;
  kind: string;
  last_error?: string;
  last_failed_at?: string;
  level: "info" | "warning" | "error";
  occurred_at: string;
  phase: RunDeliveryPhase;
  presented_at?: string;
  queued_at?: string;
  run: string;
  run_instance_id: string;
  state_dir: string;
  steer_id: string;
}

export interface RunDeliveryReceipt {
  delivery_id: string;
  kind: "completion_batch" | "urgent_steer";
  presented_at: string;
}

/** A requested fresh target only; requesting it does not activate a stream. */
export interface RunCompletionStreamIntent {
  readonly pending_stream_id: string;
}

export type RunCompletionStreamCounter =
  | Readonly<{ state: "available"; next_index: number }>
  | Readonly<{ state: "unavailable" }>;

export interface RunCompletionStreamActive {
  readonly stream_id: string;
  readonly counter: RunCompletionStreamCounter;
}

export type RunCompletionStreamState =
  | Readonly<RunCompletionStreamIntent & { active?: never }>
  | Readonly<{ active: Readonly<RunCompletionStreamActive>; pending_stream_id?: string }>;

export type RunCompletionStreamStatus =
  | Readonly<{ state: "unavailable"; reason: "stream_state_unavailable" }>
  | Readonly<{ state: "pending"; session_id: string; pending_stream_id: string;
      active?: Readonly<RunCompletionStreamActive>; blocking_batch_id?: string }>
  | Readonly<{ state: "active"; session_id: string; active: Readonly<RunCompletionStreamActive>; blocking_batch_id?: string }>;

export interface RunDeliveryJournal {
  completion_stream?: RunCompletionStreamState;
  completion_batch?: RunCompletionBatch;
  owner_id: string;
  receipts: RunDeliveryReceipt[];
  schema: "run-delivery-v1";
  steers: RunSteerEnvelope[];
}

export interface AdmitRunCompletionBatchInput {
  batchId?: string;
  fileNavigation?: readonly Readonly<RunCompletionFileNavigation>[];
  members: readonly RunCompletionBatchMember[];
  now?: Date;
  ownerId: string;
  tempDir: string;
}

export interface RunDeliveryTransitionInput {
  batchId: string;
  now?: Date;
  ownerId: string;
  tempDir: string;
}

export interface AdmitRunSteerEnvelopeInput {
  content: string;
  eventId: string;
  kind: string;
  level: "info" | "warning" | "error";
  now?: Date;
  occurredAt: string;
  ownerId: string;
  run: string;
  runInstanceId: string;
  stateDir: string;
  steerId?: string;
  tempDir: string;
}

export interface RunSteerTransitionInput {
  now?: Date;
  ownerId: string;
  steerId: string;
  tempDir: string;
}

const RUN_DELIVERY_SCHEMA = "run-delivery-v1";
const COMPLETION_STREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MEMBER_FIELDS = new Set([
  "artifacts",
  "artifact_inventory",
  "artifact_inventory_unavailable",
  "result_diagnostics",
  "result_diagnostics_unavailable",
  "diagnostic_excerpt",
  "parent_run",
  "parent_run_instance_id",
  "parent_state_dir",
  "output",
  "primary_text",
  "completion_text",
  "run",
  "run_instance_id",
  "state_dir",
  "status",
  "summary",
  "terminal_at",
]);
const BATCH_FIELDS = new Set([
  "attempts",
  "presentation_format",
  "single_result",
  "result_layout",
  "numbering",
  "excerpt_format",
  "navigation_handoff",
  "file_navigation",
  "text_budget",
  "inventory_source",
  "batch_id",
  "created_at",
  "last_error",
  "last_failed_at",
  "members",
  "phase",
  "presented_at",
  "queued_at",
]);
const JOURNAL_FIELDS = new Set([
  "completion_stream",
  "completion_batch",
  "owner_id",
  "receipts",
  "schema",
  "steers",
]);
const RECEIPT_FIELDS = new Set([
  "delivery_id",
  "kind",
  "presented_at",
]);
const STEER_FIELDS = new Set([
  "attempts",
  "content",
  "created_at",
  "event_id",
  "kind",
  "last_error",
  "last_failed_at",
  "level",
  "occurred_at",
  "phase",
  "presented_at",
  "queued_at",
  "run",
  "run_instance_id",
  "state_dir",
  "steer_id",
]);

/** Pure whole-capture arithmetic, not a reservation; commit with the packet under its owner lock. */
export function projectRunCompletionIndexRange(nextIndex: number, memberCount: number): RunCompletionIndexRange {
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0) throw new Error("Completion stream counter is invalid");
  if (!Number.isSafeInteger(memberCount) || memberCount < 1 || memberCount > Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS) {
    throw new Error("Completion stream member count is invalid");
  }
  // Subtract before adding so an unfitting range never produces rounded indices or a partial allocation.
  if (memberCount > Number.MAX_SAFE_INTEGER - nextIndex) {
    return Object.freeze({ state: "unavailable", reason: "range_unavailable", next_index: nextIndex });
  }
  return Object.freeze({ state: "available", next_index: nextIndex + memberCount,
    indices: Object.freeze(Array.from({ length: memberCount }, (_, offset) => nextIndex + offset)) });
}

function parseCompletionNumbering(value: unknown, memberCount: number): RunCompletionNumbering {
  const record = asRecord(value, "Completion numbering"), fields = Object.getOwnPropertyDescriptors(record);
  const allowed = fields.kind?.value === "stream" ? ["kind", "session_id", "stream_id", "first_index", "member_order"]
    : ["kind", "session_id", "stream_id", "reason", "member_order"];
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) {
    throw new Error("Completion numbering must contain only own data");
  }
  const kind = fields.kind?.value, session = fields.session_id?.value, stream = fields.stream_id?.value, order = fields.member_order?.value;
  if ((kind !== "stream" && kind !== "unavailable") || typeof session !== "string" || !session.trim() || session.length > 4096 ||
      !Array.isArray(order) || order.length !== memberCount || Reflect.ownKeys(order).length !== memberCount + 1) {
    throw new Error("Completion numbering is invalid");
  }
  const memberOrder: number[] = [], selected = new Set<number>();
  for (let slot = 0; slot < memberCount; slot++) {
    const descriptor = Object.getOwnPropertyDescriptor(order, String(slot));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable || !Number.isSafeInteger(descriptor.value) ||
        descriptor.value < 0 || descriptor.value >= memberCount || selected.has(descriptor.value)) {
      throw new Error("Completion numbering member order is invalid");
    }
    selected.add(descriptor.value); memberOrder.push(descriptor.value);
  }
  if (kind === "stream") {
    const first = fields.first_index?.value;
    if (typeof stream !== "string" || !COMPLETION_STREAM_ID.test(stream) || !Number.isSafeInteger(first) || first < 0 ||
        projectRunCompletionIndexRange(first, memberCount).state !== "available") {
      throw new Error("Completion numbering range is invalid");
    }
    return Object.freeze({ kind, session_id: session, stream_id: stream, first_index: first + 0, member_order: Object.freeze(memberOrder) });
  }
  const reason = fields.reason?.value;
  if ((reason !== "counter_unavailable" && reason !== "range_unavailable" && reason !== "stream_state_unavailable") ||
      (reason === "stream_state_unavailable" ? fields.stream_id !== undefined : typeof stream !== "string" || !COMPLETION_STREAM_ID.test(stream))) {
    throw new Error("Completion numbering unavailability is invalid");
  }
  return Object.freeze({ kind, session_id: session, ...(stream === undefined ? {} : { stream_id: stream }),
    reason, member_order: Object.freeze(memberOrder) });
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label} must be a timestamp`);
  return text;
}

function completionStatus(value: unknown): RunCompletionDeliveryStatus {
  if (value === "done" || value === "failed" || value === "killed" || value === "exited") {
    return value;
  }
  throw new Error("Completion batch member status is invalid");
}

function artifacts(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "Completion batch member artifacts");
  const entries = Object.entries(record);
  if (entries.length > 4) throw new Error("Completion batch member has too many artifacts");
  return Object.fromEntries(entries.map(([name, path]) => [
    boundedString(name, "Completion batch artifact name", 120),
    boundedString(path, "Completion batch artifact path", 4_096),
  ]));
}

function parseMember(value: unknown): RunCompletionBatchMember {
  const record = asRecord(value, "Completion batch member");
  assertExactFields(record, MEMBER_FIELDS, "Completion batch member");
  const parsedArtifacts = artifacts(record.artifacts);
  const parentRun = record.parent_run === undefined
    ? undefined
    : boundedString(record.parent_run, "Completion batch member parent_run", 120);
  const parentRunInstanceId = record.parent_run_instance_id === undefined
    ? undefined
    : boundedString(
        record.parent_run_instance_id,
        "Completion batch member parent_run_instance_id",
        256,
      );
  const parentStateDir = record.parent_state_dir === undefined
    ? undefined
    : boundedString(
        record.parent_state_dir,
        "Completion batch member parent_state_dir",
        4_096,
      );
  if (Boolean(parentRun) !== Boolean(parentRunInstanceId) ||
    Boolean(parentRun) !== Boolean(parentStateDir)) {
    throw new Error("Completion batch member parent lineage is incomplete");
  }
  const output = record.output === undefined
    ? undefined
    : boundedString(record.output, "Completion batch member output", 4_000);
  const stateDir = boundedString(record.state_dir, "Completion batch member state_dir", 4_096);
  const generation = boundedString(record.run_instance_id, "Completion batch member run_instance_id", 256);
  const primary = record.primary_text === undefined ? undefined : decodeRunPrimaryTextBinding(stateDir, generation, record.primary_text);
  const inventory = Object.hasOwn(record, "artifact_inventory") || Object.hasOwn(record, "artifact_inventory_unavailable")
    ? decodeRunArtifactInventoryBinding(stateDir, generation, record) : undefined;
  const diagnostics = Object.hasOwn(record, "result_diagnostics") || Object.hasOwn(record, "result_diagnostics_unavailable")
    ? decodeRunResultDiagnosticsBinding(stateDir, generation, record) : undefined;
  if (diagnostics && output) throw new Error("Completion result diagnostics cannot also carry a legacy display.");
  if (record.diagnostic_excerpt !== undefined && !diagnostics?.result_diagnostics) throw new Error("Completion diagnostic excerpt requires its available source binding.");
  const excerpt = record.diagnostic_excerpt === undefined ? undefined : decodeRunResultDiagnosticExcerpt(diagnostics!.result_diagnostics!, record.diagnostic_excerpt);
  if (inventory && Object.keys(parsedArtifacts ?? {}).length) throw new Error("Completion artifact inventory cannot also carry legacy artifact paths.");
  if (primary?.output && output) throw new Error("Completion primary text cannot also carry a legacy display.");
  return Object.freeze({
    ...(parsedArtifacts ? { artifacts: Object.freeze(parsedArtifacts) } : {}),
    ...(primary ? { primary_text: primary } : {}),
    ...(record.completion_text === undefined ? {} : { completion_text: decodeRunCompletionText(primary, record.completion_text) }),
    ...inventory,
    ...diagnostics,
    ...(excerpt ? { diagnostic_excerpt: excerpt } : {}),
    ...(output ? { output } : {}),
    ...(parentRun
      ? {
          parent_run: parentRun,
          parent_run_instance_id: parentRunInstanceId!,
          parent_state_dir: parentStateDir!,
        }
      : {}),
    run: boundedString(record.run, "Completion batch member run", 120),
    run_instance_id: generation,
    state_dir: stateDir,
    status: completionStatus(record.status),
    summary: boundedString(record.summary, "Completion batch member summary", 1_000),
    terminal_at: timestamp(record.terminal_at, "Completion batch member terminal_at"),
  });
}

// Only already admitted source bindings cross this boundary; private locations and diagnostics do not.
function completionInventoryText(batch: Pick<RunCompletionBatch, "batch_id" | "created_at" | "members" | "numbering">): string {
  return `${JSON.stringify({
    schema: "run-completion-inventory-v1", batch_id: batch.batch_id, created_at: batch.created_at,
    scope: "captured_completion_members", members_total: batch.members.length,
    artifacts: "not_included", diagnostics: "not_included", private_locations: "not_included",
    ...(batch.members.some(member => member.artifact_inventory !== undefined) ? { artifact_inventory: "captured_bindings_only" } : {}),
    ...(batch.members.some(member => member.result_diagnostics !== undefined) ? { result_diagnostics: "captured_bindings_only" } : {}),
    ...(batch.numbering ? { numbering: batch.numbering } : {}),
    members: batch.members.map(member => ({
      run: member.run, run_instance_id: member.run_instance_id, status: member.status, terminal_at: member.terminal_at,
      ...(member.parent_run ? { parent_run: member.parent_run, parent_run_instance_id: member.parent_run_instance_id } : {}),
      ...(member.primary_text ? { primary_text: member.primary_text } : {}),
      ...(member.artifact_inventory === undefined ? {} : { artifact_inventory: member.artifact_inventory,
        ...(member.artifact_inventory_unavailable === undefined ? {} : { artifact_inventory_unavailable: member.artifact_inventory_unavailable }) }),
      ...(member.result_diagnostics === undefined ? {} : { result_diagnostics: member.result_diagnostics,
        ...(member.result_diagnostics_unavailable === undefined ? {} : { result_diagnostics_unavailable: member.result_diagnostics_unavailable }) }),
    })),
  }, null, 2)}\n`;
}

function parseInventorySource(value: unknown, batch: RunCompletionBatch): Readonly<RunCompletionInventorySource> {
  const record = asRecord(value, "Completion inventory source");
  assertExactFields(record, new Set(["path", "sha256", "bytes_total", "members_total"]), "Completion inventory source");
  const content = completionInventoryText(batch); const sha256 = createHash("sha256").update(content).digest("hex");
  const path = boundedString(record.path, "Completion inventory source path", 4_096);
  if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== `inventory-${sha256}.json` ||
    record.sha256 !== sha256 || record.bytes_total !== Buffer.byteLength(content) || record.members_total !== batch.members.length) {
    throw new Error("Completion inventory source binding is invalid");
  }
  return Object.freeze({ path, sha256, bytes_total: record.bytes_total as number, members_total: batch.members.length });
}

function isFrontmatterCompletionLayout(layout: unknown): boolean {
  return layout === "frontmatter_v1" || layout === "frontmatter_v2";
}

function isSharedCompletionLayout(layout: unknown): boolean {
  return layout === "headings_shared_results" || layout === "headings_shared_kinds" || layout === "completion_yaml_core_v1" || isFrontmatterCompletionLayout(layout);
}

function parseBatch(value: unknown): RunCompletionBatch {
  const record = asRecord(value, "Completion batch");
  assertExactFields(record, BATCH_FIELDS, "Completion batch");
  const presentationFormat = record.presentation_format;
  if ((presentationFormat !== undefined && presentationFormat !== "ax_records" && presentationFormat !== "ax_records_v1" && presentationFormat !== "ax_records_v2" && presentationFormat !== "ax_records_v3") ||
    (presentationFormat !== undefined && record.excerpt_format !== undefined)) {
    throw new Error("Completion batch presentation format is invalid");
  }
  if (record.excerpt_format !== undefined && record.excerpt_format !== "bracketed_omissions_v1") {
    throw new Error("Completion batch excerpt format is invalid");
  }
  if (record.navigation_handoff !== undefined && record.navigation_handoff !== "current_session_request" && record.navigation_handoff !== "captured_file_locations") {
    throw new Error("Completion batch navigation handoff is invalid");
  }
  if (!Array.isArray(record.members) || record.members.length === 0) {
    throw new Error("Completion batch members must be a non-empty array");
  }
  if (record.members.length > Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS) {
    throw new Error("Completion batch exceeds the member limit");
  }
  const members = record.members.map(parseMember);
  const singleDescriptor = Object.getOwnPropertyDescriptor(record, "single_result");
  if (singleDescriptor && (!Object.hasOwn(singleDescriptor, "value") || (singleDescriptor.value !== undefined &&
    (singleDescriptor.value !== true || presentationFormat !== "ax_records" || members.length !== 1)))) {
    throw new Error("Completion singleton layout is invalid");
  }
  const singleResult = singleDescriptor?.value;
  const layoutDescriptor = Object.getOwnPropertyDescriptor(record, "result_layout");
  if (layoutDescriptor && (!Object.hasOwn(layoutDescriptor, "value") || (layoutDescriptor.value !== undefined &&
    ((layoutDescriptor.value !== "records" && layoutDescriptor.value !== "run_headers" && layoutDescriptor.value !== "headings" && layoutDescriptor.value !== "headings_flat_omissions" && layoutDescriptor.value !== "headings_outcomes" && !isSharedCompletionLayout(layoutDescriptor.value)) || presentationFormat !== "ax_records" || singleResult !== undefined)))) {
    throw new Error("Completion result layout is invalid");
  }
  const resultLayout = layoutDescriptor?.value;
  const budgetDescriptor = Object.getOwnPropertyDescriptor(record, "text_budget");
  if (budgetDescriptor && (!Object.hasOwn(budgetDescriptor, "value") || !budgetDescriptor.enumerable ||
      (budgetDescriptor.value !== undefined && (!isSharedCompletionLayout(resultLayout) ||
        !Number.isSafeInteger(budgetDescriptor.value) || budgetDescriptor.value < 0 ||
        budgetDescriptor.value > Math.floor(Limits.RUN_COMPLETION_MODEL_MAX_BYTES / Math.min(members.length, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS)))))) {
    throw new Error("Completion shared text budget is invalid");
  }
  const numberingDescriptor = Object.getOwnPropertyDescriptor(record, "numbering");
  if (numberingDescriptor && (resultLayout === "completion_yaml_core_v1" || !Object.hasOwn(numberingDescriptor, "value") || presentationFormat !== "ax_records" || (resultLayout !== "headings" && resultLayout !== "headings_flat_omissions" && resultLayout !== "headings_outcomes" && !isSharedCompletionLayout(resultLayout)))) {
    throw new Error("Completion numbering requires a canonical captured heading layout");
  }
  const numbering = numberingDescriptor ? parseCompletionNumbering(numberingDescriptor.value, members.length) : undefined;
  const identities = new Set<string>();
  for (const member of members) {
    const identity = `${member.state_dir}\0${member.run_instance_id}`;
    if (identities.has(identity)) throw new Error("Completion batch has duplicate generation members");
    identities.add(identity);
  }
  const phase = record.phase;
  if (phase !== "pending" && phase !== "queued" && phase !== "presented") {
    throw new Error("Completion batch phase is invalid");
  }
  const queuedAt = record.queued_at === undefined
    ? undefined
    : timestamp(record.queued_at, "Completion batch queued_at");
  const presentedAt = record.presented_at === undefined
    ? undefined
    : timestamp(record.presented_at, "Completion batch presented_at");
  const attempts = record.attempts;
  if (
    attempts !== undefined &&
    (typeof attempts !== "number" ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      attempts > 1_000_000)
  ) throw new Error("Completion batch attempts are invalid");
  const lastError = record.last_error === undefined
    ? undefined
    : boundedString(record.last_error, "Completion batch last_error", 4_096);
  const lastFailedAt = record.last_failed_at === undefined
    ? undefined
    : timestamp(record.last_failed_at, "Completion batch last_failed_at");
  if (Boolean(lastError) !== Boolean(lastFailedAt)) {
    throw new Error("Completion batch failure evidence is incomplete");
  }
  if (phase === "pending" && (queuedAt || presentedAt)) {
    throw new Error("Pending completion batch cannot have delivery timestamps");
  }
  if (phase === "queued" && (!queuedAt || presentedAt)) {
    throw new Error("Queued completion batch must have only queued_at");
  }
  if (phase === "presented" && (!queuedAt || !presentedAt)) {
    throw new Error("Presented completion batch requires queued_at and presented_at");
  }
  const navigation = record.file_navigation;
  if ((record.navigation_handoff === "captured_file_locations") !== (navigation !== undefined)) throw new Error("Completion file navigation version/data mismatch");
  let fileNavigation: readonly Readonly<RunCompletionFileNavigation>[] | undefined;
  if (navigation !== undefined) {
    if (!Array.isArray(navigation) || navigation.length > members.length || Object.keys(navigation).length !== navigation.length) throw new Error("Completion file navigation is invalid");
    const selected = new Set<number>();
    fileNavigation = Object.freeze(Array.from({ length: navigation.length }, (_, slot) => {
      const entry = Object.getOwnPropertyDescriptor(navigation, String(slot));
      if (!entry || !Object.hasOwn(entry, "value")) throw new Error("Completion file navigation is invalid");
      const row = asRecord(entry.value, "Completion file navigation");
      assertExactFields(row, new Set(["member_index", "locations"]), "Completion file navigation");
      const descriptors = Object.getOwnPropertyDescriptors(row);
      if (!descriptors.member_index || !descriptors.locations || !Object.hasOwn(descriptors.member_index, "value") || !Object.hasOwn(descriptors.locations, "value")) throw new Error("Completion file navigation is invalid");
      const index = descriptors.member_index.value;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= members.length || selected.has(index)) throw new Error("Completion file navigation member is invalid");
      selected.add(index);
      const locations = decodeRunDirectoryNavigation(descriptors.locations.value), member = members[index];
      if (locations.state === "available" && (locations.run !== member.run || locations.run_instance_id !== member.run_instance_id || locations.directory !== member.state_dir)) throw new Error("Completion file navigation identity mismatch");
      return Object.freeze({ member_index: index, locations });
    }));
    if (Buffer.byteLength(JSON.stringify(fileNavigation), "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Completion file navigation exceeds byte limit");
  }
  const batch: RunCompletionBatch = {
    ...(presentationFormat === undefined ? {} : { presentation_format: presentationFormat }),
    ...(singleResult === true ? { single_result: true as const } : {}),
    ...(resultLayout === undefined ? {} : { result_layout: resultLayout }),
    ...(budgetDescriptor?.value === undefined ? {} : { text_budget: budgetDescriptor.value as number }),
    ...(numbering ? { numbering } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(record.navigation_handoff === undefined ? {} : { navigation_handoff: record.navigation_handoff }),
    ...(record.excerpt_format === undefined ? {} : { excerpt_format: record.excerpt_format }),
    ...(fileNavigation ? { file_navigation: fileNavigation } : {}),
    batch_id: boundedString(record.batch_id, "Completion batch id", 128),
    created_at: timestamp(record.created_at, "Completion batch created_at"),
    ...(lastError ? { last_error: lastError } : {}),
    ...(lastFailedAt ? { last_failed_at: lastFailedAt } : {}),
    members: Object.freeze(members),
    phase,
    ...(queuedAt ? { queued_at: queuedAt } : {}),
    ...(presentedAt ? { presented_at: presentedAt } : {}),
  };
  return record.inventory_source === undefined ? batch : { ...batch, inventory_source: parseInventorySource(record.inventory_source, batch) };
}

function parseSteer(value: unknown): RunSteerEnvelope {
  const record = asRecord(value, "Urgent steer envelope");
  assertExactFields(record, STEER_FIELDS, "Urgent steer envelope");
  const phase = record.phase;
  if (phase !== "pending" && phase !== "queued" && phase !== "presented") {
    throw new Error("Urgent steer phase is invalid");
  }
  const queuedAt = record.queued_at === undefined
    ? undefined
    : timestamp(record.queued_at, "Urgent steer queued_at");
  const presentedAt = record.presented_at === undefined
    ? undefined
    : timestamp(record.presented_at, "Urgent steer presented_at");
  if (phase === "pending" && (queuedAt || presentedAt)) {
    throw new Error("Pending urgent steer cannot have delivery timestamps");
  }
  if (phase === "queued" && (!queuedAt || presentedAt)) {
    throw new Error("Queued urgent steer must have only queued_at");
  }
  if (phase === "presented" && (!queuedAt || !presentedAt)) {
    throw new Error("Presented urgent steer requires queued_at and presented_at");
  }
  const attempts = record.attempts;
  if (
    attempts !== undefined &&
    (typeof attempts !== "number" ||
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      attempts > 1_000_000)
  ) throw new Error("Urgent steer attempts are invalid");
  const lastError = record.last_error === undefined
    ? undefined
    : boundedString(record.last_error, "Urgent steer last_error", 4_096);
  const lastFailedAt = record.last_failed_at === undefined
    ? undefined
    : timestamp(record.last_failed_at, "Urgent steer last_failed_at");
  if (Boolean(lastError) !== Boolean(lastFailedAt)) {
    throw new Error("Urgent steer failure evidence is incomplete");
  }
  const content = boundedString(
    record.content,
    "Urgent steer content",
    Limits.RUN_DELIVERY_STEER_MAX_BYTES,
  );
  if (Buffer.byteLength(content, "utf8") > Limits.RUN_DELIVERY_STEER_MAX_BYTES) {
    throw new Error("Urgent steer content exceeds the byte limit");
  }
  const level = record.level;
  if (level !== "info" && level !== "warning" && level !== "error") {
    throw new Error("Urgent steer level is invalid");
  }
  return {
    ...(attempts !== undefined ? { attempts } : {}),
    content,
    created_at: timestamp(record.created_at, "Urgent steer created_at"),
    event_id: boundedString(record.event_id, "Urgent steer event_id", 256),
    kind: boundedString(record.kind, "Urgent steer kind", 256),
    ...(lastError ? { last_error: lastError } : {}),
    ...(lastFailedAt ? { last_failed_at: lastFailedAt } : {}),
    level,
    occurred_at: timestamp(record.occurred_at, "Urgent steer occurred_at"),
    phase,
    ...(presentedAt ? { presented_at: presentedAt } : {}),
    ...(queuedAt ? { queued_at: queuedAt } : {}),
    run: boundedString(record.run, "Urgent steer run", 120),
    run_instance_id: boundedString(
      record.run_instance_id,
      "Urgent steer run_instance_id",
      256,
    ),
    state_dir: boundedString(record.state_dir, "Urgent steer state_dir", 4_096),
    steer_id: boundedString(record.steer_id, "Urgent steer id", 128),
  };
}

function parseReceipt(value: unknown): RunDeliveryReceipt {
  const record = asRecord(value, "Run delivery receipt");
  assertExactFields(record, RECEIPT_FIELDS, "Run delivery receipt");
  if (record.kind !== "completion_batch" && record.kind !== "urgent_steer") {
    throw new Error("Run delivery receipt kind is invalid");
  }
  return {
    delivery_id: boundedString(record.delivery_id, "Run delivery receipt id", 128),
    kind: record.kind,
    presented_at: timestamp(record.presented_at, "Run delivery receipt presented_at"),
  };
}

function completionStreamFields(value: unknown, allowed: readonly string[]): PropertyDescriptorMap {
  const fields = Object.getOwnPropertyDescriptors(asRecord(value, "Completion stream intent"));
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) {
    throw new Error("Completion stream intent is invalid");
  }
  return fields;
}

function parseCompletionStreamState(value: unknown): RunCompletionStreamState {
  const fields = completionStreamFields(value, ["active", "pending_stream_id"]);
  const pending = fields.pending_stream_id?.value;
  if ((!fields.active && !fields.pending_stream_id) || (fields.pending_stream_id &&
      (typeof pending !== "string" || !COMPLETION_STREAM_ID.test(pending)))) {
    throw new Error("Completion stream intent is invalid");
  }
  if (!fields.active) return Object.freeze({ pending_stream_id: pending });
  const active = completionStreamFields(fields.active.value, ["stream_id", "counter"]);
  const id = active.stream_id?.value;
  if (typeof id !== "string" || !COMPLETION_STREAM_ID.test(id) || id === pending) {
    throw new Error("Completion stream active identity is invalid");
  }
  const counter = completionStreamFields(active.counter?.value, ["state", "next_index"]);
  let retainedCounter: RunCompletionStreamCounter;
  if (counter.state?.value === "available") {
    const next = counter.next_index?.value;
    // A newly activated stream already captured at least one member in its first commit.
    if (!Number.isSafeInteger(next) || next < 1) throw new Error("Completion stream active counter is invalid");
    retainedCounter = Object.freeze({ state: "available", next_index: next });
  } else if (counter.state?.value === "unavailable" && !counter.next_index) {
    retainedCounter = Object.freeze({ state: "unavailable" });
  } else throw new Error("Completion stream active counter is invalid");
  return Object.freeze({ active: Object.freeze({ stream_id: id, counter: retainedCounter }),
    ...(fields.pending_stream_id ? { pending_stream_id: pending } : {}) });
}

function assertCompletionStreamBatch(stream: RunCompletionStreamState | undefined, batch: RunCompletionBatch | undefined, ownerId: string): void {
  if (!batch) return;
  const numbering = batch.numbering, active = stream?.active;
  if (!numbering) {
    if (active) throw new Error("Active completion stream cannot contain a packet-local batch");
    return;
  }
  if (!active || numbering.session_id !== ownerId || numbering.stream_id !== active.stream_id) {
    throw new Error("Completion numbering has no matching active session stream");
  }
  if (numbering.kind === "stream" && active.counter.state === "available" &&
      active.counter.next_index < numbering.first_index + batch.members.length) {
    throw new Error("Completion stream counter is behind its captured packet");
  }
}

function emptyJournal(ownerId: string): RunDeliveryJournal {
  return {
    owner_id: ownerId,
    receipts: [],
    schema: RUN_DELIVERY_SCHEMA,
    steers: [],
  };
}

function parseJournal(value: unknown, ownerId: string, path: string): RunDeliveryJournal {
  const record = asRecord(value, "Run delivery journal");
  assertExactFields(record, JOURNAL_FIELDS, "Run delivery journal");
  if (record.schema !== RUN_DELIVERY_SCHEMA) {
    throw new Error("Run delivery journal schema is invalid");
  }
  if (record.owner_id !== ownerId) {
    throw new Error("Run delivery journal owner does not match the active owner");
  }
  if (!Array.isArray(record.receipts) || record.receipts.length > Limits.RUN_DELIVERY_RECEIPT_LIMIT) {
    throw new Error("Run delivery journal receipts are invalid");
  }
  const receipts = record.receipts.map(parseReceipt);
  if (new Set(receipts.map((receipt) =>
    `${receipt.kind}\0${receipt.delivery_id}`)).size !== receipts.length) {
    throw new Error("Run delivery journal has duplicate receipts");
  }
  const rawSteers = record.steers === undefined ? [] : record.steers;
  if (
    !Array.isArray(rawSteers) ||
    rawSteers.length > Limits.RUN_DELIVERY_STEER_MAX_ENVELOPES
  ) throw new Error("Run delivery journal urgent steers are invalid");
  const steers = rawSteers.map(parseSteer);
  if (new Set(steers.map((steer) => steer.steer_id)).size !== steers.length) {
    throw new Error("Run delivery journal has duplicate urgent steer ids");
  }
  const streamDescriptor = Object.getOwnPropertyDescriptor(record, "completion_stream");
  if (streamDescriptor && (!Object.hasOwn(streamDescriptor, "value") || !streamDescriptor.enumerable)) {
    throw new Error("Completion stream intent must be stored as own data");
  }
  const stream = streamDescriptor ? parseCompletionStreamState(streamDescriptor.value) : undefined;
  const batch = record.completion_batch === undefined ? undefined : parseBatch(record.completion_batch);
  if (batch && isSharedCompletionLayout(batch.result_layout) && batch.text_budget === undefined) throw new Error("Captured completion shared text budget is unavailable");
  assertCompletionStreamBatch(stream, batch, ownerId);
  if (batch?.inventory_source && batch.inventory_source.path !== resolve(dirname(path), `inventory-${batch.inventory_source.sha256}.json`)) {
    throw new Error("Completion inventory source belongs to another delivery location");
  }
  return {
    ...(stream ? { completion_stream: stream } : {}),
    ...(batch ? { completion_batch: batch } : {}),
    owner_id: ownerId,
    receipts,
    schema: RUN_DELIVERY_SCHEMA,
    steers,
  };
}

function ownerKey(ownerId: string): string {
  const exact = boundedString(ownerId, "Run delivery owner", 4_096);
  return createHash("sha256").update(exact).digest("hex");
}

export function getRunDeliveryJournalPath(tempDir: string, ownerId: string): string {
  return join(tempDir, "delivery", ownerKey(ownerId), "projection.json");
}

function assertNoDeliverySymlinks(tempDir: string, path: string): void {
  for (const candidate of [join(tempDir, "delivery"), dirname(path), path]) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`Run delivery state rejects symbolic link: ${candidate}`);
    }
  }
}

function readJournalAtPath(path: string, ownerId: string, requireExisting = false): RunDeliveryJournal {
  if (!existsSync(path)) {
    if (requireExisting) throw new Error("Completion stream request requires an existing delivery journal");
    return emptyJournal(ownerId);
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > Limits.RUN_DELIVERY_JOURNAL_MAX_BYTES) {
    throw new Error("Run delivery journal is not a bounded regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Run delivery journal is malformed", { cause: error });
  }
  return parseJournal(parsed, ownerId, path);
}

export function readRunDeliveryJournal(
  tempDir: string,
  ownerId: string,
): RunDeliveryJournal {
  const path = getRunDeliveryJournalPath(tempDir, ownerId);
  assertNoDeliverySymlinks(tempDir, path);
  return readJournalAtPath(path, ownerId);
}

function journalText(journal: RunDeliveryJournal): string {
  const content = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > Limits.RUN_DELIVERY_JOURNAL_MAX_BYTES) {
    throw new Error("Run delivery journal exceeds the byte limit");
  }
  return content;
}

function mutateJournal<T>(
  tempDir: string,
  ownerId: string,
  mutate: (journal: RunDeliveryJournal) => T,
  requireExisting = false,
): T {
  const path = getRunDeliveryJournalPath(tempDir, ownerId);
  return withFileMutationLock(path, () => {
    assertNoDeliverySymlinks(tempDir, path);
    const journal = readJournalAtPath(path, ownerId, requireExisting);
    const result = mutate(journal);
    writeTextAtomic(path, journalText(parseJournal(journal, ownerId, path)));
    return result;
  });
}

/** Read-only persisted facts, not proof of non-connection or current SDK ownership. */
export function readRunCompletionStreamStatus(tempDir: string, ownerId: string): RunCompletionStreamStatus {
  const journal = readRunDeliveryJournal(tempDir, ownerId), stream = journal.completion_stream;
  if (!stream) return Object.freeze({ state: "unavailable", reason: "stream_state_unavailable" });
  const blocking = journal.completion_batch ? { blocking_batch_id: journal.completion_batch.batch_id } : {};
  if (stream.pending_stream_id) return Object.freeze({ state: "pending", session_id: journal.owner_id,
    pending_stream_id: stream.pending_stream_id, ...(stream.active ? { active: stream.active } : {}), ...blocking });
  return Object.freeze({ state: "active", session_id: journal.owner_id, active: stream.active!, ...blocking });
}

/** Kernel-only explicit request; fresh-session bootstrap and public command admission remain separate. */
export function requestRunCompletionStream(input: { tempDir: string; ownerId: string }): Readonly<RunCompletionStreamIntent> {
  const path = getRunDeliveryJournalPath(input.tempDir, input.ownerId);
  return withFileMutationLock(path, () => {
    assertNoDeliverySymlinks(input.tempDir, path);
    const journal = readJournalAtPath(path, input.ownerId, true);
    if (journal.completion_stream?.pending_stream_id) return Object.freeze({ pending_stream_id: journal.completion_stream.pending_stream_id });
    const stream = Object.freeze({ pending_stream_id: randomUUID() });
    journal.completion_stream = parseCompletionStreamState({ ...journal.completion_stream, ...stream });
    writeTextAtomic(path, journalText(parseJournal(journal, input.ownerId, path)));
    return stream;
  });
}

export function admitRunCompletionBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch {
  return captureCompletionBatch(input, false, "completion_yaml_core_v1");
}

/** Kernel-only opt-in; ordinary Pi capture stays fenced until session/lifecycle integration is admitted. */
export function captureRunCompletionStreamBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch {
  return captureCompletionBatch(input, true);
}

/** Private ordinary candidate composition; stream capture retains its separately gated codec. */
export function captureRunCompletionYamlCandidateBatch(input: AdmitRunCompletionBatchInput): RunCompletionBatch {
  return captureCompletionBatch(input, false, "completion_yaml_core_v1");
}

function captureCompletionBatch(input: AdmitRunCompletionBatchInput, numbered: boolean, layout: "frontmatter_v2" | "completion_yaml_core_v1" = "frontmatter_v2"): RunCompletionBatch {
  const now = (input.now ?? new Date()).toISOString();
  if (Object.hasOwn(input, "presentationFormat")) throw new Error("Completion presentation selection is not supported; new batches use AX.");
  if (Object.hasOwn(input, "numbering")) throw new Error("Completion numbering is assigned only by journal capture");
  const captured = parseBatch({
    presentation_format: "ax_records",
    navigation_handoff: input.fileNavigation === undefined ? "current_session_request" : "captured_file_locations",
    ...(input.fileNavigation === undefined ? {} : { file_navigation: input.fileNavigation }),
    batch_id: input.batchId ?? randomUUID(),
    created_at: now,
    members: input.members,
    phase: "pending",
  });
  const draft: RunCompletionBatch = layout === "completion_yaml_core_v1"
    ? parseBatch({ ...captured, result_layout: layout }) : { ...captured, result_layout: layout };
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    let batch = draft;
    if (journal.completion_batch) {
      throw new Error("Run delivery journal already has an active completion batch");
    }
    if (journal.receipts.some((receipt) => receipt.delivery_id === batch.batch_id)) {
      throw new Error("Run delivery batch id already has a presented receipt");
    }
    if (numbered) {
      const stream = journal.completion_stream;
      if (!stream) throw new Error("Completion stream capture requires retained stream state");
      const target = stream.pending_stream_id, active = stream.active;
      const streamId = target ?? active!.stream_id;
      const counter: RunCompletionStreamCounter = target ? { state: "available", next_index: 0 } : active!.counter;
      const range = counter.state === "available" ? projectRunCompletionIndexRange(counter.next_index, batch.members.length) : undefined;
      const slots = new Map(batch.members.map((member, slot) => [memberIdentity(member), slot]));
      const member_order = orderRunCompletionMembers(batch.members).map(member => slots.get(memberIdentity(member))!);
      const numbering: RunCompletionNumbering = range?.state === "available"
        ? { kind: "stream", session_id: input.ownerId, stream_id: streamId, first_index: range.indices[0]!, member_order }
        : { kind: "unavailable", session_id: input.ownerId, stream_id: streamId,
          reason: range ? "range_unavailable" : "counter_unavailable", member_order };
      batch = parseBatch({ ...batch, numbering });
      journal.completion_stream = parseCompletionStreamState({ active: { stream_id: streamId,
        counter: range?.state === "available" ? { state: "available", next_index: range.next_index } : counter } });
    } else if (journal.completion_stream) {
      throw new Error("Completion stream capture requires the numbered kernel path; stream state is retained");
    }
    if (layout !== "completion_yaml_core_v1") batch = retainSharedCompletionTexts(batch);
    if (projectCompletionBatchMessage(batch).membersShown === batch.members.length) {
      if (layout === "completion_yaml_core_v1") batch = retainSharedCompletionTexts(batch);
      journal.completion_batch = batch;
      return batch;
    }
    const content = completionInventoryText(batch);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const journalPath = getRunDeliveryJournalPath(input.tempDir, input.ownerId);
    const path = resolve(dirname(journalPath), `inventory-${sha256}.json`);
    const retained = retainSharedCompletionTexts(parseBatch({ ...batch, inventory_source: { path, sha256, bytes_total: Buffer.byteLength(content), members_total: batch.members.length } }));
    journal.completion_batch = retained;
    // Refuse known journal overflow before a separate source effect. Never overwrite/reuse an orphan.
    journalText(parseJournal(journal, input.ownerId, journalPath));
    assertNoDeliverySymlinks(input.tempDir, path);
    mkdirSync(dirname(path), { recursive: true });
    assertNoDeliverySymlinks(input.tempDir, path);
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory()) throw new Error("Completion inventory directory is invalid");
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    assertNoDeliverySymlinks(input.tempDir, path);
    const current = lstatSync(dirname(path)); const source = lstatSync(path);
    if (current.dev !== directory.dev || current.ino !== directory.ino || !source.isFile() || source.size !== Buffer.byteLength(content)) {
      throw new Error("Completion inventory source binding changed during retention");
    }
    return retained;
  }, numbered);
}

export function markRunCompletionBatchQueued(
  input: RunDeliveryTransitionInput,
): boolean {
  const now = (input.now ?? new Date()).toISOString();
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const batch = journal.completion_batch;
    if (!batch || batch.batch_id !== input.batchId) return false;
    if (batch.phase === "queued" || batch.phase === "presented") return true;
    batch.phase = "queued";
    batch.queued_at = now;
    return true;
  });
}

export function resetRunCompletionBatchPending(
  input: Omit<RunDeliveryTransitionInput, "now">,
): boolean {
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const batch = journal.completion_batch;
    if (!batch || batch.batch_id !== input.batchId || batch.phase === "presented") {
      return false;
    }
    if (batch.phase === "pending") return true;
    batch.phase = "pending";
    delete batch.queued_at;
    return true;
  });
}

export function recordRunCompletionBatchDeliveryFailure(
  input: RunDeliveryTransitionInput & { error: unknown },
): boolean {
  const now = (input.now ?? new Date()).toISOString();
  const raw = input.error instanceof Error ? input.error.message : String(input.error);
  const error = raw.replaceAll(/\s+/g, " ").trim().slice(0, 4_096) ||
    "Unknown completion delivery failure";
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const batch = journal.completion_batch;
    if (!batch || batch.batch_id !== input.batchId || batch.phase !== "pending") {
      return false;
    }
    batch.attempts = Math.min((batch.attempts ?? 0) + 1, 1_000_000);
    batch.last_error = error;
    batch.last_failed_at = now;
    return true;
  });
}

export function markRunCompletionBatchPresented(
  input: RunDeliveryTransitionInput,
): boolean {
  const now = (input.now ?? new Date()).toISOString();
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const batch = journal.completion_batch;
    if (!batch || batch.batch_id !== input.batchId || batch.phase === "pending") return false;
    if (batch.phase === "presented") return true;
    batch.phase = "presented";
    batch.presented_at = now;
    return true;
  });
}

export function finalizeRunCompletionBatch(
  input: Omit<RunDeliveryTransitionInput, "now">,
): boolean {
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const batch = journal.completion_batch;
    if (!batch || batch.batch_id !== input.batchId) {
      return journal.receipts.some((receipt) => receipt.delivery_id === input.batchId);
    }
    if (batch.phase !== "presented" || !batch.presented_at) return false;
    journal.receipts = [
      ...journal.receipts.filter((receipt) => receipt.delivery_id !== batch.batch_id),
      {
        delivery_id: batch.batch_id,
        kind: "completion_batch",
        presented_at: batch.presented_at,
      } satisfies RunDeliveryReceipt,
    ].slice(-Limits.RUN_DELIVERY_RECEIPT_LIMIT);
    delete journal.completion_batch;
    return true;
  });
}

export function getRunSteerDeliveryId(input: {
  eventId: string;
  runInstanceId: string;
  stateDir: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    input.stateDir,
    input.runInstanceId,
    input.eventId,
  ])).digest("hex");
}

export function admitRunSteerEnvelope(
  input: AdmitRunSteerEnvelopeInput,
): RunSteerEnvelope | undefined {
  const steer = parseSteer({
    content: input.content,
    created_at: (input.now ?? new Date()).toISOString(),
    event_id: input.eventId,
    kind: input.kind,
    level: input.level,
    occurred_at: input.occurredAt,
    phase: "pending",
    run: input.run,
    run_instance_id: input.runInstanceId,
    state_dir: input.stateDir,
    steer_id: input.steerId ?? getRunSteerDeliveryId(input),
  });
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const existing = journal.steers.find((item) => item.steer_id === steer.steer_id);
    if (existing) {
      if (
        existing.content !== steer.content ||
        existing.event_id !== steer.event_id ||
        existing.run_instance_id !== steer.run_instance_id ||
        existing.state_dir !== steer.state_dir
      ) throw new Error("Urgent steer id conflicts with a different envelope");
      return existing;
    }
    if (journal.receipts.some((receipt) =>
      receipt.kind === "urgent_steer" && receipt.delivery_id === steer.steer_id)) {
      return undefined;
    }
    if (journal.steers.length >= Limits.RUN_DELIVERY_STEER_MAX_ENVELOPES) {
      throw Object.assign(new Error("Run delivery urgent steer capacity is full"), {
        code: "RUN_STEER_CAPACITY",
      });
    }
    journal.steers.push(steer);
    return steer;
  });
}

function mutateSteer(
  input: RunSteerTransitionInput,
  mutate: (steer: RunSteerEnvelope) => boolean,
): boolean {
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const steer = journal.steers.find((item) => item.steer_id === input.steerId);
    return steer ? mutate(steer) : false;
  });
}

export function markRunSteerQueued(input: RunSteerTransitionInput): boolean {
  const now = (input.now ?? new Date()).toISOString();
  return mutateSteer(input, (steer) => {
    if (steer.phase === "queued" || steer.phase === "presented") return true;
    steer.phase = "queued";
    steer.queued_at = now;
    return true;
  });
}

export function resetRunSteerPending(
  input: Omit<RunSteerTransitionInput, "now">,
): boolean {
  return mutateSteer(input, (steer) => {
    if (steer.phase === "presented") return false;
    if (steer.phase === "pending") return true;
    steer.phase = "pending";
    delete steer.queued_at;
    return true;
  });
}

export function recordRunSteerDeliveryFailure(
  input: RunSteerTransitionInput & { error: unknown },
): boolean {
  const now = (input.now ?? new Date()).toISOString();
  const raw = input.error instanceof Error ? input.error.message : String(input.error);
  const error = raw.replaceAll(/\s+/g, " ").trim().slice(0, 4_096) ||
    "Unknown urgent steer delivery failure";
  return mutateSteer(input, (steer) => {
    if (steer.phase !== "pending") return false;
    steer.attempts = Math.min((steer.attempts ?? 0) + 1, 1_000_000);
    steer.last_error = error;
    steer.last_failed_at = now;
    return true;
  });
}

export function markRunSteerPresented(input: RunSteerTransitionInput): boolean {
  const now = (input.now ?? new Date()).toISOString();
  return mutateSteer(input, (steer) => {
    if (steer.phase === "pending") return false;
    if (steer.phase === "presented") return true;
    steer.phase = "presented";
    steer.presented_at = now;
    return true;
  });
}

export function finalizeRunSteer(
  input: Omit<RunSteerTransitionInput, "now">,
): boolean {
  return mutateJournal(input.tempDir, input.ownerId, (journal) => {
    const index = journal.steers.findIndex((item) => item.steer_id === input.steerId);
    if (index < 0) return journal.receipts.some((receipt) =>
      receipt.kind === "urgent_steer" && receipt.delivery_id === input.steerId);
    const steer = journal.steers[index]!;
    if (steer.phase !== "presented" || !steer.presented_at) return false;
    journal.steers.splice(index, 1);
    journal.receipts = [
      ...journal.receipts.filter((receipt) =>
        receipt.kind !== "urgent_steer" || receipt.delivery_id !== steer.steer_id),
      {
        delivery_id: steer.steer_id,
        kind: "urgent_steer",
        presented_at: steer.presented_at,
      } satisfies RunDeliveryReceipt,
    ].slice(-Limits.RUN_DELIVERY_RECEIPT_LIMIT);
    return true;
  });
}

function compactModelText(value: string, limit: number): string {
  const compact = value.replaceAll(/\s+/g, " ").replaceAll("`", "'").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function memberIdentity(member: RunCompletionBatchMember): string {
  return `${member.state_dir}\0${member.run_instance_id}`;
}

function completionDepth(
  member: RunCompletionBatchMember,
  byIdentity: Map<string, RunCompletionBatchMember>,
): number {
  const visited = new Set<string>();
  let current = member;
  let depth = 0;
  while (current.parent_state_dir && current.parent_run_instance_id) {
    const identity = `${current.parent_state_dir}\0${current.parent_run_instance_id}`;
    if (visited.has(identity)) break;
    visited.add(identity);
    const parent = byIdentity.get(identity);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** Captured membership ordering only; never native lineage or a complete descendant tree. */
export function orderRunCompletionMembers(
  members: readonly RunCompletionBatchMember[],
  prioritizeFailed = false,
): RunCompletionBatchMember[] {
  const byIdentity = new Map(members.map((member) => [memberIdentity(member), member]));
  const children = new Map<string, RunCompletionBatchMember[]>();
  const roots: RunCompletionBatchMember[] = [];
  for (const member of members) {
    const parentIdentity = member.parent_state_dir && member.parent_run_instance_id
      ? `${member.parent_state_dir}\0${member.parent_run_instance_id}`
      : undefined;
    if (!parentIdentity || !byIdentity.has(parentIdentity) || (prioritizeFailed && byIdentity.get(parentIdentity)!.run !== member.parent_run)) {
      roots.push(member);
      continue;
    }
    const siblings = children.get(parentIdentity) ?? [];
    siblings.push(member);
    children.set(parentIdentity, siblings);
  }
  const failed = new Set(members.filter(member => member.status === "failed").map(memberIdentity));
  if (prioritizeFailed) for (const member of members) {
    let current = member; const seen = new Set<string>();
    while (failed.has(memberIdentity(current)) && current.parent_state_dir && current.parent_run_instance_id) {
      const key = `${current.parent_state_dir}\0${current.parent_run_instance_id}`, parent = byIdentity.get(key);
      if (!parent || parent.run !== current.parent_run || seen.has(key)) break;
      seen.add(key); failed.add(key); current = parent;
    }
  }
  const peers = (items: RunCompletionBatchMember[]) => prioritizeFailed
    ? [...items.filter(member => failed.has(memberIdentity(member))), ...items.filter(member => !failed.has(memberIdentity(member)))] : items;
  const ordered: RunCompletionBatchMember[] = [];
  const visited = new Set<string>();
  const visit = (member: RunCompletionBatchMember): void => {
    const identity = memberIdentity(member);
    if (visited.has(identity)) return;
    visited.add(identity);
    ordered.push(member);
    for (const child of peers(children.get(identity) ?? [])) visit(child);
  };
  for (const root of roots) visit(root);
  for (const member of members) visit(member);
  return ordered;
}

function formatModelOutput(value: string, indent: string): string {
  return value
    .replaceAll("`", "'")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
    .map((line) => `${indent}  ${line}`)
    .join("\n");
}

function formatPrimaryText(binding: Readonly<RunPrimaryTextBinding>, indent: string, bracketed: boolean): string {
  if (!binding.output) return `\n${indent}  Primary output unavailable: ${binding.output_unavailable}.`;
  const output = binding.output;
  return `\n${indent}  Primary output: ${output.chars_shown}/${output.chars_total} code points; ${bracketed ? `[${output.chars_omitted} characters omitted]` : `${output.chars_omitted} omitted`}; ${output.truncated ? "clipped" : "complete exported text"}${output.redacted ? "; redacted" : ""}.` +
    `\n${indent}  UTF-8 bytes: [${output.shown_bytes.start}, ${output.shown_bytes.end}) / ${output.bytes_total}.` +
    `\n${formatLiteralBlock(output.preview)}\n${indent}  Retained source at capture:\n${formatLiteralBlock(JSON.stringify(output.source, null, 2))}`;
}

function formatArtifactInventory(member: RunCompletionBatchMember, indent: string): string {
  if (member.artifact_inventory === undefined) return "";
  if (member.artifact_inventory === null) return member.artifact_inventory_unavailable === "not_declared" ? ""
    : `\n${indent}  Artifact inventory unavailable: ${member.artifact_inventory_unavailable}; no legacy path fallback.`;
  const inventory = member.artifact_inventory;
  return `\n${indent}  Artifact declarations: ${inventory.declarations_total}; metadata only; target availability/production not asserted; bodies not read.` +
    `\n${indent}  Retained declaration inventory at capture:\n${formatLiteralBlock(JSON.stringify({ ...inventory.source,
      bytes_total: inventory.bytes_total, declarations_total: inventory.declarations_total }, null, 2))}`;
}

function formatResultDiagnostics(member: RunCompletionBatchMember, indent: string, bracketed: boolean): string {
  if (member.result_diagnostics === undefined) return "";
  if (member.result_diagnostics === null) return member.result_diagnostics_unavailable === "not_recorded" ? ""
    : `\n${indent}  Diagnostic metadata unavailable: ${member.result_diagnostics_unavailable}; no legacy body fallback.`;
  const reference = member.result_diagnostics; const excerpt = member.diagnostic_excerpt;
  const others = reference.fields.filter(field => field !== excerpt?.field);
  return `\n${indent}  Diagnostic metadata only; not primary output; admission privacy for recorded fields.` +
    (excerpt ? `\n${indent}  Field ${excerpt.field}: ${excerpt.chars_shown}/${excerpt.chars_total} code points; ${bracketed ? `[${excerpt.chars_omitted} characters omitted]` : `${excerpt.chars_omitted} omitted`}; ${excerpt.truncated ? "clipped" : "complete field"}.` +
      `\n${indent}  Field UTF-8 bytes: [${excerpt.shown_bytes.start}, ${excerpt.shown_bytes.end}) / ${excerpt.bytes_total}.\n${formatLiteralBlock(excerpt.text)}` : "") +
    (others.length ? `\n${indent}  Recorded fields not shown: ${others.join(", ")}.` : "") +
    `\n${indent}  Retained diagnostic source at capture:\n${formatLiteralBlock(JSON.stringify({ ...reference.source, bytes_total: reference.bytes_total, fields: reference.fields }, null, 2))}`;
}

function formatCompletionMember(
  member: RunCompletionBatchMember,
  byIdentity: Map<string, RunCompletionBatchMember>,
  bracketedExcerpts: boolean,
): string {
  const summary = compactModelText(member.summary, 200);
  const artifactEntries = Object.entries(member.artifacts ?? {}).slice(0, 4);
  const artifactText = artifactEntries.length === 0
    ? ""
    : `; artifacts: ${artifactEntries.map(([name, path]) =>
      `${compactModelText(name, 120)}=\`${compactModelText(path, 320)}\``
    ).join(", ")}`;
  const indent = "  ".repeat(Math.min(completionDepth(member, byIdentity), 8));
  const output = member.output
    ? `\n${indent}  ${member.primary_text ? "Legacy diagnostic display (not a complete primary source)" : "Output"}:\n${formatModelOutput(member.output, indent)}`
    : "";
  const primary = member.primary_text ? formatPrimaryText(member.primary_text, indent, bracketedExcerpts) : "";
  return `${indent}- \`${compactModelText(member.run, 120)}\` — \`${member.status}\`: ${summary}${artifactText}${primary}${formatArtifactInventory(member, indent)}${formatResultDiagnostics(member, indent, bracketedExcerpts)}${output}`;
}

function formatStatusCounts(members: readonly RunCompletionBatchMember[]): string {
  const counts = new Map<RunCompletionDeliveryStatus, number>();
  for (const member of members) {
    counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
  }
  return (["done", "failed", "killed", "exited"] as const)
    .filter((status) => counts.has(status))
    .map((status) => `${status}=${counts.get(status)}`)
    .join(" ");
}

function completionOmissionField(chars: number, direct: boolean): [string, string] {
  return direct ? ["omitted", `${chars} chars`] : ["omission", `[omitted: ${chars} chars]`];
}

function axCompletionExcerpt(preview: string, coverage: Pick<RunResultDiagnosticPacketExcerpt,
  "chars_shown" | "chars_total" | "chars_omitted" | "bytes_total" | "shown_bytes" | "truncated">, directOmission = false): string[] {
  return [
    formatMarkdownField("state", coverage.truncated ? "clipped" : "complete retained text"),
    formatMarkdownField("chars_shown", String(coverage.chars_shown)), formatMarkdownField("chars_total", String(coverage.chars_total)),
    formatMarkdownField("utf8_range", `[${coverage.shown_bytes.start}, ${coverage.shown_bytes.end}) / ${coverage.bytes_total}`),
    formatMarkdownField("preview", (coverage.shown_bytes.start > 0 ? "…\n" : "") + formatLiteralBlock(preview) +
      (coverage.shown_bytes.end < coverage.bytes_total ? "\n…" : "")),
    ...(coverage.chars_omitted > 0 ? [formatMarkdownField(...completionOmissionField(coverage.chars_omitted, directOmission))] : []),
  ];
}

function formatRetainedCompletionMember(member: RunCompletionBatchMember, byIdentity: Map<string, RunCompletionBatchMember>, batchLegacyBasis = false): string {
  const run = member.run.startsWith("run:") ? member.run.slice(4) : member.run;
  // Keep the existing 200 UTF-16 display allowance, without normalizing opaque Markdown or leaking legacy tail lengths.
  let summary = member.summary;
  if (summary.length > 200) {
    let end = 199;
    if (/[\uD800-\uDBFF]/u.test(summary[end - 1]) && /[\uDC00-\uDFFF]/u.test(summary[end])) end--;
    summary = summary.slice(0, end) + "…";
  }
  const fields = [formatMarkdownField("run", run), formatMarkdownField("state", member.status), formatMarkdownField("summary", summary),
    ...(member.summary.length > 200 ? [formatMarkdownField("summary_omission", "[omitted: unknown]")] : []),
    ...(batchLegacyBasis ? [] : [formatMarkdownField("legacy_basis", "Recorded summary/output; original completeness/privacy unproven."),
      formatMarkdownField("legacy_upstream", "[omitted: unknown]")])];
  if (member.parent_state_dir && member.parent_run_instance_id) {
    const parent = byIdentity.get(`${member.parent_state_dir}\0${member.parent_run_instance_id}`);
    if (parent && parent.run === member.parent_run) fields.push(formatMarkdownField("parent_run", parent.run.startsWith("run:") ? parent.run.slice(4) : parent.run));
  }
  const primary = member.primary_text;
  if (primary) fields.push(formatMarkdownField("primary", primary.output ? [
    formatMarkdownField("scope", "Exported primary text at capture; admission privacy, not complete Actor output."),
    ...axCompletionExcerpt(primary.output.preview, primary.output),
    ...(primary.output.redacted ? [formatMarkdownField("redacted", "true")] : []),
    formatMarkdownField("source", formatLiteralBlock(JSON.stringify(primary.output.source, null, 2))),
  ].join("\n") : [formatMarkdownField("state", "unavailable"), formatMarkdownField("reason", primary.output_unavailable)].join("\n")));
  if (member.artifact_inventory) {
    const inventory = member.artifact_inventory;
    fields.push(formatMarkdownField("artifact_inventory", [formatMarkdownField("declarations", String(inventory.declarations_total)),
      formatMarkdownField("scope", "Metadata only; target availability/production not asserted; bodies not read."),
      formatMarkdownField("source", formatLiteralBlock(JSON.stringify({ ...inventory.source, bytes_total: inventory.bytes_total,
        declarations_total: inventory.declarations_total }, null, 2)))].join("\n")));
  } else if (member.artifact_inventory === null && member.artifact_inventory_unavailable !== "not_declared") {
    fields.push(formatMarkdownField("artifact_inventory", [formatMarkdownField("state", "unavailable"),
      formatMarkdownField("reason", member.artifact_inventory_unavailable!), formatMarkdownField("warning", "no legacy path fallback")].join("\n")));
  }
  const artifacts = Object.entries(member.artifacts ?? {});
  if (artifacts.length) fields.push(formatMarkdownField("artifacts", [formatMarkdownField("scope", "Declared paths; existence/production unproven."),
    ...artifacts.map(([name, path]) => formatMarkdownField("artifact",
      [formatMarkdownField("name", name), formatMarkdownField("path", formatLiteralBlock(JSON.stringify(path)))].join("\n")))].join("\n")));
  if (member.result_diagnostics) {
    const reference = member.result_diagnostics, excerpt = member.diagnostic_excerpt;
    const others = reference.fields.filter(field => field !== excerpt?.field);
    fields.push(formatMarkdownField("diagnostic_metadata", [
      formatMarkdownField("scope", "Diagnostic metadata only; not primary output; admission privacy for recorded fields."),
      ...(excerpt ? [formatMarkdownField("field", excerpt.field), ...axCompletionExcerpt(excerpt.text, excerpt)] : []),
      ...(others.length ? [formatMarkdownField("recorded_fields_not_shown", others.join(", "))] : []),
      formatMarkdownField("source", formatLiteralBlock(JSON.stringify({ ...reference.source, bytes_total: reference.bytes_total, fields: reference.fields }, null, 2))),
    ].join("\n")));
  } else if (member.result_diagnostics === null && member.result_diagnostics_unavailable !== "not_recorded") {
    fields.push(formatMarkdownField("diagnostic_metadata", [formatMarkdownField("state", "unavailable"),
      formatMarkdownField("reason", member.result_diagnostics_unavailable!), formatMarkdownField("warning", "no legacy body fallback")].join("\n")));
  }
  if (member.output) {
    if (primary) fields.push(formatMarkdownField("output_scope", "Legacy diagnostic display (not a complete primary source)"));
    fields.push(formatMarkdownField("output", member.output));
  }
  return fields.join("\n");
}

export interface RunCompletionPresentation {
  readonly format: "ax_records" | "ax_records_v3" | "completion_frontmatter_v1";
  readonly blocks?: readonly CompletionBlock[];
  readonly content_sha256: string;
  /** UTF-16 offsets in the exact content, not UTF-8 byte or source excerpt ranges. */
  readonly compact_ranges: readonly (readonly [number, number])[];
}

function completionRecordHeader(content: string): { format: string; single: boolean; length: number } | undefined {
  const single = /^- completion: [^\r\n\u2028\u2029]{1,128}\n- presentation: (ax_records)\n/u.exec(content);
  const match = single ?? /^- completions: [1-9]\d{0,2}\n- batch: [^\r\n\u2028\u2029]{1,128}\n- presentation: (ax_records(?:_v3)?)\n/u.exec(content);
  return match ? { format: match[1]!, single: single !== null, length: match[0].length } : undefined;
}

function formatCompletionRecordMarker(batchId: string): string {
  const literal = JSON.stringify(batchId).replaceAll(/[<>\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<!-- pi-actors:completion ${literal} -->`;
}

function completionStreamBoundary(streamId: string): string {
  return `— Новый поток ${streamId} · отсчёт с #0 —`;
}

function completionNumberingTechnical(numbering: RunCompletionNumbering): string {
  return formatMarkdownField("technical", formatLiteralBlock(JSON.stringify({ completion_numbering: numbering })));
}

function readCompletionNumberingFrame(content: string, markerStart: number): RunCompletionNumbering | { malformed: true } | undefined {
  const match = /\n- technical:\n  (`{3,})text\n  ([^\r\n]*)\n  \1$/u.exec(content.slice(0, markerStart));
  if (!match) return undefined;
  let data: Record<string, unknown>;
  try { data = JSON.parse(match[2]!); } catch { return undefined; }
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "completion_numbering")) return undefined;
  try {
    const raw = asRecord(data.completion_numbering, "Completion numbering"), order = raw.member_order;
    if (Object.keys(data).length !== 1 || !Array.isArray(order) || order.length < 1 || order.length > Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS) return { malformed: true };
    const numbering = parseCompletionNumbering(raw, order.length);
    return completionNumberingTechnical(numbering) === match[0].slice(1) ? numbering : { malformed: true };
  } catch { return { malformed: true }; }
}

/** Compiler-bound correlation data, not authentication or permission. Body equality cannot identify an epoch. */
export function readRunCompletionRecordMarker(content: string): { batchId: string; start: number; single: boolean; headers?: true } | undefined {
  if (Buffer.byteLength(content, "utf8") > Limits.RUN_COMPLETION_MODEL_MAX_BYTES) return undefined;
  const fresh = readFrontmatterFrame(content);
  if (fresh) return { batchId: fresh.batchId, start: fresh.markerStart, single: false, headers: true };
  const boundary = /^— Новый поток ([^\r\n]+) · отсчёт с #0 —\n/u.exec(content);
  const body = boundary ? content.slice(boundary[0].length) : content;
  const numbered = /^#(\?|0|[1-9]\d{0,15}):\n/u.exec(body);
  const headers = content.startsWith("#0:\n") || content.startsWith("Run #0:\n");
  const single = content.startsWith("- run:") || content.startsWith("- result: omitted (model byte limit)\n");
  if (!boundary && !numbered && !headers && !single && !/^- #0:\n|^- omitted_results: [1-9]\d{0,2}\n/u.test(content)) return undefined;
  const match = /\n<!-- pi-actors:completion ("[^\r\n]{0,768}") -->$/u.exec(content);
  if (!match) return undefined;
  try {
    const batchId: unknown = JSON.parse(match[1]!);
    if (typeof batchId !== "string" || !batchId.trim() || batchId.length > 128 || formatCompletionRecordMarker(batchId) !== match[0].slice(1)) return undefined;
    const frame = readCompletionNumberingFrame(content, match.index);
    if (frame && "malformed" in frame) return undefined;
    if (frame) {
      const startsStream = frame.kind === "stream" && frame.first_index === 0;
      if (startsStream !== !!boundary || (boundary && completionStreamBoundary(frame.stream_id!) + "\n" !== boundary[0])) return undefined;
      const expected = frame.kind === "stream" ? String(frame.first_index) : "?";
      if (numbered ? numbered[1] !== expected : !body.startsWith(`- omitted_results: ${frame.member_order.length}\n`)) return undefined;
      return { batchId, start: match.index, single: false, headers: true };
    }
    if (boundary || (numbered && numbered[1] !== "0")) return undefined;
    return { batchId, start: match.index, single, ...(headers ? { headers: true as const } : {}) };
  } catch { return undefined; }
}

export type CompletionBlock = readonly [kind: "header" | "body" | "marker" | "service", start: number, end: number];
type CompletionPiece = { text: string; compact: boolean; block?: CompletionBlock[0]; field?: readonly [string, string] };
type CompletionRow = { pieces: CompletionPiece[]; technical: string; technical_data: Record<string, unknown>; legacy: boolean;
  completion_text?: Readonly<RunCompletionText> };

function completionPiece(key: string, value: string, depth = 0, compact = true): CompletionPiece {
  return { text: formatMarkdownField(key, value, depth), compact, field: [key, value] };
}

function completionPreview(value: string, depth: number, before: boolean, after: boolean, field = "preview"): CompletionPiece[] {
  const indent = "  ".repeat(depth), opening = formatLiteralBlock(value).split("\n", 1)[0]!;
  return [
    { text: `${indent}- ${field}:${before ? `\n${indent}  …` : ""}`, compact: true },
    { text: `${indent}  ${opening}`, compact: false },
    { text: `${indent}  ${value.replaceAll(/\r\n|\r|\n/gu, newline => `${newline}${indent}  `)}`, compact: true },
    { text: `${indent}  ${opening.slice(0, -4)}`, compact: false },
    ...(after ? [{ text: `${indent}  …`, compact: true }] : []),
  ];
}

function completionCoverage(value: Pick<RunResultDiagnosticPacketExcerpt,
  "chars_shown" | "chars_total" | "chars_omitted" | "bytes_total" | "shown_bytes" | "truncated">) {
  return { state: value.truncated ? "clipped" : "complete retained text", chars_shown: value.chars_shown,
    chars_total: value.chars_total, utf8_range: `[${value.shown_bytes.start}, ${value.shown_bytes.end}) / ${value.bytes_total}` };
}

function isRoutineCompletionSummary(member: RunCompletionBatchMember): boolean {
  return member.summary === (member.status === "done" ? "Run completed." : `Run ${member.status}.`);
}

function completionRecordRow(member: RunCompletionBatchMember, index: number, byIdentity: Map<string, RunCompletionBatchMember>, flat = false, layout?: RunCompletionBatch["result_layout"], textBudget?: number): CompletionRow {
  const frontmatter = isFrontmatterCompletionLayout(layout) || layout === "completion_yaml_core_v1";
  const simpleKinds = frontmatter || layout === "headings_shared_kinds", shared = isSharedCompletionLayout(layout);
  const outcomes = shared || layout === "headings_outcomes", directOmission = outcomes || layout === "headings_flat_omissions";
  const run = member.run.startsWith("run:") ? member.run.slice(4) : member.run;
  const depth = flat ? 0 : 2;
  const pieces: CompletionPiece[] = [...(flat ? [] : [{ text: `  - #${index}:`, compact: true }]), completionPiece("run", run, depth), completionPiece("state", member.status, depth)];
  const technical: Record<string, unknown> = {};
  let primary = member.primary_text?.output;
  let diagnostic = outcomes && member.diagnostic_excerpt?.field === "command" ? undefined : member.diagnostic_excerpt;
  let completionText: Readonly<RunCompletionText> | undefined;
  if (shared && primary) {
    const captured = member.completion_text;
    const selected = projectRunCompletionText(captured?.text ?? primary.preview, textBudget!);
    const start = captured ? 0 : primary.shown_bytes.start, shown = [...selected.text].length;
    if (captured) completionText = selected;
    primary = { ...primary, preview: selected.text, shown_bytes: { start, end: start + selected.shown_bytes.end },
      chars_shown: shown, chars_omitted: primary.chars_total - shown, truncated: shown < primary.chars_total };
  } else if (shared && diagnostic) {
    const selected = projectRunCompletionText(diagnostic.text, textBudget!), shown = [...selected.text].length;
    diagnostic = { ...diagnostic, text: selected.text, shown_bytes: { start: diagnostic.shown_bytes.start,
      end: diagnostic.shown_bytes.start + selected.shown_bytes.end }, chars_shown: shown,
      chars_omitted: diagnostic.chars_total - shown, truncated: shown < diagnostic.chars_total };
  }
  const kind = primary ? primary.text_basis === "actor_response" ? "response" : "primary" : diagnostic ? "diagnostic" : member.output ? "legacy" : undefined;
  const boilerplate = isRoutineCompletionSummary(member);
  let legacy = !!member.output;
  if (!boilerplate) {
    legacy = true;
    let end = Math.min(member.summary.length, 200);
    if (member.summary.length > 200) {
      end = 199;
      if (/[\uD800-\uDBFF]/u.test(member.summary[end - 1]!) && /[\uDC00-\uDFFF]/u.test(member.summary[end]!)) end--;
    }
    const summary = member.summary.slice(0, end);
    if (frontmatter) pieces.push({ text: Buffer.from(summary).toString("utf8") === summary ? summary : "Summary unavailable (malformed retained text)", compact: true, block: "body" });
    else {
      pieces.push(completionPiece("summary", Buffer.from(summary).toString("utf8") === summary
        ? summary + (end < member.summary.length ? "…" : "") : "unavailable (malformed retained text)", depth));
      if (end < member.summary.length || Buffer.from(summary).toString("utf8") !== summary) pieces.push(completionPiece("summary_omission", "[omitted: unknown]", depth));
    }
  }
  const chosen = primary ?? diagnostic;
  const legacyText = shared && member.output && Buffer.from(member.output).toString("utf8") === member.output
    ? projectRunCompletionText(member.output, textBudget!).text : member.output;
  const value = primary?.preview ?? diagnostic?.text ?? legacyText;
  if (kind && value !== undefined) {
    if (!simpleKinds || kind !== "legacy") {
      pieces.push(completionPiece(simpleKinds ? "kind" : shared ? "result_kind" : "preview_kind",
        simpleKinds && kind === "response" ? "primary" : kind, depth));
    }
    if (diagnostic && !primary) {
      technical.preview_field = diagnostic.field;
      if (outcomes) pieces.push(completionPiece("preview_field", diagnostic.field, depth));
    }
    if (Buffer.from(value).toString("utf8") !== value) {
      pieces.push(frontmatter ? { text: "[omitted: unknown] (malformed retained text)", compact: true, block: "marker" }
        : completionPiece("preview_unavailable", "malformed retained text [omitted: unknown]", depth));
    } else {
      if (frontmatter) {
        if (chosen && chosen.shown_bytes.start > 0) pieces.push({ text: "[omitted: unknown] (retained excerpt starts after the source boundary)", compact: true, block: "marker" });
        pieces.push({ text: value, compact: true, block: "body" });
        if (chosen && chosen.chars_omitted > 0) pieces.push({ text: `[${chosen.chars_omitted} characters omitted]`, compact: true, block: "marker" });
      } else {
        const complete = shared && primary && primary.shown_bytes.start === 0 && primary.shown_bytes.end === primary.bytes_total && !primary.upstream_truncated;
        pieces.push(...completionPreview(value, depth, !!chosen && chosen.shown_bytes.start > 0,
          !!chosen && chosen.shown_bytes.end < chosen.bytes_total, complete ? "result" : "preview"));
        if (shared && kind === "legacy" && member.output && value !== member.output) pieces.push(completionPiece(simpleKinds ? "text_omission" : "legacy_omission", "[omitted: unknown]", depth));
        if (chosen && chosen.chars_omitted > 0) pieces.push(completionPiece(...completionOmissionField(chosen.chars_omitted, directOmission), depth));
      }
    }
    if (primary?.redacted) pieces.push(completionPiece("redacted", "true", depth));
    if (outcomes && primary?.upstream_truncated) pieces.push(frontmatter
      ? { text: "[omitted: unknown] (upstream completeness unproven)", compact: true, block: "marker" }
      : completionPiece("upstream_omission", "[omitted: unknown]", depth));
  } else pieces.push(completionPiece(shared ? "result_state" : "preview_state", "not captured", depth));
  if (member.parent_state_dir && member.parent_run_instance_id) {
    const parent = byIdentity.get(`${member.parent_state_dir}\0${member.parent_run_instance_id}`);
    if (parent && parent.run === member.parent_run) pieces.push(completionPiece("parent_run", parent.run.startsWith("run:") ? parent.run.slice(4) : parent.run, depth));
  }
  if (member.primary_text) {
    if (primary) technical.primary = { scope: primary.text_basis === "actor_response"
      ? "Executor-selected final Actor response at capture; admission privacy; prior stream clipping remains separate."
      : "Exported primary text at capture; admission privacy, not complete Actor output.",
      ...(primary.text_basis ? { text_basis: primary.text_basis, upstream_truncated: primary.upstream_truncated } : {}),
      ...completionCoverage(primary), ...(primary.redacted ? { redacted: true } : {}), source: primary.source };
    else if (!member.primary_text.output) pieces.push(completionPiece("primary_unavailable", member.primary_text.output_unavailable, depth));
  }
  if (member.result_diagnostics) {
    const reference = member.result_diagnostics;
    technical.diagnostic_metadata = { scope: "Diagnostic metadata only; not primary output; admission privacy for recorded fields.",
      ...(diagnostic ? { field: diagnostic.field, ...completionCoverage(diagnostic) } : {}),
      recorded_fields_not_shown: reference.fields.filter(field => field !== diagnostic?.field),
      source: { ...reference.source, bytes_total: reference.bytes_total, fields: reference.fields } };
    if (primary && diagnostic) technical.secondary_diagnostic_excerpt = axCompletionExcerpt(diagnostic.text, diagnostic, directOmission).join("\n");
  } else if (member.result_diagnostics === null && member.result_diagnostics_unavailable !== "not_recorded") {
    pieces.push(completionPiece("diagnostic_metadata_unavailable", member.result_diagnostics_unavailable!, depth));
    technical.diagnostic_warning = "no legacy body fallback";
  }
  if (member.artifact_inventory) {
    const inventory = member.artifact_inventory;
    pieces.push(completionPiece("artifact_declarations", String(inventory.declarations_total), depth));
    technical.artifact_inventory = { scope: "Metadata only; target availability/production not asserted; bodies not read.",
      source: { ...inventory.source, bytes_total: inventory.bytes_total, declarations_total: inventory.declarations_total } };
  } else if (member.artifact_inventory === null && member.artifact_inventory_unavailable !== "not_declared") {
    pieces.push(completionPiece("artifact_inventory_unavailable", member.artifact_inventory_unavailable!, depth));
    technical.artifact_warning = "no legacy path fallback";
  }
  const artifacts = Object.entries(member.artifacts ?? {});
  if (artifacts.length) {
    pieces.push(completionPiece("artifact_declarations", String(artifacts.length), depth));
    technical.artifacts = { scope: "Declared paths; existence/production unproven.", declarations: artifacts.map(([name, path]) => ({ name, path })) };
  }
  return { pieces, technical: Object.keys(technical).length ? formatMarkdownField(flat ? "result_details" : `#${index}`, formatLiteralBlock(JSON.stringify(technical, null, 2))) : "", technical_data: technical, legacy, ...(completionText ? { completion_text: completionText } : {}) };
}

const FRONTMATTER_FRAME = "<!-- pi-actors:frontmatter ";

function readFrontmatterFrame(content: string): { blocks: readonly CompletionBlock[]; batchId: string; markerStart: number } | undefined {
  try {
    if (Buffer.byteLength(content) > Limits.RUN_COMPLETION_MODEL_MAX_BYTES) return undefined;
    const match = /\n<!-- pi-actors:frontmatter ([^\r\n]+) -->\n<!-- pi-actors:completion ("[^\r\n]+") -->$/u.exec(content);
    if (!match) return undefined;
    const frame = JSON.parse(match[1]!), batchId = JSON.parse(match[2]!);
    if (typeof batchId !== "string" || !batchId.trim() || batchId.length > 128 || formatCompletionRecordMarker(batchId) !== `<!-- pi-actors:completion ${match[2]} -->`) return undefined;
    if (frontmatterJson(frame) !== match[1] || Object.keys(frame).sort().join() !== (frame.numbering ? "blocks,numbering,prefix_sha256" : "blocks,prefix_sha256")) return undefined;
    const prefix = content.slice(0, match.index);
    if (frame.prefix_sha256 !== createHash("sha256").update(prefix).digest("hex") || !Array.isArray(frame.blocks)) return undefined;
    let previous = 0, rows = 0, inRow = false;
    const numbering = frame.numbering ? parseCompletionNumbering(frame.numbering, frame.numbering.member_order.length) : undefined;
    const startsStream = numbering?.kind === "stream" && numbering.first_index === 0;
    if (startsStream && (frame.blocks[0]?.[0] !== "service" || content.slice(frame.blocks[0][1], frame.blocks[0][2]) !== completionStreamBoundary(numbering.stream_id))) return undefined;
    const boundary = (n: number) => !(n > 0 && n < content.length && /[\uD800-\uDBFF]/u.test(content[n - 1]!) && /[\uDC00-\uDFFF]/u.test(content[n]!)) && !(content[n - 1] === "\r" && content[n] === "\n");
    for (const block of frame.blocks) {
      if (!Array.isArray(block) || block.length !== 3) return undefined;
      const [kind, start, end] = block;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== previous + (previous ? kind === "header" ? 2 : 1 : 0) || end < start || end > prefix.length || !boundary(start) || !boundary(end)) return undefined;
      if (content.slice(previous, start) !== (previous ? kind === "header" ? "\n\n" : "\n" : "")) return undefined;
      const text = content.slice(start, end);
      if (kind === "header") {
        const expected = numbering ? numbering.kind === "stream" ? numbering.first_index + rows : "?" : rows;
        if (!(text.startsWith(`---\nindex: ${expected}\nrun: `) || expected === "?" && text.startsWith('---\nindex: "?"\nrun: ')) || !text.endsWith("\n---\n")) return undefined;
        const lines = text.slice(4, -5).split("\n");
        if (!/^state: (done|failed|killed|exited)$/u.test(lines[2] ?? "")) return undefined;
        const keys = new Set<string>();
        for (const line of lines) {
          const field = /^([a-z_]+): (.+)$/u.exec(line);
          if (!field || keys.has(field[1]!) || !/^(?:index|run|state|kind|preview_field|redacted|result_state|parent_run|primary_unavailable|diagnostic_metadata_unavailable|artifact_declarations|artifact_inventory_unavailable|run_files_unavailable|references|run_files)$/u.test(field[1]!)) return undefined;
          if (field[1] === "kind" && (keys.size !== 3 || !/^(?:primary|diagnostic)$/u.test(field[2]!))) return undefined;
          keys.add(field[1]!);
          const value = field[2]!;
          if (!/^(?:[a-z][a-z0-9_-]*|\?|\d+)$/u.test(value) && frontmatterJson(JSON.parse(value)) !== value) return undefined;
        }
        rows++; inRow = true;
      } else if (kind === "body") { if (!inRow) return undefined; }
      else if (kind === "marker") {
        if (!inRow || !/^(?:\[[1-9]\d* characters omitted\]|\[omitted: unknown\] \((?:retained excerpt starts after the source boundary|upstream completeness unproven|summary\/fallback text: original completeness\/privacy unproven|malformed retained text)\)|Run-file reference omitted \(packet byte limit\)\.)$/u.test(text)) return undefined;
      } else if (kind === "service") {
        if (!(text === (numbering?.kind === "stream" && numbering.first_index === 0 ? completionStreamBoundary(numbering.stream_id) : "") || /^- (?:omitted_results|omitted_states|inventory_warning|numbering_unavailable|result_inventory): /u.test(text) || text.startsWith("- omitted_states:\n"))) return undefined;
        inRow = false;
      } else return undefined;
      previous = end;
    }
    if (previous !== prefix.length || rows > Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS) return undefined;
    return { blocks: frame.blocks, batchId, markerStart: content.lastIndexOf("\n<!-- pi-actors:completion ") };
  } catch { return undefined; }
}

function frontmatterJson(value: unknown): string {
  return JSON.stringify(value).replaceAll(/[<>\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** All prefix bytes belong to a visible block. Only this closed compiler footer can be hidden. */
function assembleFrontmatter(safe: RunCompletionBatch, candidates: readonly { row: CompletionRow; location?: CompletionPiece }[], references: ReadonlySet<number>, ordered: readonly RunCompletionBatchMember[]) {
  let message = "";
  const blocks: CompletionBlock[] = [];
  const add = (kind: CompletionBlock[0], text: string) => {
    if (message) message += kind === "header" ? "\n\n" : "\n";
    const start = message.length; message += text;
    blocks.push(Object.freeze([kind, start, message.length]));
  };
  if (safe.numbering?.kind === "stream" && safe.numbering.first_index === 0) add("service", completionStreamBoundary(safe.numbering.stream_id));
  for (const [index, { row, location }] of candidates.entries()) {
    const displayed = safe.numbering ? safe.numbering.kind === "stream" ? safe.numbering.first_index + index : "?" : index;
    const fields = row.pieces.filter(piece => !piece.block);
    const technical = { ...row.technical_data };
    for (const key of ["primary", "diagnostic_metadata"]) {
      if (!technical[key]) continue;
      const detail = { ...technical[key] as Record<string, unknown> };
      for (const field of ["state", "chars_shown", "chars_total", "utf8_range", "upstream_truncated"]) {
        delete detail[field];
      }
      technical[key] = detail;
    }
    if (Object.hasOwn(technical, "secondary_diagnostic_excerpt")) {
      delete technical.secondary_diagnostic_excerpt;
    }
    const yaml = fields.map(piece => {
      if (!piece.field) throw new Error("Completion frontmatter field is invalid");
      const [key, value] = piece.field;
      return `${key}: ${/^[a-z][a-z0-9_-]*$/u.test(value) && !/^(?:null|true|false|yes|no|on|off)$/iu.test(value) ? value : frontmatterJson(value)}`;
    });
    if (Object.keys(technical).length) yaml.push(`references: ${frontmatterJson(technical)}`);
    if (references.has(index) && location) {
      const navigation = safe.file_navigation!.find(item => safe.members[item.member_index] === ordered[index])!;
      yaml.push(`run_files: ${frontmatterJson({ run: ordered[index]!.run, run_instance_id: ordered[index]!.run_instance_id, locations: navigation.locations })}`);
    }
    const yamlIndex = displayed === "?" && safe.result_layout === "frontmatter_v2" ? frontmatterJson(displayed) : displayed;
    add("header", `---\nindex: ${yamlIndex}\n${yaml.join("\n")}\n---\n`);
    for (const piece of row.pieces) if (piece.block) add(piece.block, piece.text);
    if (safe.file_navigation !== undefined && !references.has(index)) add("marker", "Run-file reference omitted (packet byte limit).");
  }
  const omitted = safe.members.length - candidates.length;
  if (omitted) {
    add("service", `- omitted_results: ${omitted}`);
    const states = (["failed", "killed", "exited"] as const).flatMap(status => {
      const count = ordered.slice(candidates.length).filter(member => member.status === status).length;
      return count ? [`  - ${status}: ${count}`] : [];
    });
    if (states.length) add("service", "- omitted_states:\n" + states.join("\n"));
    if (!safe.inventory_source) add("service", "- inventory_warning: No inventory reference is retained in this packet.");
  }
  if (safe.numbering?.kind === "unavailable") add("service", `- numbering_unavailable: ${safe.numbering.reason}`);
  if (safe.inventory_source) add("service", `- result_inventory: ${frontmatterJson(safe.inventory_source)}`);
  const frame = { blocks, prefix_sha256: createHash("sha256").update(message).digest("hex"), ...(safe.numbering ? { numbering: safe.numbering } : {}) };
  message += `\n${FRONTMATTER_FRAME}${frontmatterJson(frame)} -->\n${formatCompletionRecordMarker(safe.batch_id)}`;
  return { message, membersShown: candidates.length, blocks: Object.freeze(blocks), compact_ranges: blocks.map(([, a, b]) => [a, b] as [number, number]) };
}

type CompletionYamlProjectionReason = "invalid_snapshot" | "unsupported_source_class" | "unsupported_selected_data" | "overbudget" | "compatibility_refused";
class CompletionYamlProjectionRefusal extends Error {
  readonly reason: CompletionYamlProjectionReason;
  constructor(reason: CompletionYamlProjectionReason) { super(reason); this.reason = reason; }
}

// Only invoked at known metadata string slots; never on body text or arbitrary user objects.
function completionYamlString(value: string): CompletionYamlData {
  if (value.isWellFormed()) return value;
  return { utf16_code_units: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index).toString(16).padStart(4, "0")).join(" ") };
}

function completionYamlReferences(row: CompletionRow): Record<string, CompletionYamlData> {
  const technical = { ...row.technical_data } as Record<string, CompletionYamlData>;
  for (const key of ["primary", "diagnostic_metadata"]) {
    if (!technical[key]) continue;
    const detail = { ...technical[key] as Record<string, CompletionYamlData> };
    for (const field of ["state", "chars_shown", "chars_total", "utf8_range", "upstream_truncated"]) delete detail[field];
    technical[key] = detail;
  }
  delete technical.secondary_diagnostic_excerpt;
  for (const key of ["primary", "diagnostic_metadata", "artifact_inventory"]) {
    const detail = technical[key] as Record<string, CompletionYamlData> | undefined;
    if (!detail) continue;
    const source = { ...detail.source as Record<string, CompletionYamlData> };
    for (const slot of ["path", "run_instance_id", "sha256"]) {
      if (typeof source[slot] === "string") source[slot] = completionYamlString(source[slot]);
    }
    technical[key] = { ...detail, source };
  }
  const artifacts = technical.artifacts as { scope: string; declarations: { name: string; path: string }[] } | undefined;
  if (artifacts) technical.artifacts = { scope: artifacts.scope, declarations: artifacts.declarations.map(item => ({
    name: completionYamlString(item.name), path: completionYamlString(item.path),
  })) };
  return technical;
}

type PreparedCompletionYamlProjection =
  | { state: "unsupported" }
  | { state: "overbudget" }
  | { state: "prepared"; bytes: number; chunks: string[]; packet: CompletionYamlPacket };

function prepareCompletionYamlProjection(safe: RunCompletionBatch, candidates: readonly { row: CompletionRow; location?: CompletionPiece }[],
  references: ReadonlySet<number>, ordered: readonly RunCompletionBatchMember[]): PreparedCompletionYamlProjection {
  const packet: CompletionYamlPacket = { batchId: safe.batch_id, records: [] };
  if (!safe.batch_id.isWellFormed()) return { state: "unsupported" };
  for (const [index, { row, location }] of candidates.entries()) {
    const member = ordered[index]!;
    const displayed = safe.numbering ? safe.numbering.kind === "stream" ? safe.numbering.first_index + index : "?" : index;
    const metadata: Record<string, CompletionYamlData> = { index: displayed };
    for (const piece of row.pieces) {
      if (piece.block) continue;
      if (!piece.field) return { state: "unsupported" };
      const [key, value] = piece.field;
      if (["run", "state", "kind"].includes(key)) {
        if (!value.isWellFormed() || !value.length || (key === "kind" && value !== "primary" && value !== "diagnostic")) return { state: "unsupported" };
        metadata[key] = value;
      } else if (key === "redacted") metadata[key] = true;
      else if (key === "artifact_declarations") metadata[key] = member.artifact_inventory?.declarations_total ?? Object.keys(member.artifacts ?? {}).length;
      else metadata[key] = completionYamlString(value);
    }
    const technical = completionYamlReferences(row);
    if (Object.keys(technical).length) metadata.references = technical;
    if (references.has(index) && location) {
      const navigation = safe.file_navigation!.find(item => safe.members[item.member_index] === member)!;
      // Navigation is already decoded native data, not the JSON display field.
      const locations = navigation.locations;
      metadata.run_files = { run: completionYamlString(member.run), run_instance_id: completionYamlString(member.run_instance_id),
        locations: locations.state === "available" ? { ...locations, run: completionYamlString(locations.run),
          run_instance_id: completionYamlString(locations.run_instance_id), directory: completionYamlString(locations.directory),
          files: locations.files.map(file => ({ ...file, ...(typeof file.path === "string" ? { path: completionYamlString(file.path) } : {}) })) } as CompletionYamlData
          : { ...locations } };
    }
    const parts: CompletionYamlPart[] = [];
    const add = (part: CompletionYamlPart) => { if (parts.length) parts.push({ marker: "\n" }); parts.push(part); };
    for (const piece of row.pieces) if (piece.block) {
      if (!piece.text.isWellFormed()) return { state: "unsupported" };
      add(piece.block === "body" ? { body: piece.text } : { marker: piece.text });
    }
    if (safe.file_navigation !== undefined && !references.has(index)) add({ marker: "Run-file reference omitted (packet byte limit)." });
    packet.records.push({ metadata, parts });
  }
  const service: Record<string, CompletionYamlData> = {};
  const omitted = safe.members.length - candidates.length;
  if (omitted) {
    service.omitted_results = omitted;
    const states: Record<string, CompletionYamlData> = {};
    for (const status of ["failed", "killed", "exited"] as const) {
      const count = ordered.slice(candidates.length).filter(member => member.status === status).length;
      if (count) states[status] = count;
    }
    if (Object.keys(states).length) service.omitted_states = states;
    if (!safe.inventory_source) service.inventory_warning = "No inventory reference is retained in this packet.";
  }
  if (safe.numbering) {
    service.numbering = { ...safe.numbering, session_id: completionYamlString(safe.numbering.session_id), member_order: [...safe.numbering.member_order] };
    if (safe.numbering.kind === "unavailable") service.numbering_unavailable = safe.numbering.reason;
  }
  if (safe.inventory_source) service.result_inventory = { ...safe.inventory_source, path: completionYamlString(safe.inventory_source.path) };
  if (Object.keys(service).length) packet.service = service;
  const chunks: string[] = [];
  let bytes = 0;
  for (let index = 0; index < Math.max(1, packet.records.length); index++) {
    const row = packet.records[index];
    const bookkeeping: Record<string, CompletionYamlData> = index === 0 ? { codec: completionYamlCodec, batch_id: packet.batchId,
      ...(packet.service ? { service: packet.service } : {}) } : {};
    if (row?.parts.length) bookkeeping.parts = row.parts.map((part): CompletionYamlData => "body" in part ? { body: part.body.length } : { marker: part.marker.length });
    const header = { ...row?.metadata, ...(Object.keys(bookkeeping).length ? { _completion: bookkeeping } : {}) };
    const rendered = renderYamlMetadata(header, completionYamlMaxBytes);
    if (rendered.state !== "available") return { state: rendered.reason === "metadata_too_large" ? "overbudget" : "unsupported" };
    if (rendered.text.includes("\n\n")) return { state: "unsupported" };
    const framed = !!row?.parts.length;
    chunks.push(framed ? `---\n${rendered.text}---\n` : rendered.text);
    for (const part of row?.parts ?? []) chunks.push("body" in part ? part.body : part.marker);
    if (index + 1 < packet.records.length) chunks.push(framed ? "\n\n" : "\n");
  }
  for (const chunk of chunks) bytes += Buffer.byteLength(chunk, "utf8");
  return bytes > completionYamlMaxBytes ? { state: "overbudget" } : { state: "prepared", bytes, chunks, packet };
}

function materializeCompletionYamlProjection(prepared: PreparedCompletionYamlProjection) {
  if (prepared.state !== "prepared") throw new CompletionYamlProjectionRefusal(prepared.state === "overbudget" ? "overbudget" : "unsupported_selected_data");
  const message = prepared.chunks.join("");
  const encoded = encodeCompletionYamlCarrier(prepared.packet);
  if (encoded.state !== "available" || encoded.text !== message || readCompletionYamlCarrier(message).state !== "available") {
    throw new CompletionYamlProjectionRefusal("compatibility_refused");
  }
  return { message, membersShown: prepared.packet.records.length, compact_ranges: [] as [number, number][] };
}

/** Nondefault pure projection; neither a newly admitted Batch nor a rendering/acceptance grant. */
export function projectRunCompletionYamlPrototype(batch: unknown):
  | { state: "available"; content: string; presentation: { format: "completion_yaml_core_v1"; content_sha256: string }; membersShown: number; textBudget: number }
  | { state: "unavailable"; reason: CompletionYamlProjectionReason } {
  let safe: RunCompletionBatch;
  try { safe = parseBatch(batch); } catch { return { state: "unavailable", reason: "invalid_snapshot" }; }
  if (safe.presentation_format !== "ax_records" || safe.result_layout !== "frontmatter_v2") return { state: "unavailable", reason: "unsupported_source_class" };
  try {
    const projected = projectCompletionRecords(safe, "yaml");
    return { state: "available", content: projected.message, membersShown: projected.membersShown, textBudget: projected.textBudget!,
      presentation: { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(projected.message).digest("hex") } };
  } catch (error) {
    if (error instanceof CompletionYamlProjectionRefusal) return { state: "unavailable", reason: error.reason };
    throw error;
  }
}

function projectCompletionRecords(safe: RunCompletionBatch, assembler: "legacy" | "yaml" = safe.result_layout === "completion_yaml_core_v1" ? "yaml" : "legacy"): { message: string; membersShown: number; compact_ranges: [number, number][]; textBudget?: number; blocks?: readonly CompletionBlock[] } {
  const frontmatter = isFrontmatterCompletionLayout(safe.result_layout) || assembler === "yaml";
  const shared = isSharedCompletionLayout(safe.result_layout);
  const maxBytes = shared ? Limits.RUN_COMPLETION_MODEL_MAX_BYTES : Limits.RUN_DELIVERY_MODEL_MAX_BYTES;
  const headers = shared || safe.result_layout === "headings_outcomes" || safe.result_layout === "headings_flat_omissions" || safe.result_layout === "run_headers" || safe.result_layout === "headings", single = safe.members.length === 1;
  const numbering = safe.numbering, ordered = numbering ? numbering.member_order.map(slot => safe.members[slot]!) : orderRunCompletionMembers(safe.members);
  const byIdentity = new Map(safe.members.map(member => [memberIdentity(member), member]));
  const makeCandidates = (quota?: number) => ordered.slice(0, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS).map((member, index) => {
    const row = completionRecordRow(member, index, byIdentity, true, safe.result_layout, quota);
    const navigation = safe.file_navigation?.find(item => safe.members[item.member_index] === member);
    if (navigation?.locations.state === "unavailable") row.pieces.push(completionPiece("run_files_unavailable", navigation.locations.reason));
    if (row.legacy) row.pieces.push(frontmatter
      ? { text: "[omitted: unknown] (summary/fallback text: original completeness/privacy unproven)", compact: true, block: "marker" }
      : safe.result_layout === "headings_shared_kinds"
      ? completionPiece("warning", "Summary/fallback text: original completeness/privacy unproven [omitted: unknown]")
      : completionPiece("legacy_basis", "Summary/legacy output: original completeness/privacy unproven [omitted: unknown]"));
    const technical = Object.keys(row.technical_data).length ? completionPiece("technical", formatLiteralBlock(JSON.stringify(row.technical_data, null, 2)), 0, false) : undefined;
    const location = navigation ? completionPiece("run_files", formatLiteralBlock(JSON.stringify({ run: member.run,
      run_instance_id: member.run_instance_id, locations: navigation.locations })), 0, false) : undefined;
    const baseBytes = assembler === "yaml" ? 0 : Buffer.byteLength([...row.pieces, ...(technical ? [technical] : [])].map(piece => piece.text).join("\n"), "utf8");
    return { row, navigation, technical, location, baseBytes };
  });
  let candidates = makeCandidates(shared ? safe.text_budget ?? 0 : undefined);
  const assemble = (shown: number, references: ReadonlySet<number>) => {
    if (frontmatter) return assembleFrontmatter(safe, candidates.slice(0, shown), references, ordered);
    const pieces: CompletionPiece[] = [];
    if (numbering?.kind === "stream" && numbering.first_index === 0) pieces.push({ text: completionStreamBoundary(numbering.stream_id), compact: true });
    for (let index = 0; index < shown; index++) {
      const { row, technical, location } = candidates[index]!;
      const fields = [...row.pieces];
      if (safe.file_navigation !== undefined && !references.has(index)) fields.push(completionPiece("run_files_omitted", "1"));
      if (technical) fields.push(technical);
      if (references.has(index)) fields.push(location!);
      const displayed = numbering ? numbering.kind === "stream" ? numbering.first_index + index : "?" : index;
      if (headers) pieces.push({ text: `${index ? "\n" : ""}${safe.result_layout === "run_headers" ? "Run " : ""}#${displayed}:`, compact: true });
      else if (!single) pieces.push({ text: `- #${index}:`, compact: true });
      pieces.push(...fields.map(piece => headers || single ? piece : { ...piece, text: "  " + piece.text.replaceAll(/\r\n|\r|\n/gu, newline => `${newline}  `) }));
    }
    const omitted = safe.members.length - shown;
    if (omitted) {
      pieces.push(single && !headers ? completionPiece("result", "omitted (model byte limit)") : completionPiece("omitted_results", String(omitted)));
      const states = (["failed", "killed", "exited"] as const).flatMap(status => {
        const count = ordered.slice(shown).filter(member => member.status === status).length;
        return count ? [formatMarkdownField(status, String(count))] : [];
      });
      if (states.length) pieces.push({ text: "- omitted_states:\n" + states.map(line => "  " + line).join("\n"), compact: true });
      if (!safe.inventory_source) pieces.push(completionPiece("inventory_warning", "No inventory reference is retained in this packet."));
    }
    if (numbering?.kind === "unavailable") pieces.push(completionPiece("numbering_unavailable", numbering.reason));
    if (safe.inventory_source) pieces.push(completionPiece("result_inventory", formatLiteralBlock(JSON.stringify(safe.inventory_source, null, 2)), 0, false));
    if (numbering) pieces.push({ text: completionNumberingTechnical(numbering), compact: false });
    pieces.push({ text: formatCompletionRecordMarker(safe.batch_id), compact: false });
    let message = "";
    const compact_ranges: [number, number][] = [];
    for (const piece of pieces) {
      if (message) message += "\n";
      const start = message.length; message += piece.text;
      if (piece.compact) compact_ranges.push([start, message.length]);
    }
    return { message, membersShown: shown, compact_ranges };
  };
  // Closed second consumer: legacy assembly remains eager, with its original call order.
  const prepare = (count: number, refs: ReadonlySet<number>) => prepareCompletionYamlProjection(safe, candidates.slice(0, count), refs, ordered);
  const measure = (count: number, refs: ReadonlySet<number>): number => {
    if (assembler === "legacy") return Buffer.byteLength(assemble(count, refs).message, "utf8");
    const prepared = prepare(count, refs);
    if (prepared.state === "unsupported") throw new CompletionYamlProjectionRefusal("unsupported_selected_data");
    return prepared.state === "overbudget" ? Infinity : prepared.bytes;
  };
  if (assembler === "yaml") {
    // Validate selected facts even in rows that fitting may later omit.
    for (const [index, candidate] of candidates.entries()) {
      if (prepareCompletionYamlProjection(safe, [candidate], new Set([0]), [ordered[index]!]).state === "unsupported") {
        throw new CompletionYamlProjectionRefusal("unsupported_selected_data");
      }
    }
  }
  let shown = 0, textBudget = safe.text_budget;
  let references = new Set<number>();
  const fitPrefix = (): void => {
    let minimumBytes = 0;
    for (let count = 1; count <= candidates.length; count++) {
      minimumBytes += candidates[count - 1]!.baseBytes + (count > 1 ? 1 : 0);
      if (!frontmatter && minimumBytes > maxBytes) break;
      if (count > shown && measure(count, references) <= maxBytes) shown = count;
    }
  };
  fitPrefix();
  if (shared && textBudget === undefined) {
    const maximum = Math.floor(maxBytes / Math.max(1, candidates.length));
    const boundaries = [...new Set(ordered.slice(0, candidates.length).flatMap(member => {
      const output = member.primary_text?.output;
      const diagnostic = member.diagnostic_excerpt?.field === "command" ? undefined : member.diagnostic_excerpt;
      const tracked = output ?? diagnostic;
      const text = member.completion_text?.text ?? output?.preview ?? diagnostic?.text ?? member.output;
      const size = tracked?.bytes_total ?? (text === undefined ? undefined : Buffer.byteLength(text));
      const points = size !== undefined && size <= maximum ? [size] : [];
      // Two displayed omitted counts can shrink together at decimal boundaries.
      // Their scalar positions need byte coordinates, including a possible CRLF retraction.
      if (tracked && text !== undefined) for (let power = 10; power <= tracked.chars_total; power *= 10) {
        const count = tracked.chars_total - power + 1;
        if (count <= 0 || count > text.length) continue;
        const scalars = [...text]; if (count > scalars.length) continue;
        const end = Buffer.byteLength(scalars.slice(0, count).join("")) + (scalars[count - 1] === "\r" && scalars[count] === "\n" ? 1 : 0);
        if (end <= maximum) points.push(end);
      }
      return points;
    }))].sort((a, b) => a - b);
    // Completing a value removes omission scaffolding: check those discontinuities before omitting rows.
    for (const point of boundaries) {
      if (shown === candidates.length) break;
      candidates = makeCandidates(point); fitPrefix();
    }
    const fits = (quota: number): boolean => {
      candidates = makeCandidates(quota);
      return measure(shown, references) <= maxBytes;
    };
    let low = 0, high = maximum, best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    // Cost is monotone between these count/scaffolding discontinuities, not across them.
    for (let index = 0; index < boundaries.length; index++) {
      const point = boundaries[index]!;
      if (point <= best || !fits(point)) continue;
      best = point; low = point + 1; high = (boundaries[index + 1] ?? maximum + 1) - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (fits(middle)) { best = middle; low = middle + 1; } else high = middle - 1;
      }
    }
    textBudget = best; candidates = makeCandidates(best);
  }
  // Outcome rows have priority. References of wholly omitted results remain covered by their result omission/inventory.
  for (const item of safe.file_navigation ?? []) {
    const index = ordered.indexOf(safe.members[item.member_index]!);
    if (index >= shown) continue;
    const next = new Set(references); next.add(index);
    if (measure(shown, next) > maxBytes) break;
    references = next;
  }
  const result = assembler === "legacy" ? assemble(shown, references) : materializeCompletionYamlProjection(prepare(shown, references));
  if (Buffer.byteLength(result.message, "utf8") > maxBytes) throw new Error("Run completion batch header exceeds the model byte limit");
  return { ...result, ...(shared ? { textBudget } : {}) };
}
/** Freeze the share and selected text, not 64 independent 48KiB copies in the journal. */
function retainSharedCompletionTexts(batch: RunCompletionBatch): RunCompletionBatch {
  if (!isSharedCompletionLayout(batch.result_layout)) return batch;
  const projected = projectCompletionRecords({ ...batch, text_budget: undefined });
  const order = batch.numbering ? batch.numbering.member_order.map(slot => batch.members[slot]!) : orderRunCompletionMembers(batch.members);
  const selected = new Set(order.slice(0, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS));
  return parseBatch({ ...batch, text_budget: projected.textBudget, members: batch.members.map(member => {
    const { completion_text, ...rest } = member;
    return completion_text && selected.has(member)
      ? { ...rest, completion_text: projectRunCompletionText(completion_text.text, projected.textBudget!) } : rest;
  }) });
}


function projectRetainedRecordCompletionBatch(safe: RunCompletionBatch): { message: string; membersShown: number; compact_ranges: [number, number][] } {
  const single = safe.single_result === true;
  const ordered = orderRunCompletionMembers(safe.members), byIdentity = new Map(safe.members.map(member => [memberIdentity(member), member]));
  const times = safe.members.map(member => member.terminal_at).sort();
  const candidates = ordered.slice(0, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS).map((member, index) => {
    const row = completionRecordRow(member, index, byIdentity, single);
    const navigation = safe.file_navigation?.find(item => safe.members[item.member_index] === member);
    if (navigation?.locations.state === "unavailable") row.pieces.push(completionPiece("run_files_unavailable", navigation.locations.reason, single ? 0 : 2));
    return row;
  });
  const assemble = (rows: CompletionRow[], references: string[]) => {
    const pieces = single ? [completionPiece("completion", safe.batch_id, 0, false), completionPiece("presentation", "ax_records", 0, false)]
      : [completionPiece("completions", String(safe.members.length)), completionPiece("batch", safe.batch_id, 0, false),
      completionPiece("presentation", safe.presentation_format!, 0, false)];
    if (safe.members.length > 1) for (const status of ["done", "failed", "killed", "exited"] as const) {
      const count = safe.members.filter(member => member.status === status).length;
      if (count) pieces.push(completionPiece(`${status}_count`, String(count)));
    }
    if (!single && rows.some(row => row.legacy)) pieces.push(completionPiece("legacy_basis", "Summary/legacy output: original completeness/privacy unproven [omitted: unknown]"));
    if (rows.length) pieces.push(...(single ? [] : [{ text: "- members:", compact: true }]), ...rows.flatMap(row => row.pieces));
    if (single && rows.some(row => row.legacy)) pieces.push(completionPiece("legacy_basis", "Summary/legacy output: original completeness/privacy unproven [omitted: unknown]"));
    const omitted = safe.members.length - rows.length;
    if (omitted) {
      pieces.push(single ? completionPiece("result", "omitted (model byte limit)") : completionPiece("members_omitted", String(omitted)));
      if (!safe.inventory_source) pieces.push(completionPiece("inventory_warning", "No inventory reference is retained in this packet."));
    }
    const summaries = Object.fromEntries(ordered.slice(0, rows.length).filter(isRoutineCompletionSummary).map(member => [member.status, member.summary]));
    const technical = [formatMarkdownField("window_start", times[0]!), formatMarkdownField("window_end", times.at(-1)!),
      ...(Object.keys(summaries).length ? [formatMarkdownField("runtime_summaries", formatLiteralBlock(JSON.stringify(summaries)))] : []),
      ...(safe.inventory_source ? [formatMarkdownField("member_inventory", formatLiteralBlock(JSON.stringify(safe.inventory_source, null, 2)))] : []),
      ...(rows.some(row => row.technical) ? [(single ? rows[0]!.technical : formatMarkdownField("member_details", rows.map(row => row.technical).filter(Boolean).join("\n")))] : [])];
    if (safe.navigation_handoff !== undefined) technical.push(formatMarkdownField("file_investigation", "optional; current session"), formatInspectNextAction("runtime", "runs", true));
    if (safe.file_navigation !== undefined) {
      pieces.push(completionPiece("run_files_shown", String(references.length)), completionPiece("run_files_omitted", String(safe.members.length - references.length)));
      technical.push(formatMarkdownField("run_files", [formatMarkdownField("total", String(safe.members.length)),
        formatMarkdownField("scope", "Captured completion members only; mutable locations, not body/privacy/terminal proof."), ...references].join("\n")));
    }
    pieces.push(completionPiece("technical", technical.join("\n"), 0, false));
    let message = "";
    const compact_ranges: [number, number][] = [];
    for (const piece of pieces) {
      if (message) message += "\n";
      const start = message.length; message += piece.text;
      if (piece.compact) compact_ranges.push([start, message.length]);
    }
    return { message, membersShown: rows.length, compact_ranges };
  };
  const rows: CompletionRow[] = [], references: string[] = [];
  for (const candidate of candidates) {
    if (Buffer.byteLength(assemble([...rows, candidate], references).message, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) break;
    rows.push(candidate);
  }
  for (const item of safe.file_navigation ?? []) {
    const member = safe.members[item.member_index], index = ordered.indexOf(member);
    const row = formatMarkdownField(single ? "location" : `#${index}`, formatLiteralBlock(JSON.stringify({ run: member.run, run_instance_id: member.run_instance_id, locations: item.locations })));
    if (Buffer.byteLength(assemble(rows, [...references, row]).message, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) break;
    references.push(row);
  }
  const result = assemble(rows, references);
  if (Buffer.byteLength(result.message, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Run completion batch header exceeds the model byte limit");
  return result;
}

/** Single full model content plus compiler-owned UI offsets; no source reads or saved-packet mutation. */
export function projectRunCompletionBatchPresentation(batch: RunCompletionBatch): { content: string; presentation?: RunCompletionPresentation | { format: "completion_yaml_core_v1"; content_sha256: string } } {
  const safe = parseBatch(batch);
  if (safe.presentation_format !== "ax_records" && safe.presentation_format !== "ax_records_v3") return { content: projectCompletionBatchMessage(safe).message };
  const result = safe.result_layout !== undefined ? projectCompletionRecords(safe) : projectRetainedRecordCompletionBatch(safe);
  if (safe.result_layout === "completion_yaml_core_v1") return { content: result.message, presentation: Object.freeze({
    format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(result.message).digest("hex"),
  }) };
  return { content: result.message, presentation: Object.freeze({ format: isFrontmatterCompletionLayout(safe.result_layout) ? "completion_frontmatter_v1" : safe.presentation_format, content_sha256: createHash("sha256").update(result.message).digest("hex"),
    ...("blocks" in result ? { blocks: result.blocks as readonly CompletionBlock[] } : {}),
    compact_ranges: Object.freeze(result.compact_ranges.map(range => Object.freeze(range))) }) };
}

function completionRecordDetailsGap(value: string, single: boolean, terminal: boolean): boolean {
  let rest = value;
  while (rest !== (terminal ? "" : "\n")) {
    const opening = /^\n( *)- (technical|run_files|result_inventory):\n( *)(`{3,})text\n/u.exec(rest);
    if (!opening) return false;
    const [, indent, key, padding, fence] = opening;
    if (indent !== (key === "result_inventory" || single ? "" : "  ") || padding !== indent + "  ") return false;
    const ending = `\n${padding}${fence}`, end = rest.indexOf(ending, opening[0].length);
    if (end < 0) return false;
    const lines = rest.slice(opening[0].length, end).split("\n");
    if (lines.some(line => !line.startsWith(padding!))) return false;
    try {
      const data: unknown = JSON.parse(lines.map(line => line.slice(padding!.length)).join("\n"));
      if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    } catch { return false; }
    rest = rest.slice(end + ending.length);
  }
  return true;
}

/** Display consistency only, never provenance authentication or a new read/action capability. */
function readRunCompletionCompactText(content: string, value: unknown): string | undefined {
  try {
    if (Buffer.byteLength(content, "utf8") > Limits.RUN_COMPLETION_MODEL_MAX_BYTES) return undefined;
    const record = Object.getOwnPropertyDescriptors(value as object);
    if (Object.keys(record).sort().join() !== "compact_ranges,content_sha256,format" || Object.values(record).some(field => !Object.hasOwn(field, "value"))) return undefined;
    const header = completionRecordHeader(content), records = header ? undefined : readRunCompletionRecordMarker(content);
    if ((!header && !records) || record.format!.value !== (header?.format ?? "ax_records") || record.content_sha256!.value !== createHash("sha256").update(content).digest("hex")) return undefined;
    const flat = !!records && (records.single || !!records.headers);
    const indent = records ? (flat ? "  " : "    ") : header!.single ? "  " : "      ";
    const ranges = record.compact_ranges!.value;
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > content.length || Object.keys(ranges).length !== ranges.length) return undefined;
    const text: string[] = []; let previous = 0, fence: string | undefined;
    const boundary = (index: number) => !(index > 0 && index < content.length && /[\uD800-\uDBFF]/u.test(content[index - 1]!) && /[\uDC00-\uDFFF]/u.test(content[index]!))
      && !(content[index - 1] === "\r" && content[index] === "\n");
    for (let index = 0; index < ranges.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(ranges, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      const range = descriptor.value;
      if (!Array.isArray(range) || range.length !== 2 || Object.keys(range).length !== 2) return undefined;
      const start = Object.getOwnPropertyDescriptor(range, "0"), end = Object.getOwnPropertyDescriptor(range, "1");
      if (!start || !end || !Object.hasOwn(start, "value") || !Object.hasOwn(end, "value")) return undefined;
      const a = start.value, b = end.value;
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < previous || b <= a || b > content.length || !boundary(a) || !boundary(b)) return undefined;
      // Only compiler framing/fences and whole technical/reference blocks may disappear. Authored values stay padded inside ranges.
      const gap = content.slice(previous, a);
      if (index === 0) { if (a !== (header?.single ? header.length : 0)) return undefined; }
      else if (records) {
        let remaining = gap;
        if (fence) {
          const closing = `\n${indent}${fence}`;
          if (!remaining.startsWith(closing)) return undefined;
          remaining = remaining.slice(closing.length); fence = undefined;
        }
        const opening = (flat ? /^\n  (`{3,})text\n$/u : /^\n    (`{3,})text\n$/u).exec(remaining);
        if (opening) {
          const preview = flat ? /(?:^|\n)- (?:preview|result):(?:\n  …)?$/u : /(?:^|\n)  - preview:(?:\n    …)?$/u;
          if (!preview.test(content.slice(0, previous))) return undefined;
          fence = opening[1]!;
        } else if (!completionRecordDetailsGap(remaining, flat, false)) return undefined;
      } else if (fence) {
        if (gap !== `\n${indent}${fence}\n`) return undefined;
        fence = undefined;
      } else if (gap !== "\n" && (header!.single || !/^\n- batch: [^\r\n\u2028\u2029]{1,128}\n- presentation: ax_records(?:_v3)?\n$/u.test(gap))) {
        const opening = (header!.single ? /^\n  (`{3,})text\n$/u : /^\n      (`{3,})text\n$/u).exec(gap);
        const preview = header!.single ? /(?:^|\n)- preview:(?:\n  …)?$/u : /(?:^|\n)    - preview:(?:\n      …)?$/u;
        if (!opening || !preview.test(content.slice(0, previous))) return undefined;
        fence = opening[1]!;
      }
      const selected = content.slice(a, b);
      if (fence && [...selected.matchAll(/`+/gu)].some(run => run[0].length >= fence!.length)) return undefined;
      text.push(selected); previous = b;
    }
    if (records) {
      let remaining = content.slice(previous, records.start);
      if (fence) {
        const closing = `\n${indent}${fence}`;
        if (!remaining.startsWith(closing)) return undefined;
        remaining = remaining.slice(closing.length);
      }
      if (!completionRecordDetailsGap(remaining, flat, true)) return undefined;
    } else {
      const tail = content.slice(previous);
      if (fence ? !tail.startsWith(`\n${indent}${fence}\n- technical:\n`) : !tail.startsWith("\n- technical:\n")) return undefined;
    }
    return text.join("\n");
  } catch { return undefined; }
}

function ownCompletionData(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(field => !Object.hasOwn(field, "value"))) throw new Error("Accessor presentation data");
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) throw new Error("Sparse presentation data");
    return Array.from({ length: value.length }, (_, index) => {
      if (!descriptors[String(index)]) throw new Error("Sparse presentation data");
      return ownCompletionData(descriptors[String(index)]!.value);
    });
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, ownCompletionData(field.value)]));
}

export interface RunCompletionPresentationView {
  text: string;
  compact: boolean;
  single?: true;
  records?: true;
  blocks?: readonly CompletionBlock[];
  yaml?: true;
  segments?: readonly Readonly<{ kind: "header" | "body" | "marker" | "service" | "separator"; text: string }>[];
}

/** Invalid/missing hints reveal all content; old captures keep their existing host renderer. */
export function readRunCompletionPresentation(content: string, value: unknown): RunCompletionPresentationView | undefined {
  const core = readCompletionYamlCarrier(content);
  let declaredCore = false;
  if (value !== null && typeof value === "object" && !utilTypes.isProxy(value)) {
    try { declaredCore = Object.getOwnPropertyDescriptor(value, "format")?.value === completionYamlCodec; } catch { /* Not own data. */ }
  }
  if (core.state === "available" || declaredCore) {
    const full: RunCompletionPresentationView = { text: content, compact: false, records: true, yaml: true };
    const hint = copyCompletionYamlData(value);
    if (core.state !== "available" || !completionYamlMapping(hint) ||
        !completionYamlKeys(hint, ["format", "content_sha256"]) || hint.format !== completionYamlCodec ||
        hint.content_sha256 !== createHash("sha256").update(content).digest("hex")) return full;
    const segments: NonNullable<RunCompletionPresentationView["segments"]>[number][] = [];
    for (const [index, record] of core.packet.records.entries()) {
      if (index) segments.push({ kind: "separator", text: "\n" });
      const metadata = Object.fromEntries(Object.entries(record.metadata).filter(([key]) => key !== "references" && key !== "run_files"));
      const header = renderYamlMetadata(metadata, completionYamlMaxBytes);
      if (header.state !== "available") return full;
      segments.push({ kind: "header", text: record.parts.length ? `---\n${header.text}---` : header.text.replace(/\n$/u, "") });
      for (const part of record.parts) segments.push("body" in part ? { kind: "body", text: part.body } : { kind: "marker", text: part.marker });
    }
    if (core.packet.service) {
      const service = renderYamlMetadata(core.packet.service, completionYamlMaxBytes);
      if (service.state !== "available") return full;
      if (segments.length) segments.push({ kind: "separator", text: "\n" });
      segments.push({ kind: "service", text: service.text.replace(/\n$/u, "") });
    }
    return { text: segments.map(segment => segment.text).join("\n"), compact: true, records: true, yaml: true,
      segments: Object.freeze(segments.map(segment => Object.freeze(segment))) };
  }
  const fresh = readFrontmatterFrame(content);
  let declaredFormat: unknown;
  try { declaredFormat = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "format")?.value : undefined; } catch { /* Unreadable hints fall back to full content. */ }
  if (fresh || declaredFormat === "completion_frontmatter_v1") {
    try {
      const hint = ownCompletionData(value) as RunCompletionPresentation;
      if (!fresh || !hint || Object.keys(hint).sort().join() !== "blocks,compact_ranges,content_sha256,format" || hint.format !== "completion_frontmatter_v1" || hint.content_sha256 !== createHash("sha256").update(content).digest("hex") || JSON.stringify(hint.blocks) !== JSON.stringify(fresh.blocks) || JSON.stringify(hint.compact_ranges) !== JSON.stringify(fresh.blocks.map(([, a, b]) => [a, b]))) throw new Error("Invalid completion presentation");
      return { text: fresh.blocks.map(([, a, b]) => content.slice(a, b)).join("\n"), compact: true, records: true, blocks: Object.freeze(fresh.blocks.map(block => Object.freeze(block))) };
    } catch { return { text: content, compact: false, records: true }; }
  }
  const header = completionRecordHeader(content), records = header ? undefined : readRunCompletionRecordMarker(content);
  let declared = false;
  try { const format = Object.getOwnPropertyDescriptor(value as object, "format")?.value; declared = format === "ax_records" || format === "ax_records_v3"; } catch { /* absent/unreadable UI hint */ }
  if (!header && !records && !declared) return undefined;
  const text = header || records ? readRunCompletionCompactText(content, value) : undefined;
  return { text: text ?? content, compact: text !== undefined, ...((header?.single || records?.single) ? { single: true as const } : {}),
    ...(records ? { records: true as const } : {}) };
}

/** Retained draft codecs only. Journals store snapshots, not full text: replay must reproduce these exact bytes. */
function projectRetainedCompletionBatchMessage(safe: RunCompletionBatch): { message: string; membersShown: number } {
  const batchLegacyBasis = safe.presentation_format === "ax_records_v2";
  const terminalTimes = safe.members.map(member => member.terminal_at).sort();
  const statuses = (["done", "failed", "killed", "exited"] as const).flatMap(status => {
    const count = safe.members.filter(member => member.status === status).length;
    return count ? [formatMarkdownField(batchLegacyBasis ? `${status}_count` : status, String(count))] : [];
  });
  const header = [formatMarkdownField("completions", String(safe.members.length)), formatMarkdownField("batch", safe.batch_id),
    formatMarkdownField("window_start", terminalTimes[0]), formatMarkdownField("window_end", terminalTimes.at(-1)!),
    ...(batchLegacyBasis ? [...statuses, formatMarkdownField("legacy_basis", "All legacy summary/output fields: original completeness/privacy unproven."),
      formatMarkdownField("legacy_upstream", "[omitted: unknown]")] : [formatMarkdownField("statuses", statuses.join("\n"))]),
    ...(safe.navigation_handoff ? [formatMarkdownField("file_investigation", "optional; current session"), formatInspectNextAction("runtime", "runs", true)] : []),
    ...(safe.inventory_source ? [formatMarkdownField("member_inventory", formatLiteralBlock(JSON.stringify(safe.inventory_source, null, 2)))] : [])];
  const byIdentity = new Map(safe.members.map(member => [memberIdentity(member), member]));
  const assemble = (rows: string[], references: string[]): string => {
    const omitted = safe.members.length - rows.length;
    return [...header, ...(safe.members.length === 1 ? rows : rows.length ? [formatMarkdownField("members", rows.map(row => formatMarkdownField("member", row)).join("\n"))] : []),
      ...(omitted ? [formatMarkdownField("members_omitted", String(omitted)),
        ...(!safe.inventory_source ? [formatMarkdownField("inventory_warning", "No inventory reference is retained in this packet.")] : [])] : []),
      ...(safe.file_navigation === undefined ? [] : [formatMarkdownField("run_files", [
        formatMarkdownField("shown", String(references.length)), formatMarkdownField("omitted", String(safe.members.length - references.length)),
        formatMarkdownField("total", String(safe.members.length)),
        formatMarkdownField("scope", "Captured completion members only; mutable locations, not body/privacy/terminal proof."),
        ...references.map(row => formatMarkdownField("member", row)),
      ].join("\n"))])].join("\n");
  };
  const rows: string[] = [];
  for (const member of orderRunCompletionMembers(safe.members).slice(0, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS)) {
    const row = formatRetainedCompletionMember(member, byIdentity, batchLegacyBasis);
    if (Buffer.byteLength(assemble([...rows, row], []), "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) break;
    rows.push(row);
  }
  const references: string[] = [];
  for (const item of safe.file_navigation ?? []) {
    const member = safe.members[item.member_index];
    const row = formatLiteralBlock(JSON.stringify({ run: member.run, run_instance_id: member.run_instance_id, locations: item.locations }));
    if (Buffer.byteLength(assemble(rows, [...references, row]), "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) break;
    references.push(row);
  }
  const message = assemble(rows, references);
  if (Buffer.byteLength(message, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) throw new Error("Run completion batch header exceeds the model byte limit");
  return { message, membersShown: rows.length };
}

/** Format one immutable batch for a model-bound custom message, without source reads or phase changes. */
export function formatRunCompletionBatchMessage(batch: RunCompletionBatch): string {
  return projectCompletionBatchMessage(parseBatch(batch)).message;
}

function projectCompletionBatchMessage(safe: RunCompletionBatch): { message: string; membersShown: number } {
  if (safe.result_layout !== undefined) return projectCompletionRecords(safe);
  if (safe.presentation_format === "ax_records" || safe.presentation_format === "ax_records_v3") return projectRetainedRecordCompletionBatch(safe);
  if (safe.presentation_format !== undefined) return projectRetainedCompletionBatchMessage(safe);
  const terminalTimes = safe.members.map((member) => member.terminal_at).sort();
  const header = [
    `Actor completions: ${safe.members.length}`,
    `Batch: \`${compactModelText(safe.batch_id, 128)}\``,
    `Window: \`${terminalTimes[0]}\` → \`${terminalTimes.at(-1)}\``,
    `Statuses: \`${formatStatusCounts(safe.members)}\``,
    ...(safe.navigation_handoff ? [formatRunFileNavigationHandoff()] : []),
    ...(safe.inventory_source ? ["Complete captured member inventory retained at capture:", formatLiteralBlock(JSON.stringify(safe.inventory_source, null, 2))] : []),
  ];
  const overflow = (omitted: number) => omitted > 0 ? [`… ${omitted} more completion(s) retained in batch.${safe.inventory_source ? "" : " No inventory reference is retained in this packet."}`] : [];
  const byIdentity = new Map(safe.members.map((member) => [
    memberIdentity(member),
    member,
  ]));
  const navigation = safe.file_navigation;
  const navigationCounts = (shown: number) => navigation === undefined ? [] :
    [`Run files (captured locations; mutable): shown=${shown} omitted=${safe.members.length - shown} total=${safe.members.length}; captured completion members only; not body/privacy/terminal proof.`];
  const candidateRows = orderRunCompletionMembers(safe.members)
    .slice(0, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS)
    .map((member) => formatCompletionMember(member, byIdentity, safe.excerpt_format === "bracketed_omissions_v1"));
  const rows: string[] = [];
  for (const row of candidateRows) {
    const omitted = safe.members.length - rows.length - 1;
    const candidate = [
      ...header,
      ...rows,
      row,
      ...overflow(omitted),
      ...navigationCounts(0),
    ].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) break;
    rows.push(row);
  }
  const omitted = safe.members.length - rows.length;
  const references: string[] = [];
  for (const item of navigation ?? []) {
    const member = safe.members[item.member_index];
    const row = formatLiteralBlock(JSON.stringify({ run: member.run, run_instance_id: member.run_instance_id, locations: item.locations }));
    const candidate = [...header, ...rows, ...overflow(omitted), ...navigationCounts(references.length + 1), ...references, row].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) break;
    references.push(row);
  }
  const message = [
    ...header,
    ...rows,
    ...overflow(omitted),
    ...navigationCounts(references.length),
    ...references,
  ].join("\n");
  if (Buffer.byteLength(message, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES) {
    throw new Error("Run completion batch header exceeds the model byte limit");
  }
  return { message, membersShown: rows.length };
}

// --- Unadmitted pure YAML carrier prototype ---

export type CompletionYamlData = null | boolean | number | string | CompletionYamlData[] | { [key: string]: CompletionYamlData };
export type CompletionYamlPart = { body: string } | { marker: string };
export interface CompletionYamlPacket {
  batchId: string;
  records: { metadata: Record<string, CompletionYamlData>; parts: CompletionYamlPart[] }[];
  service?: Record<string, CompletionYamlData>;
}
export interface CompletionYamlBlock {
  kind: "header" | "body" | "marker" | "separator";
  start: number;
  end: number;
  record: number;
  part?: number;
}
type CompletionYamlUnavailable = { state: "unavailable" };
const completionYamlCodec = "completion_yaml_core_v1";
const completionYamlServiceKey = "_completion";
const completionYamlMaxBytes = 49152;

// Snapshot only own data: never coerce or invoke caller accessors/serialization hooks.
function copyCompletionYamlData(input: unknown): CompletionYamlData | undefined {
  let remaining = completionYamlMaxBytes;
  const active = new Set<object>();
  const copy = (value: unknown, depth: number): CompletionYamlData | undefined => {
    if (--remaining < 0 || depth > 64) return undefined;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
    if (typeof value === "string") {
      remaining -= Buffer.byteLength(value, "utf8");
      return remaining >= 0 && value.isWellFormed() ? value : undefined;
    }
    if (!value || typeof value !== "object" || utilTypes.isProxy(value) || active.has(value)) return undefined;
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return undefined;
    const output: CompletionYamlData[] | Record<string, CompletionYamlData> = array ? [] : {};
    const length = array ? Object.getOwnPropertyDescriptor(value, "length")?.value : undefined;
    if (array && (!Number.isSafeInteger(length) || length < 0 || length > remaining)) return undefined;
    active.add(value);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || !key.isWellFormed() || (array && key !== String(count))) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return undefined;
      remaining -= Buffer.byteLength(key, "utf8");
      const child = copy(descriptor.value, depth + 1);
      if (child === undefined) return undefined;
      Object.defineProperty(output, key, { value: child, enumerable: true, writable: true, configurable: true });
      count++;
    }
    active.delete(value);
    return array && count !== length ? undefined : output;
  };
  try { return copy(input, 0); } catch { return undefined; }
}

function completionYamlMapping(value: unknown): value is Record<string, CompletionYamlData> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function completionYamlKeys(value: Record<string, CompletionYamlData>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

/**
 * Unadmitted data-only prototype, not source/privacy/identity/acceptance authority.
 * Grammar: canonical YAML headers, no physical blank lines. Bare headers end LF;
 * another record adds LF. Body headers are --- LF / YAML / --- LF then raw parts;
 * another record adds LF LF, independently of authored trailing CR/LF. Parts are
 * ordered single-key body/marker UTF-16 lengths, never offsets. Only the first
 * _completion carries codec/batch_id/service. Absent body is DTO parts:[] (no
 * wire parts); selected empty body is body:0 and has a closed header. Zero rows
 * is one bare service-only header requiring nonempty selected service facts.
 * No clipping, fair fitting, source reads, admission or production callers.
 */
export function encodeCompletionYamlCarrier(input: unknown): { state: "available"; text: string } | CompletionYamlUnavailable {
  const unavailable: CompletionYamlUnavailable = { state: "unavailable" };
  const packet = copyCompletionYamlData(input);
  if (!completionYamlMapping(packet) || !completionYamlKeys(packet, ["batchId", "records"], ["service"]) ||
      typeof packet.batchId !== "string" || !packet.batchId.length || !Array.isArray(packet.records) || packet.records.length > 64 ||
      (Object.hasOwn(packet, "service") && (!completionYamlMapping(packet.service) || !Object.keys(packet.service).length)) ||
      (!packet.records.length && !Object.hasOwn(packet, "service"))) return unavailable;
  const rows: string[] = [];
  for (let index = 0; index < Math.max(1, packet.records.length); index++) {
    const row: CompletionYamlData | undefined = packet.records[index];
    const header: Record<string, CompletionYamlData> = {};
    const service: Record<string, CompletionYamlData> = {};
    if (index === 0) {
      service.codec = completionYamlCodec;
      service.batch_id = packet.batchId;
      if (Object.hasOwn(packet, "service")) service.service = packet.service!;
    }
    const raw: string[] = [], lengths: CompletionYamlData[] = [];
    if (packet.records.length) {
      if (!completionYamlMapping(row) || !completionYamlKeys(row, ["metadata", "parts"]) ||
          !completionYamlMapping(row.metadata) || !Array.isArray(row.parts)) return unavailable;
      const meta = row.metadata;
      if (!(meta.index === "?" || (typeof meta.index === "number" && Number.isSafeInteger(meta.index) && meta.index >= 0)) ||
          typeof meta.run !== "string" || !meta.run.length || typeof meta.state !== "string" || !meta.state.length ||
          (Object.hasOwn(meta, "kind") && meta.kind !== "primary" && meta.kind !== "diagnostic") ||
          Object.hasOwn(meta, completionYamlServiceKey) ||
          // JS enumerates array-index keys before semantic core fields; do not silently reorder the header.
          Object.keys(meta).some(key => /^(0|[1-9]\d*)$/u.test(key) && Number(key) < 4294967295)) return unavailable;
      for (const key of ["index", "run", "state", ...(Object.hasOwn(meta, "kind") ? ["kind"] : []),
        ...Object.keys(meta).filter(key => !["index", "run", "state", "kind"].includes(key))]) {
        Object.defineProperty(header, key, { value: meta[key]!, enumerable: true });
      }
      let hasBody = false;
      for (const part of row.parts) {
        if (!completionYamlMapping(part) || Object.keys(part).length !== 1) return unavailable;
        const key = Object.keys(part)[0]!;
        if ((key !== "body" && key !== "marker") || typeof part[key] !== "string") return unavailable;
        if (key === "body") hasBody = true;
        lengths.push({ [key]: part[key].length });
        raw.push(part[key]);
      }
      // An explicit selected empty body is real; empty markers alone cannot justify a wrapper.
      if (lengths.length && !hasBody && raw.every(text => text.length === 0)) return unavailable;
      if (lengths.length) service.parts = lengths;
    }
    if (Object.keys(service).length) header[completionYamlServiceKey] = service;
    const rendered = renderYamlMetadata(header, completionYamlMaxBytes);
    if (rendered.state !== "available" || rendered.text.includes("\n\n")) return unavailable;
    const text = lengths.length ? `---\n${rendered.text}---\n${raw.join("")}` : rendered.text;
    rows.push(text + (index + 1 < packet.records.length ? (lengths.length ? "\n\n" : "\n") : ""));
  }
  const text = rows.join("");
  return Buffer.byteLength(text, "utf8") <= completionYamlMaxBytes ? { state: "available", text } : unavailable;
}

/** Strict whole-carrier decoder. Derived ranges are consistency data, never authenticity. */
export function readCompletionYamlCarrier(input: unknown):
  { state: "available"; packet: CompletionYamlPacket; blocks: CompletionYamlBlock[] } | CompletionYamlUnavailable {
  const unavailable: CompletionYamlUnavailable = { state: "unavailable" };
  if (typeof input !== "string" || !input.isWellFormed() || !input.length || Buffer.byteLength(input, "utf8") > completionYamlMaxBytes) return unavailable;
  try {
    let cursor = 0;
    const packet: CompletionYamlPacket = { batchId: "", records: [] };
    const blocks: CompletionYamlBlock[] = [];
    while (cursor < input.length) {
      if (packet.records.length >= 64) return unavailable;
      const record = packet.records.length, start = cursor, framed = input.startsWith("---\n", cursor);
      let yaml: string;
      if (framed) {
        const close = input.indexOf("\n---\n", cursor + 4);
        if (close < 0) return unavailable;
        yaml = input.slice(cursor + 4, close + 1);
        cursor = close + 5;
      } else {
        const close = input.indexOf("\n\n", cursor);
        cursor = close < 0 ? input.length : close + 1;
        yaml = input.slice(start, cursor);
      }
      const document = parseDocument(yaml, { version: "1.2", schema: "core", uniqueKeys: true });
      if (document.errors.length || document.warnings.length) return unavailable;
      const header: unknown = document.toJS({ maxAliasCount: 0 });
      if (!completionYamlMapping(header)) return unavailable;
      const canonical = renderYamlMetadata(header, completionYamlMaxBytes);
      if (canonical.state !== "available" || canonical.text !== yaml) return unavailable;
      const service = header[completionYamlServiceKey];
      if (record === 0) {
        if (!completionYamlMapping(service) || !completionYamlKeys(service, ["codec", "batch_id"], ["parts", "service"]) ||
            service.codec !== completionYamlCodec || typeof service.batch_id !== "string" || !service.batch_id.length) return unavailable;
        packet.batchId = service.batch_id;
        if (Object.hasOwn(service, "service")) {
          if (!completionYamlMapping(service.service) || !Object.keys(service.service).length) return unavailable;
          packet.service = service.service;
        }
      } else if (service !== undefined && (!completionYamlMapping(service) || !completionYamlKeys(service, ["parts"]))) return unavailable;
      blocks.push({ kind: "header", start, end: cursor, record });
      delete header[completionYamlServiceKey];
      const lengths = completionYamlMapping(service) ? service.parts : undefined;
      if (framed ? !Array.isArray(lengths) || !lengths.length : lengths !== undefined) return unavailable;
      const parts: CompletionYamlPart[] = [];
      if (Array.isArray(lengths)) {
        for (const descriptor of lengths) {
          if (!completionYamlMapping(descriptor) || Object.keys(descriptor).length !== 1) return unavailable;
          const key = Object.keys(descriptor)[0]!;
          const length = descriptor[key];
          if ((key !== "body" && key !== "marker") || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > input.length - cursor) return unavailable;
          const text = input.slice(cursor, cursor + length);
          if (!text.isWellFormed()) return unavailable;
          parts.push(key === "body" ? { body: text } : { marker: text });
          blocks.push({ kind: key, start: cursor, end: cursor + length, record, part: parts.length - 1 });
          cursor += length;
        }
      }
      if (!Object.keys(header).length) {
        if (record !== 0 || framed || !packet.service || cursor !== input.length) return unavailable;
      } else packet.records.push({ metadata: header, parts });
      if (cursor < input.length) {
        const gap = framed ? "\n\n" : "\n";
        if (!input.startsWith(gap, cursor)) return unavailable;
        blocks.push({ kind: "separator", start: cursor, end: cursor + gap.length, record });
        cursor += gap.length;
        if (cursor === input.length) return unavailable;
      }
    }
    const encoded = encodeCompletionYamlCarrier(packet);
    return encoded.state === "available" && encoded.text === input ? { state: "available", packet, blocks } : unavailable;
  } catch { return unavailable; }
}
