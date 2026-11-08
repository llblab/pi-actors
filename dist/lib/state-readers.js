/**
 * Resilient state readers.
 * Zones: file-backed actor state, JSON/JSONL diagnostics, inspect safety
 * Owns best-effort JSON and JSONL parsing helpers for operator-facing state reads.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, } from "node:fs";
function isEnoent(error) {
    return error.code === "ENOENT";
}
function diagnosticMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function readTextFileCapped(path, maxBytes, strictUtf8 = false) {
    if (maxBytes === undefined)
        return strictUtf8 ? new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)) : readFileSync(path, "utf8");
    const limit = Math.max(0, Math.floor(maxBytes));
    const fd = openSync(path, strictUtf8 ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) : "r");
    try {
        const opened = fstatSync(fd);
        if (strictUtf8 && !opened.isFile())
            throw new Error("bounded strict read requires a regular file");
        const size = opened.size;
        if (size > limit) {
            throw Object.assign(new Error(`file exceeds bounded read limit (${size} > ${limit} bytes)`), { code: "EFBIG" });
        }
        const content = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
            const bytesRead = readSync(fd, content, offset, size - offset, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        if (strictUtf8 && offset !== size)
            throw new Error("file ended before its bounded strict read completed");
        const observed = content.subarray(0, offset);
        return strictUtf8 ? new TextDecoder("utf-8", { fatal: true }).decode(observed) : observed.toString("utf8");
    }
    finally {
        closeSync(fd);
    }
}
export function readJsonFileResilient(path, fallback, options = {}) {
    try {
        return {
            diagnostics: [],
            value: JSON.parse(readTextFileCapped(path, options.maxBytes, options.strictUtf8)),
        };
    }
    catch (error) {
        if (isEnoent(error))
            return { diagnostics: [], value: fallback };
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
export function readJsonlFileResilient(path, options = {}) {
    try {
        const records = [];
        const diagnostics = [];
        const lines = readTextFileCapped(path, options.maxBytes).split("\n");
        for (const [index, line] of lines.entries()) {
            if (!line.trim())
                continue;
            try {
                records.push(JSON.parse(line));
            }
            catch (error) {
                diagnostics.push({
                    line: index + 1,
                    message: diagnosticMessage(error),
                    path,
                });
            }
        }
        return { diagnostics, records };
    }
    catch (error) {
        if (isEnoent(error))
            return { diagnostics: [], records: [] };
        return {
            diagnostics: [
                {
                    message: diagnosticMessage(error),
                    path,
                },
            ],
            records: [],
            ...(error.code === "EFBIG"
                ? { truncated: true }
                : {}),
        };
    }
}
export function formatStateReadDiagnostics(diagnostics, limit = 5) {
    return diagnostics.slice(0, limit).map((diagnostic) => {
        const line = diagnostic.line === undefined ? "" : `:${diagnostic.line}`;
        return `${diagnostic.path}${line}: ${diagnostic.message}`;
    });
}
