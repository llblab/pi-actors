/**
 * Unified bounded Run Trace projection.
 * Zones: causal evidence merge, source filtering, redaction, deterministic ordering
 * Owns public Trace items; source journals and session parsing remain in their domains.
 */

import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import * as ControlProjection from "./control-projection.ts";
import * as ExecutionSessions from "./execution-sessions.ts";
import * as Limits from "./limits.ts";
import {
  resolveArtifactManifest,
  type RunArtifactDeclaration,
} from "./runs-artifacts.ts";
import * as RunsControls from "./runs-controls.ts";
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

export interface TraceItem {
  id: string;
  ts: string;
  source: TraceSource;
  kind: string;
  summary: string;
  level?: "info" | "warning" | "error";
  detail: unknown;
}

interface OrderedTraceItem {
  item: TraceItem;
  ordinal: number;
  sourceKey: string;
}

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
): OrderedTraceItem {
  return { item, ordinal, sourceKey };
}

function compareTraceItems(left: OrderedTraceItem, right: OrderedTraceItem): number {
  const timestamp = right.item.ts.localeCompare(left.item.ts);
  if (timestamp) return timestamp;
  if (left.sourceKey === right.sourceKey) {
    const ordinal = right.ordinal - left.ordinal;
    if (ordinal) return ordinal;
  }
  return SOURCE_RANK[right.item.source] - SOURCE_RANK[left.item.source] ||
    right.item.id.localeCompare(left.item.id);
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

function traceEventItems(stateDir: string): OrderedTraceItem[] {
  const read = RunsTrace.readRunTraceJournal(stateDir);
  const retained = read.events.slice(-SOURCE_LIMIT);
  const projected = retained.map(({ event, ordinal }) => ordered({
    id: event.id,
    ts: event.ts,
    source: sourceForEvent(event),
    kind: event.kind,
    summary: event.summary ?? event.kind,
    ...(event.level ? { level: event.level } : {}),
    detail: redact({
      ...(event.attention ? { attention: event.attention } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    }),
  }, "trace", ordinal));
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

function controlItems(stateDir: string): OrderedTraceItem[] {
  const read = RunsControls.readRunControlJournalFromStateDir(stateDir);
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
    }, "control", start + index + 1);
  });
  return [
    ...projected,
    ...controlDiagnosticItems(read.diagnostics).map((item, index) =>
      ordered(item, "control", read.records.length + index + 1)
    ),
  ];
}

function agentItems(stateDir: string): OrderedTraceItem[] {
  return ExecutionSessions.readExecutionTurns(stateDir)
    .slice(-SOURCE_LIMIT)
    .map((turn) => {
      const text = turn.assistantText ?? turn.userText ?? "Agent turn";
      const summary = text.replaceAll(/\s+/g, " ").trim().slice(0, 160);
      return ordered({
        id: `agent:${turn.commandId}:${turn.sessionFile}:${turn.index}`,
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
  return ["stdout", "stderr"].flatMap((stream) => {
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
    }, `process:${stream}`, 1)];
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
  return [ordered({
    id: "process:result",
    ts: typeof read.value.completedAt === "string"
      ? read.value.completedAt
      : stat.mtime.toISOString(),
    source: "process",
    kind: failed ? "process.failed" : "process.result",
    summary: failed ? "Run process failed" : "Run process completed",
    ...(failed ? { level: "error" as const } : {}),
    detail: redact(read.value),
  }, "process:result", 1), ...diagnosticItems(read.diagnostics).map(
    (item, index) => ordered(item, "process:result", index + 2),
  )];
}

function artifactItems(
  stateDir: string,
  declarations: Record<string, RunArtifactDeclaration> | undefined,
): OrderedTraceItem[] {
  const manifest = resolveArtifactManifest(declarations);
  if (!manifest) return [];
  return Object.entries(manifest).slice(0, SOURCE_LIMIT).map(
    ([name, artifact], index) => ordered({
      id: `artifact:${name}`,
      ts: artifact.exists && existsSync(artifact.path)
        ? statSync(artifact.path).mtime.toISOString()
        : new Date(0).toISOString(),
      source: "artifact",
      kind: artifact.exists ? "artifact.ready" : "artifact.missing",
      summary: `${name}: ${artifact.exists ? "ready" : "missing"}`,
      ...(artifact.required && !artifact.exists ? { level: "warning" as const } : {}),
      detail: redact({
        exists: artifact.exists,
        path: relative(stateDir, artifact.path).replaceAll("\\", "/"),
        required: artifact.required,
        ...(artifact.size !== undefined ? { size: artifact.size } : {}),
      }),
    }, "artifact", index + 1),
  );
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
  const items = [
    ...traceEventItems(stateDir),
    ...controlItems(stateDir),
    ...agentItems(stateDir),
    ...processItems(stateDir),
    ...resultItems(stateDir),
    ...artifactItems(stateDir, options.artifacts),
  ]
    .filter(({ item }) => source === "all" || item.source === source)
    .sort(compareTraceItems);
  return items
    .slice(0, Math.max(1, Math.min(options.limit ?? 100, 200)))
    .map(({ item }) => item);
}
