/**
 * Unified bounded Run Trace projection.
 * Zones: causal evidence merge, source filtering, redaction, deterministic ordering
 * Owns public Trace items; source journals and session parsing remain in their domains.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import * as ControlProjection from "./control-projection.ts";
import * as ExecutionSessions from "./execution-sessions.ts";
import * as Limits from "./limits.ts";
import { createRunRecipeEvidenceRedactor } from "./recipe-projection.ts";
import {
  describeRunArtifactReferences,
  observeRunArtifactReference,
  type RunArtifactDeclaration,
} from "./runs-artifacts.ts";
import * as RunsControls from "./runs-controls.ts";
import { isRunStopResultCapture } from "./runs-outcomes.ts";
import type { RunControlRecord } from "./runs-controls.ts";
import { tailFile } from "./runs-status.ts";
import * as RunsTrace from "./runs-trace.ts";
import * as SessionEvidence from "./session-evidence.ts";
import {
  readJsonFileResilient,
  type StateReadDiagnostic,
} from "./state-readers.ts";

export type TraceSource =
  | "lifecycle"
  | "control"
  | "process"
  | "agent"
  | "artifact"
  | "runtime";

export type TraceSourceFilter = TraceSource | "all";

export const TRACE_ITEM_SEQUENCE = Symbol("trace-item-sequence");
export const TRACE_ITEM_CHRONOLOGY = Symbol("trace-item-chronology");
export type TraceChronologyReason = "history_incomplete" | "control_history_unproven" | "metadata_unavailable" | "metadata_private" | "metadata_too_large" | "metadata_ambiguous" | "timestamp_unavailable";
export type TraceChronology = Readonly<{ basis: "recorded_observations" } & (
  { state: "available"; ordinal: number; total: number } | { state: "unavailable"; reason: TraceChronologyReason }
)>;

export interface TraceItem {
  id: string;
  ts: string;
  [TRACE_ITEM_SEQUENCE]?: number;
  [TRACE_ITEM_CHRONOLOGY]?: TraceChronology;
  source: TraceSource;
  kind: string;
  summary: string;
  level?: "info" | "warning" | "error";
  detail: unknown;
}

interface OrderedTraceKey {
  item: Pick<TraceItem, "id" | "ts" | "source">;
  ordinal: number;
  sourceKey: string;
}
interface OrderedTraceItem extends OrderedTraceKey { item: TraceItem }

const LIFECYCLE_PREFIXES = ["run.", "command."];
const SOURCE_LIMIT = 100;
const SOURCE_RANK: Record<TraceSource, number> = {
  lifecycle: 6,
  control: 5,
  process: 4,
  agent: 3,
  artifact: 2,
  runtime: 1,
};

function redact(value: unknown): unknown {
  return SessionEvidence.redactSessionEvidenceValue(value);
}

function sourceForEvent(event: RunsTrace.TraceEvent): TraceSource {
  return LIFECYCLE_PREFIXES.some((prefix) => event.kind.startsWith(prefix))
    ? "lifecycle"
    : "runtime";
}

function ordered(
  item: TraceItem,
  sourceKey: string,
  ordinal: number,
  sequence = ordinal,
): OrderedTraceItem {
  Object.defineProperty(item, TRACE_ITEM_SEQUENCE, { value: sequence });
  return { item, ordinal, sourceKey };
}

function compareTraceItems(left: OrderedTraceKey, right: OrderedTraceKey): number {
  const timestamp = right.item.ts.localeCompare(left.item.ts);
  if (timestamp) return timestamp;
  if (left.sourceKey === right.sourceKey) {
    const ordinal = right.ordinal - left.ordinal;
    if (ordinal) return ordinal;
  }
  return SOURCE_RANK[right.item.source] - SOURCE_RANK[left.item.source] ||
    right.item.id.localeCompare(left.item.id);
}

// Read-local metadata only; availability is not an original-history, issuer or work capability.
class TraceChronologyBuilder {
  private entries: OrderedTraceKey[] = [];
  private bytes = 2;
  private reason?: TraceChronologyReason;
  unavailable(reason: TraceChronologyReason): void { this.reason ??= reason; this.entries.length = 0; }
  add(item: Pick<TraceItem, "id" | "ts" | "source">, sourceKey: string, ordinal: number): void {
    if (this.reason) return;
    if (typeof item.id !== "string" || !item.id) { this.unavailable("metadata_unavailable"); return; }
    const projected = redact([item.id, item.ts]) as unknown[];
    if (projected[0] !== item.id || projected[1] !== item.ts) { this.unavailable("metadata_private"); return; }
    if (typeof item.ts !== "string" || item.ts.length !== 24 || !Number.isFinite(Date.parse(item.ts)) || new Date(item.ts).toISOString() !== item.ts) {
      this.unavailable("timestamp_unavailable"); return;
    }
    const entry = { item: { id: item.id, ts: item.ts, source: item.source }, sourceKey, ordinal };
    this.bytes += Buffer.byteLength(JSON.stringify(entry)) + Number(this.entries.length > 0);
    if (this.bytes > Limits.TRACE_JOURNAL_MAX_BYTES) { this.unavailable("metadata_too_large"); return; }
    this.entries.push(entry);
  }
  finish(items: OrderedTraceItem[]): void {
    const ranks = new Map<string, { key: OrderedTraceKey; ordinal: number }>();
    if (!this.reason) {
      this.entries.sort(compareTraceItems);
      for (const [index, key] of this.entries.entries()) {
        if (ranks.has(key.item.id)) { this.unavailable("metadata_ambiguous"); break; }
        ranks.set(key.item.id, { key, ordinal: this.entries.length - index });
      }
    }
    if (!this.reason && items.some(({ item, sourceKey }) => {
      const entry = ranks.get(item.id);
      return !entry || entry.key.sourceKey !== sourceKey || entry.key.item.ts !== item.ts || entry.key.item.source !== item.source;
    })) this.unavailable("metadata_unavailable");
    // The legacy same-source ordinal/cross-source rank tie rule is not always a total order.
    if (!this.reason) for (const source of ["all", ...Object.keys(SOURCE_RANK)]) {
      let previous = Infinity;
      const view = items.filter(({ item }) => source === "all" || item.source === source).sort(compareTraceItems);
      if (view.some(({ item }) => { const rank = ranks.get(item.id)!.ordinal; const mismatch = rank >= previous; previous = rank; return mismatch; })) {
        this.unavailable("metadata_ambiguous"); break;
      }
    }
    for (const { item } of items) Object.defineProperty(item, TRACE_ITEM_CHRONOLOGY, { value: Object.freeze(this.reason
      ? { state: "unavailable", basis: "recorded_observations", reason: this.reason }
      : { state: "available", basis: "recorded_observations", ordinal: ranks.get(item.id)!.ordinal, total: ranks.size }) });
  }
}

function latestControlTimestamp(control: RunControlRecord): string {
  return (
    control.failed_at ??
    control.handled_at ??
    control.claimed_at ??
    control.delivered_at ??
    control.queued_at
  );
}

function diagnosticItems(diagnostics: StateReadDiagnostic[]): TraceItem[] {
  return diagnostics.slice(-SOURCE_LIMIT).map((diagnostic, index) => ({
    id: `diagnostic:${diagnostic.path}:${diagnostic.line ?? 0}:${index}`,
    ts: new Date(0).toISOString(),
    source: "runtime",
    kind: "state.read_error",
    summary: "Malformed or unreadable Run evidence",
    level: "warning",
    detail: redact(diagnostic),
  }));
}

function controlDiagnosticItems(
  diagnostics: StateReadDiagnostic[],
): TraceItem[] {
  return diagnostics.slice(-SOURCE_LIMIT).map((diagnostic, index) => ({
    id: `control-diagnostic:${diagnostic.line ?? 0}:${index}`,
    ts: new Date(0).toISOString(),
    source: "runtime",
    kind: "state.read_error",
    summary: "Malformed or unreadable Control evidence",
    level: "warning",
    detail: {
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      reason: diagnostic.line === undefined
        ? "unreadable_control_journal"
        : "invalid_control_json",
    },
  }));
}

function traceEventItems(read: RunsTrace.RunTraceJournalRead, recipe?: Record<string, unknown>,
  projectEvidence: (value: unknown) => unknown = recipe ? createRunRecipeEvidenceRedactor(recipe) : redact,
  chronology?: TraceChronologyBuilder): OrderedTraceItem[] {
  const summary = RunsTrace.summarizeRunTraceJournal(read);
  if (!summary.history_complete) chronology?.unavailable("history_incomplete");
  if (chronology) for (const { event, ordinal } of read.events) {
    if (redact(event.kind) !== event.kind) chronology.unavailable("metadata_private");
    chronology.add({ id: event.id, ts: event.ts, source: sourceForEvent(event) }, "trace", ordinal);
  }
  const sequenceOffset = summary.dropped_events + Math.max(0, summary.compactions_total - 1);
  const retained = read.events.slice(-SOURCE_LIMIT);
  const projected = retained.map(({ event, ordinal }) => ordered({
    id: event.id,
    ts: event.ts,
    source: sourceForEvent(event),
    kind: event.kind,
    summary: projectEvidence(event.summary ?? event.kind) as string,
    ...(event.level ? { level: event.level } : {}),
    detail: projectEvidence({
      ...(event.attention ? { attention: event.attention } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    }),
  }, "trace", ordinal, sequenceOffset + Math.max(0, ordinal - 1)));
  const diagnostics = diagnosticItems(read.diagnostics).map((item, index) =>
    ordered(item, "trace", read.events.length + index + 1)
  );
  const hasMarker = read.events.some(
    ({ event }) => event.kind === "runtime.trace_compacted",
  );
  if (read.omittedPrefixBytes > 0 && !hasMarker) {
    diagnostics.push(ordered({
      id: "runtime:trace-history-incomplete",
      ts: new Date(0).toISOString(),
      source: "runtime",
      kind: "runtime.trace_history_incomplete",
      summary: "Trace history is incomplete",
      level: "warning",
      detail: {
        omitted_prefix_bytes: read.omittedPrefixBytes,
        read_bytes: read.readBytes,
        retained_events: read.events.length,
      },
    }, "trace", 0));
  }
  return [...projected, ...diagnostics];
}

function controlItems(stateDir: string, chronology?: TraceChronologyBuilder): OrderedTraceItem[] {
  const read = RunsControls.readRunControlJournalFromStateDir(stateDir);
  if (read.diagnostics.length) chronology?.unavailable("metadata_unavailable");
  let terminal = 0;
  if (chronology) for (const [index, raw] of read.records.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { chronology.unavailable("metadata_unavailable"); continue; }
    const record = raw as RunControlRecord;
    if (![record.id, record.action, record.run_instance_id, record.queued_at].every(value => typeof value === "string") || !record.id || !record.run_instance_id ||
      !["queued", "delivered", "claimed", "handled", "failed"].includes(record.status)) { chronology.unavailable("metadata_unavailable"); continue; }
    if (record.status === "handled" || record.status === "failed") terminal++;
    const metadata = { id: record.id, action: record.action, run_instance_id: record.run_instance_id, queued_at: record.queued_at, status: record.status,
      ...Object.fromEntries(["failed_at", "handled_at", "claimed_at", "delivered_at"].flatMap(field =>
        typeof (raw as Record<string, unknown>)[field] === "string" ? [[field, (raw as Record<string, unknown>)[field]]] : [])) };
    const value = ControlProjection.projectRunControl(metadata);
    if (value.id !== record.id || latestControlTimestamp(value) !== latestControlTimestamp(record)) chronology.unavailable("metadata_unavailable");
    chronology.add({ id: `control:${value.id}`, ts: latestControlTimestamp(value), source: "control" }, "control", index + 1);
  }
  if (terminal >= Limits.RUN_CONTROL_TERMINAL_LIMIT) chronology?.unavailable("control_history_unproven");
  const start = Math.max(0, read.records.length - SOURCE_LIMIT);
  const projected = read.records.slice(start).map((control, index) => {
    const value = ControlProjection.projectRunControl(control as RunControlRecord);
    return ordered({
      id: `control:${value.id}`,
      ts: latestControlTimestamp(value),
      source: "control",
      kind: `control.${value.status}`,
      summary: `${value.action} ${value.status}`,
      ...(value.status === "failed" ? { level: "error" as const } : {}),
      detail: value,
    }, "control", start + index + 1, start + index);
  });
  return [
    ...projected,
    ...controlDiagnosticItems(read.diagnostics).map((item, index) =>
      ordered(item, "control", read.records.length + index + 1)
    ),
  ];
}

function agentIdentity(commandId: string, sessionFile: string, index: number,
  admitted: SessionEvidence.SessionEvidenceTurn[typeof SessionEvidence.SESSION_TURN_IDENTITY]): string {
  const namespace = redact([commandId, sessionFile]) as unknown[];
  const identity = namespace[0] === commandId && namespace[1] === sessionFile ? admitted : undefined;
  const basis = identity?.basis ?? "legacy";
  const key = createHash("sha256").update(JSON.stringify([
    "agent-turn-v1", ...namespace, identity ?? { basis, ordinal: index },
  ])).digest("hex");
  return `agent:${basis}:${key}`;
}

function agentItems(stateDir: string, chronology?: TraceChronologyBuilder): OrderedTraceItem[] {
  const turns = ExecutionSessions.readExecutionTurns(stateDir);
  const metadata = turns[ExecutionSessions.EXECUTION_CHRONOLOGY];
  if (!metadata || metadata.state !== "available") chronology?.unavailable("metadata_unavailable");
  else for (const entry of metadata.entries) chronology?.add({
    id: agentIdentity(entry.commandId, entry.sessionFile, entry.ordinal, entry.identity), ts: entry.timestamp, source: "agent",
  }, "agent", entry.ordinal);
  return turns.slice(-SOURCE_LIMIT).map((turn) => {
      const text = turn.assistantText ?? turn.userText ?? "Agent turn";
      const compact = text.replaceAll(/\s+/g, " ").trim();
      let summary = compact;
      if (Buffer.from(compact).toString("utf8") !== compact) {
        summary = "Agent turn [omitted: unknown] (malformed retained text)";
      } else if (compact.length > 160) {
        const last = compact.charCodeAt(159), next = compact.charCodeAt(160);
        const end = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 159 : 160;
        // Only this normalized retained suffix supplies a count; upstream source loss stays unknown.
        const omitted = Array.from(compact.slice(end)).length;
        summary = `${compact.slice(0, end)}… [omitted: ${omitted} chars] from normalized retained turn; upstream [omitted: unknown]`;
      }
      return ordered({
        id: agentIdentity(turn.commandId, turn.sessionFile, turn.index, turn[SessionEvidence.SESSION_TURN_IDENTITY]),
        ts: turn.timestamp ?? new Date(0).toISOString(),
        source: "agent",
        kind: "agent.turn",
        summary: summary || "Agent turn",
        ...(turn.error ? { level: "error" as const } : {}),
        detail: redact(turn),
      }, "agent", turn.index);
    });
}

function processItems(stateDir: string): OrderedTraceItem[] {
  return ["stdout", "stderr"].flatMap((stream, index) => {
    const path = join(stateDir, `${stream}.log`);
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    const tail = tailFile(path, Limits.DEFAULT_INSPECT_LINES);
    if (!tail && stat.size === 0) return [];
    return [ordered({
      id: `process:${stream}`,
      ts: stat.mtime.toISOString(),
      source: "process",
      kind: `process.${stream}`,
      summary: `${stream} (${stat.size} bytes)`,
      ...(stream === "stderr" ? { level: "warning" as const } : {}),
      detail: redact({ bytes: stat.size, path, tail }),
    }, `process:${stream}`, 1, index)];
  });
}

function resultItems(stateDir: string): OrderedTraceItem[] {
  const path = join(stateDir, "result.json");
  const read = readJsonFileResilient<Record<string, unknown>>(path, {});
  if (Object.keys(read.value).length === 0) {
    return diagnosticItems(read.diagnostics).map((item, index) =>
      ordered(item, "process:result", index)
    );
  }
  const stat = statSync(path);
  const failed = Number(read.value.code ?? 0) !== 0;
  const captured = isRunStopResultCapture(read.value);
  return [ordered({
    id: "process:result",
    ts: typeof read.value.completedAt === "string"
      ? read.value.completedAt
      : stat.mtime.toISOString(),
    source: "process",
    kind: captured ? "process.result_captured" : failed ? "process.failed" : "process.result",
    summary: captured ? "Workload result captured while stopping" : failed ? "Run process failed" : "Run process completed",
    ...(failed ? { level: "error" as const } : {}),
    detail: redact(read.value),
  }, "process:result", 1, 2), ...diagnosticItems(read.diagnostics).map(
    (item, index) => ordered(item, "process:result", index + 2),
  )];
}

function artifactItems(
  stateDir: string,
  declarations: Record<string, RunArtifactDeclaration> | undefined,
  chronology?: TraceChronologyBuilder,
): OrderedTraceItem[] {
  const described = describeRunArtifactReferences(declarations, process.cwd());
  if (described.state !== "available") { if (declarations) chronology?.unavailable("metadata_unavailable"); return []; }
  if (described.references.length > SOURCE_LIMIT) chronology?.unavailable("metadata_unavailable");
  return described.references.slice(0, SOURCE_LIMIT).map((reference, index) => {
    const artifact = observeRunArtifactReference(reference);
    const exists = artifact.availability === "available";
    if (!artifact.modified_at) chronology?.unavailable("timestamp_unavailable");
    return ordered({
      id: `artifact:${artifact.name}`,
      ts: artifact.modified_at ?? new Date(0).toISOString(),
      source: "artifact",
      kind: exists ? "artifact.ready" : artifact.availability === "missing" ? "artifact.missing" : "artifact.unavailable",
      summary: redact(`${artifact.name}: ${exists ? "ready" : artifact.availability}`) as string,
      ...(artifact.required && !exists ? { level: "warning" as const } : {}),
      detail: redact({
        ...(artifact.availability !== "unavailable" ? { exists } : {}),
        availability: artifact.availability,
        path: relative(stateDir, artifact.path).replaceAll("\\", "/"),
        required: artifact.required,
        ...(artifact.bytes_total !== undefined ? { size: artifact.bytes_total } : {}),
        ...(artifact.reason ? { reason: artifact.reason } : {}),
      }),
    }, "artifact", index + 1, index);
  });
}

/** Data-only canonical-journal projection; captured Recipe context supplies privacy, never lifecycle/work authority. */
export function projectRunTraceJournal(
  read: RunsTrace.RunTraceJournalRead,
  options: { limit?: number; recipe?: Record<string, unknown>; redactEvidence?: (value: unknown) => unknown } = {},
): TraceItem[] {
  return traceEventItems(read, options.recipe, options.redactEvidence).sort(compareTraceItems)
    .slice(0, Math.max(1, Math.min(options.limit ?? 100, 200))).map(({ item }) => item);
}

export function projectRunTrace(
  stateDir: string,
  options: {
    artifacts?: Record<string, RunArtifactDeclaration>;
    limit?: number;
    source?: TraceSourceFilter;
  } = {},
): TraceItem[] {
  const source = options.source ?? "all";
  const chronology = new TraceChronologyBuilder();
  const entries = [
    ...traceEventItems(RunsTrace.readRunTraceJournal(stateDir), undefined, undefined, chronology),
    ...controlItems(stateDir, chronology),
    ...agentItems(stateDir, chronology),
  ];
  const snapshots = [...processItems(stateDir), ...resultItems(stateDir), ...artifactItems(stateDir, options.artifacts, chronology)];
  for (const entry of snapshots) {
    if (entry.item.kind === "state.read_error") chronology.unavailable("metadata_unavailable");
    chronology.add(entry.item, entry.sourceKey, entry.ordinal);
  }
  const all = [...entries, ...snapshots];
  chronology.finish(all);
  const items = all.filter(({ item }) => source === "all" || item.source === source).sort(compareTraceItems);
  return items
    .slice(0, Math.max(1, Math.min(options.limit ?? 100, 200)))
    .map(({ item }) => item);
}
