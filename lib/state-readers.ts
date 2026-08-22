/**
 * Resilient state readers.
 * Zones: file-backed actor state, JSON/JSONL diagnostics, inspect safety
 * Owns best-effort JSON and JSONL parsing helpers for operator-facing state reads.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";

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
  truncated?: boolean;
}

export interface JsonlReadOptions {
  maxBytes?: number;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function diagnosticMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTextFileCapped(path: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined) return readFileSync(path, "utf8");
  const limit = Math.max(0, Math.floor(maxBytes));
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > limit) {
      throw Object.assign(
        new Error(`file exceeds bounded read limit (${size} > ${limit} bytes)`),
        { code: "EFBIG" },
      );
    }
    const content = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, content, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return content.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
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

export function readJsonlFileResilient<T>(
  path: string,
  options: JsonlReadOptions = {},
): JsonlReadResult<T> {
  try {
    const records: T[] = [];
    const diagnostics: StateReadDiagnostic[] = [];
    const lines = readTextFileCapped(path, options.maxBytes).split("\n");
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
      ...((error as NodeJS.ErrnoException).code === "EFBIG"
        ? { truncated: true }
        : {}),
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
