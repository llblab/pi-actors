/**
 * Registered tool execution output.
 * Zones: command execution results, bounded output formatting, temp artifacts
 * Owns stdout/stderr failure formatting, tail truncation, and full-output temp-file persistence.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeFilePart } from "./identity.js";
import * as Limits from "./limits.js";
import * as Paths from "./paths.js";
export function writeFullOutput(toolName, stream, content) {
    try {
        const outputRoot = join(Paths.getExtensionTmpDir(), "outputs");
        mkdirSync(outputRoot, { recursive: true });
        const dir = mkdtempSync(join(outputRoot, "tool-output-"));
        const filePath = join(dir, `${sanitizeFilePart(toolName)}-${sanitizeFilePart(stream)}.txt`);
        writeFileSync(filePath, content, "utf8");
        return filePath;
    }
    catch {
        return undefined;
    }
}
export function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
export function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}
export function trimToTailBytes(value, maxBytes) {
    const buffer = Buffer.from(value, "utf8");
    if (buffer.length <= maxBytes)
        return value;
    return buffer
        .subarray(buffer.length - maxBytes)
        .toString("utf8")
        .replace(/^\uFFFD+/, "");
}
export function truncateTailContent(content) {
    const totalBytes = byteLength(content);
    const lines = content.split("\n");
    const totalLines = lines.length;
    let output = totalLines > Limits.TOOL_OUTPUT_MAX_LINES
        ? lines.slice(-Limits.TOOL_OUTPUT_MAX_LINES).join("\n")
        : content;
    output = trimToTailBytes(output, Limits.TOOL_OUTPUT_MAX_BYTES);
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
export function formatToolText(text) {
    return `\n${text.replace(/^\n+/, "")}`;
}
export function formatOutput(toolName, stream, content) {
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
export function formatFailureOutput(toolName, code, killed, stdout, stderr) {
    const parts = [`Exit code ${code}${killed ? " (killed)" : ""}`];
    if (stderr.trim())
        parts.push(`stderr:\n${stderr.trimEnd()}`);
    if (stdout.trim())
        parts.push(`stdout:\n${stdout.trimEnd()}`);
    return formatOutput(toolName, "error", parts.join("\n\n"));
}
