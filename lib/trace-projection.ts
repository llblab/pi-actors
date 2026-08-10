/**
 * Unified bounded Run Trace projection.
 * Zones: causal evidence merge, source filtering, redaction, deterministic ordering
 * Owns public Trace items; source journals and session parsing remain in their domains.
 */

import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import * as ExecutionSessions from "./execution-sessions.ts";
import * as Limits from "./limits.ts";
import {
  resolveArtifactManifest,
  type RunArtifactDeclaration,
} from "./runs-artifacts.ts";
import type { RunControlRecord } from "./runs-controls.ts";
import { tailFile } from "./runs-status.ts";
import type { TraceEvent } from "./runs-trace.ts";
import * as SessionEvidence from "./session-evidence.ts";
import {
  readJsonFileResilient,
  readJsonlFileResilient,
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

const LIFECYCLE_PREFIXES = ["run.", "command."];
const SOURCE_LIMIT = 100;

function redact(value: unknown): unknown {
  return SessionEvidence.redactSessionEvidenceValue(value);
}

function sourceForEvent(event: TraceEvent): TraceSource {
  return LIFECYCLE_PREFIXES.some((prefix) => event.kind.startsWith(prefix))
    ? "lifecycle"
    : "runtime";
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

function traceEventItems(stateDir: string): TraceItem[] {
  const read = readJsonlFileResilient<TraceEvent>(join(stateDir, "trace.jsonl"));
  return [
    ...read.records.slice(-SOURCE_LIMIT).map((event) => ({
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
    } satisfies TraceItem)),
    ...diagnosticItems(read.diagnostics),
  ];
}

function controlItems(stateDir: string): TraceItem[] {
  const read = readJsonlFileResilient<RunControlRecord>(
    join(stateDir, "controls.jsonl"),
  );
  return [
    ...read.records.slice(-SOURCE_LIMIT).map((control) => ({
      id: `control:${control.id}`,
      ts: latestControlTimestamp(control),
      source: "control" as const,
      kind: `control.${control.status}`,
      summary: `${control.action} ${control.status}`,
      ...(control.status === "failed" ? { level: "error" as const } : {}),
      detail: redact(control),
    })),
    ...diagnosticItems(read.diagnostics),
  ];
}

function agentItems(stateDir: string): TraceItem[] {
  return ExecutionSessions.readExecutionTurns(stateDir)
    .slice(-SOURCE_LIMIT)
    .map((turn) => {
      const text = turn.assistantText ?? turn.userText ?? "Agent turn";
      const summary = text.replaceAll(/\s+/g, " ").trim().slice(0, 160);
      return {
        id: `agent:${turn.commandId}:${turn.sessionFile}:${turn.index}`,
        ts: turn.timestamp ?? new Date(0).toISOString(),
        source: "agent" as const,
        kind: "agent.turn",
        summary: summary || "Agent turn",
        ...(turn.error ? { level: "error" as const } : {}),
        detail: redact(turn),
      };
    });
}

function processItems(stateDir: string): TraceItem[] {
  return ["stdout", "stderr"].flatMap((stream) => {
    const path = join(stateDir, `${stream}.log`);
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    const tail = tailFile(path, Limits.DEFAULT_INSPECT_LINES);
    if (!tail && stat.size === 0) return [];
    return [{
      id: `process:${stream}`,
      ts: stat.mtime.toISOString(),
      source: "process" as const,
      kind: `process.${stream}`,
      summary: `${stream} (${stat.size} bytes)`,
      ...(stream === "stderr" ? { level: "warning" as const } : {}),
      detail: redact({ bytes: stat.size, path, tail }),
    }];
  });
}

function resultItems(stateDir: string): TraceItem[] {
  const path = join(stateDir, "result.json");
  const read = readJsonFileResilient<Record<string, unknown>>(path, {});
  if (Object.keys(read.value).length === 0) return diagnosticItems(read.diagnostics);
  const stat = statSync(path);
  const failed = Number(read.value.code ?? 0) !== 0;
  return [{
    id: "process:result",
    ts:
      typeof read.value.completedAt === "string"
        ? read.value.completedAt
        : stat.mtime.toISOString(),
    source: "process",
    kind: failed ? "process.failed" : "process.result",
    summary: failed ? "Run process failed" : "Run process completed",
    ...(failed ? { level: "error" as const } : {}),
    detail: redact(read.value),
  }, ...diagnosticItems(read.diagnostics)];
}

function artifactItems(
  stateDir: string,
  declarations: Record<string, RunArtifactDeclaration> | undefined,
): TraceItem[] {
  const manifest = resolveArtifactManifest(declarations);
  if (!manifest) return [];
  return Object.entries(manifest).slice(0, SOURCE_LIMIT).map(([name, artifact]) => ({
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
  }));
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
    .filter((item) => source === "all" || item.source === source)
    .sort((left, right) =>
      right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id),
    );
  return items.slice(0, Math.max(1, Math.min(options.limit ?? 100, 200)));
}
