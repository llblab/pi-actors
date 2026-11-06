/**
 * Run-owned execution session evidence.
 * Zones: execution manifest session discovery, canonical containment, rich turn correlation
 * Owns reusable agent-turn loading; Trace and TUI projection stay in their adapters.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { observeExecutionFileReference } from "./execution-files.ts";
import * as SessionEvidence from "./session-evidence.ts";
import * as Limits from "./limits.ts";
import { readJsonFileResilient } from "./state-readers.ts";

export interface ExecutionTurnItem extends SessionEvidence.SessionEvidenceTurn {
  commandId: string;
  diagnostics: string[];
  promptBytes?: number;
  promptFile?: string;
  recipeContext?: unknown;
  sessionFile: string;
  sessionTruncated: boolean;
  stage?: string;
}

export const EXECUTION_CHRONOLOGY = Symbol("execution-session-chronology");
export interface ExecutionChronologyEntry extends SessionEvidence.SessionChronologyEntry {
  commandId: string;
  sessionFile: string;
  sessionOrdinal: number;
}
export type ExecutionChronology = Readonly<{
  basis: "recorded_execution_metadata";
  entries: readonly Readonly<ExecutionChronologyEntry>[];
} & ({ state: "available" } | { state: "unavailable"; reason: SessionEvidence.SessionChronologyReason | "source_changed" | "namespace_unavailable" })>;
export type ExecutionTurnCollection = ExecutionTurnItem[] & { readonly [EXECUTION_CHRONOLOGY]?: ExecutionChronology };

export function readExecutionTurns(stateDir: string): ExecutionTurnCollection {
  const read = readJsonFileResilient<Record<string, unknown>>(
    path.join(stateDir, "execution.json"),
    {},
  );
  const execution = read.value;
  const basis = "recorded_execution_metadata" as const;
  let reason: Extract<ExecutionChronology, { state: "unavailable" }>["reason"] | undefined = read.diagnostics.length ? "source_unavailable" : undefined;
  const metadata: Readonly<ExecutionChronologyEntry>[] = [];
  let metadataBytes = Buffer.byteLength(JSON.stringify({ state: "available", basis, entries: [] }));
  const refuse = (next: NonNullable<typeof reason>): void => { reason ??= next; metadata.length = 0; };
  const collect = (commandId: string, sessionFile: string, frame: SessionEvidence.SessionChronology | undefined): void => {
    if (reason) return;
    if (!frame || frame.state !== "available") { refuse(frame?.state === "unavailable" ? frame.reason : "source_unavailable"); return; }
    if (SessionEvidence.redactSessionEvidenceValue(commandId) !== commandId || SessionEvidence.redactSessionEvidenceValue(sessionFile) !== sessionFile) {
      refuse("namespace_unavailable"); return;
    }
    for (const item of frame.entries) {
      const entry = Object.freeze({ ...item, commandId, sessionFile, sessionOrdinal: item.ordinal, ordinal: metadata.length + 1 });
      metadataBytes += Buffer.byteLength(JSON.stringify(entry)) + Number(metadata.length > 0);
      if (metadataBytes > Limits.SESSION_EVIDENCE_MAX_BYTES) { refuse("metadata_too_large"); return; }
      metadata.push(entry);
    }
  };
  const commands = Array.isArray(execution.commands)
    ? (execution.commands as Array<Record<string, unknown>>)
    : [];
  if ((execution.commands !== undefined && !Array.isArray(execution.commands)) || commands.some((command) =>
    !command || typeof command !== "object" || Array.isArray(command) ||
    (command.session_files !== undefined && (!Array.isArray(command.session_files) || command.session_files.some((file) => typeof file !== "string"))))) refuse("source_unavailable");
  const recordedFiles = new Set(
    commands.flatMap((command) =>
      (Array.isArray(command.session_files) ? command.session_files : []).filter(
        (file): file is string => typeof file === "string",
      ),
    ),
  );
  let discoveredCommands: Array<Record<string, unknown>> = [];
  try {
    const state = path.resolve(stateDir);
    const sessionsDir = path.join(state, "sessions");
    const root = fs.lstatSync(state);
    const rootObserved = root.isDirectory() && !root.isSymbolicLink();
    const namespace = fs.lstatSync(sessionsDir, { throwIfNoEntry: false });
    if (!rootObserved || (namespace && (!namespace.isDirectory() || namespace.isSymbolicLink()))) refuse("source_unavailable");
    discoveredCommands = rootObserved && namespace?.isDirectory() && !namespace.isSymbolicLink() ? fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const files = fs
          .readdirSync(path.join(sessionsDir, entry.name), {
            withFileTypes: true,
          })
          .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
          .map((file) => path.posix.join("sessions", entry.name, file.name))
          .filter((file) => !recordedFiles.has(file));
        return files.length > 0
          ? [{ id: entry.name, session_files: files, stage: "subagent" }]
          : [];
      }) : [];
  } catch {
    refuse("source_unavailable");
    discoveredCommands = [];
  }
  const turns: ExecutionTurnCollection = [...commands, ...discoveredCommands]
    .flatMap((command) =>
      (Array.isArray(command.session_files) ? command.session_files : [])
        .filter((file): file is string => typeof file === "string")
        .flatMap((file) => {
          const reference = observeExecutionFileReference(stateDir, { kind: "session", path: file });
          if (reference.availability !== "available") { refuse("source_unavailable"); return []; }
          const session = SessionEvidence.readSessionEvidence(reference.local_path);
          if (!reference.unchanged()) { refuse("source_changed"); return []; }
          if (typeof command.id !== "string" || !command.id) refuse("namespace_unavailable");
          else collect(command.id, file, session[SessionEvidence.SESSION_EVIDENCE_CHRONOLOGY]);
          return session.turns.map((turn) => ({
            ...turn,
            commandId: String(command.id ?? "unknown"),
            diagnostics: session.diagnostics.map((item) =>
              `${item.line === undefined ? "" : `line ${item.line}: `}${item.message}`,
            ),
            ...(typeof command.prompt_bytes === "number"
              ? { promptBytes: command.prompt_bytes }
              : {}),
            ...(typeof command.prompt_file === "string"
              ? { promptFile: command.prompt_file }
              : {}),
            ...(command.recipe_context !== undefined
              ? { recipeContext: command.recipe_context }
              : {}),
            sessionFile: file,
            sessionTruncated: session.truncated,
            ...(typeof command.stage === "string"
              ? { stage: command.stage }
              : {}),
          }));
        }),
    )
    .map((turn, index) => ({ ...turn, index: index + 1 }));
  Object.defineProperty(turns, EXECUTION_CHRONOLOGY, { value: Object.freeze(reason
    ? { state: "unavailable", basis, reason, entries: Object.freeze([]) }
    : { state: "available", basis, entries: Object.freeze(metadata) }) });
  return turns;
}
