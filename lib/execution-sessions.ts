/**
 * Run-owned execution session evidence.
 * Zones: execution manifest session discovery, canonical containment, rich turn correlation
 * Owns reusable agent-turn loading; Trace and TUI projection stay in their adapters.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as SessionEvidence from "./session-evidence.ts";
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

function ownedSessionPath(
  stateDir: string,
  sessionFile: string,
): string | undefined {
  if (path.isAbsolute(sessionFile)) return undefined;
  const sessionsRoot = path.resolve(stateDir, "sessions");
  const resolved = path.resolve(stateDir, sessionFile);
  if (!resolved.startsWith(`${sessionsRoot}${path.sep}`)) return undefined;
  try {
    const canonicalRoot = fs.realpathSync(sessionsRoot);
    const canonicalFile = fs.realpathSync(resolved);
    return canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)
      ? canonicalFile
      : undefined;
  } catch {
    return undefined;
  }
}

export function readExecutionTurns(stateDir: string): ExecutionTurnItem[] {
  const execution = readJsonFileResilient<Record<string, unknown>>(
    path.join(stateDir, "execution.json"),
    {},
  ).value;
  const commands = Array.isArray(execution.commands)
    ? (execution.commands as Array<Record<string, unknown>>)
    : [];
  const recordedFiles = new Set(
    commands.flatMap((command) =>
      (Array.isArray(command.session_files) ? command.session_files : []).filter(
        (file): file is string => typeof file === "string",
      ),
    ),
  );
  let discoveredCommands: Array<Record<string, unknown>> = [];
  try {
    const sessionsDir = path.join(stateDir, "sessions");
    discoveredCommands = fs
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
      });
  } catch {
    discoveredCommands = [];
  }
  return [...commands, ...discoveredCommands]
    .flatMap((command) =>
      (Array.isArray(command.session_files) ? command.session_files : [])
        .filter((file): file is string => typeof file === "string")
        .flatMap((file) => {
          const sessionPath = ownedSessionPath(stateDir, file);
          if (!sessionPath) return [];
          const session = SessionEvidence.readSessionEvidence(sessionPath);
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
}
