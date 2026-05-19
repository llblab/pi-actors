/**
 * Tool output formatting helpers
 * Zones: tool execution, output formatting, temp artifacts
 * Owns stdout/stderr failure formatting, tail truncation, and full-output temp-file persistence
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeFilePart } from "./identity.ts";

export interface FormattedOutput {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

export function writeFullOutput(
  toolName: string,
  stream: string,
  content: string,
): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), "pi-actors-"));
    const filePath = join(
      dir,
      `${sanitizeFilePart(toolName)}-${sanitizeFilePart(stream)}.txt`,
    );
    writeFileSync(filePath, content, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function trimToTailBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer
    .subarray(buffer.length - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
}

export function truncateTailContent(content: string): {
  content: string;
  outputBytes: number;
  outputLines: number;
  totalBytes: number;
  totalLines: number;
  truncated: boolean;
} {
  const totalBytes = byteLength(content);
  const lines = content.split("\n");
  const totalLines = lines.length;
  let output =
    totalLines > MAX_OUTPUT_LINES
      ? lines.slice(-MAX_OUTPUT_LINES).join("\n")
      : content;
  output = trimToTailBytes(output, MAX_OUTPUT_BYTES);
  const outputBytes = byteLength(output);
  const outputLines = output ? output.split("\n").length : 0;
  return {
    content: output,
    outputBytes,
    outputLines,
    totalBytes,
    totalLines,
    truncated: outputBytes < totalBytes || outputLines < totalLines,
  };
}

export function formatToolText(text: string): string {
  return `\n${text.replace(/^\n+/, "")}`;
}

export function formatOutput(
  toolName: string,
  stream: string,
  content: string,
): FormattedOutput {
  const body = content.trimEnd() || "(no output)";
  const truncation = truncateTailContent(body);
  if (!truncation.truncated) {
    return { text: formatToolText(truncation.content), truncated: false };
  }
  const fullOutputPath = writeFullOutput(toolName, stream, body);
  const notice = fullOutputPath
    ? `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`
    : `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output could not be saved.]`;
  return {
    text: formatToolText(`${truncation.content}\n\n${notice}`),
    truncated: true,
    fullOutputPath,
  };
}

export function formatFailureOutput(
  toolName: string,
  code: number,
  killed: boolean,
  stdout: string,
  stderr: string,
): FormattedOutput {
  const parts = [`Exit code ${code}${killed ? " (killed)" : ""}`];
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  return formatOutput(toolName, "error", parts.join("\n\n"));
}
