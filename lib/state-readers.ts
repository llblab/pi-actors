/**
 * Resilient state readers.
 * Zones: file-backed actor state, JSON/JSONL diagnostics, inspect safety
 * Owns best-effort JSON and JSONL parsing helpers for operator-facing state reads.
 */

import { readFileSync } from "node:fs";

export interface StateReadDiagnostic {
  line?: number;
  message: string;
  path: string;
}

export interface JsonReadResult<T> {
  diagnostics: StateReadDiagnostic[];
  value: T;
}

export interface JsonlReadResult<T> {
  diagnostics: StateReadDiagnostic[];
  records: T[];
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function diagnosticMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readJsonFileResilient<T>(path: string, fallback: T): JsonReadResult<T> {
  try {
    return {
      diagnostics: [],
      value: JSON.parse(readFileSync(path, "utf8")) as T,
    };
  } catch (error) {
    if (isEnoent(error)) return { diagnostics: [], value: fallback };
    return {
      diagnostics: [
        {
          message: diagnosticMessage(error),
          path,
        },
      ],
      value: fallback,
    };
  }
}

export function readJsonlFileResilient<T>(path: string): JsonlReadResult<T> {
  try {
    const records: T[] = [];
    const diagnostics: StateReadDiagnostic[] = [];
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as T);
      } catch (error) {
        diagnostics.push({
          line: index + 1,
          message: diagnosticMessage(error),
          path,
        });
      }
    }
    return { diagnostics, records };
  } catch (error) {
    if (isEnoent(error)) return { diagnostics: [], records: [] };
    return {
      diagnostics: [
        {
          message: diagnosticMessage(error),
          path,
        },
      ],
      records: [],
    };
  }
}

export function formatStateReadDiagnostics(
  diagnostics: StateReadDiagnostic[],
  limit = 5,
): string[] {
  return diagnostics.slice(0, limit).map((diagnostic) => {
    const line = diagnostic.line === undefined ? "" : `:${diagnostic.line}`;
    return `${diagnostic.path}${line}: ${diagnostic.message}`;
  });
}
