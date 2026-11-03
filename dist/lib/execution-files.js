/**
 * Execution-file layout and metadata observation beneath a caller-admitted Run state root.
 * Owns: capture/session/canonical-runner stream layout, metadata and bounded strict text inputs through a checked descriptor.
 * Excludes: Run/generation admission, unrestricted body exposure, discovery, privacy projection, historical-content or native authority.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { SESSION_EVIDENCE_MAX_BYTES } from "./limits.js";
export const RUN_STREAM_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
function unavailable(reason) { return Object.freeze({ availability: "unavailable", reason }); }
function sameObject(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) {
    return right.isFile() && sameObject(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function referencePath(request) {
    if (!request || typeof request !== "object" || Array.isArray(request))
        return undefined;
    const kind = Object.getOwnPropertyDescriptor(request, "kind")?.value;
    const path = Object.getOwnPropertyDescriptor(request, "path")?.value;
    if ((kind !== "session" && kind !== "capture" && kind !== "runner_stream") || typeof path !== "string" || !path || isAbsolute(path) || win32.isAbsolute(path) ||
        /[\\\u0000-\u001f\u007f]/u.test(path) || (process.platform === "win32" && path.includes(":")))
        return undefined;
    const parts = path.split("/");
    if (parts.some(part => !part || part === "." || part === ".."))
        return undefined;
    if (kind === "runner_stream")
        return path === "stdout.log" || path === "stderr.log" ? path : undefined;
    if (kind === "session")
        return parts[0] === "sessions" && parts.length >= 2 && parts.at(-1).endsWith(".jsonl") ? path : undefined;
    const capture = /^captures\/command-([0-9]{3,})\/attempt-([0-9]{3,})\/(stdout|stderr)\.log$/u.exec(path);
    return capture && capture.slice(1, 3).every(number => Number.isSafeInteger(Number(number)) && Number(number) > 0) ? path : undefined;
}
function inspectExecutionFile(stateDir, request, maxTextBytes) {
    const relative = referencePath(request);
    if (!relative)
        return unavailable("invalid_reference");
    try {
        const requestedRoot = resolve(stateDir);
        const root = lstatSync(requestedRoot, { bigint: true });
        if (!root.isDirectory() || root.isSymbolicLink())
            return unavailable("reference_unavailable");
        const canonicalRoot = realpathSync(requestedRoot);
        const canonical = lstatSync(canonicalRoot, { bigint: true });
        if (!canonical.isDirectory() || !sameObject(root, canonical))
            return unavailable("reference_changed");
        const directories = [{ path: requestedRoot, stamp: root }, { path: canonicalRoot, stamp: canonical }];
        const parts = relative.split("/");
        let directory = canonicalRoot;
        for (const part of parts.slice(0, -1)) {
            directory = join(directory, part);
            const stamp = lstatSync(directory, { bigint: true });
            if (!stamp.isDirectory() || stamp.isSymbolicLink())
                return unavailable("reference_unavailable");
            directories.push({ path: directory, stamp });
        }
        const path = join(canonicalRoot, ...parts);
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile())
            return unavailable("reference_unavailable");
        if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER))
            return unavailable("reference_size_unrepresentable");
        if (maxTextBytes !== undefined && before.size > BigInt(maxTextBytes))
            return Object.freeze({ availability: "unavailable", reason: "reference_too_large" });
        // Nonblocking/nofollow flags avoid waiting on a leaf replaced with a FIFO or following a leaf alias when supported.
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
            const opened = fstatSync(fd, { bigint: true });
            if (!sameFile(before, opened))
                return unavailable("reference_changed");
            const unchanged = () => {
                try {
                    return directories.every(directory => {
                        const current = lstatSync(directory.path, { bigint: true });
                        return current.isDirectory() && sameObject(directory.stamp, current);
                    }) && sameFile(opened, lstatSync(path, { bigint: true }));
                }
                catch {
                    return false;
                }
            };
            let text;
            if (maxTextBytes !== undefined) {
                const bytes = Buffer.alloc(Number(opened.size));
                let offset = 0;
                while (offset < bytes.length) {
                    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
                    if (!count)
                        return unavailable("reference_changed");
                    offset += count;
                }
                try {
                    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: !relative.startsWith("sessions/") }).decode(bytes);
                }
                catch {
                    return Object.freeze({ availability: "unavailable", reason: "reference_invalid_text" });
                }
            }
            if (!sameFile(opened, fstatSync(fd, { bigint: true })) || !unchanged())
                return unavailable("reference_changed");
            const reference = Object.freeze({ availability: "available", path: relative, local_path: path, bytes_total: Number(opened.size), mutable: true, unchanged });
            return text === undefined ? reference : Object.freeze({ availability: "available", reference, text });
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        return unavailable(error.code === "ENOENT" ? "reference_missing" : "reference_unavailable");
    }
}
/** Metadata-only: never reads body bytes, regardless of file size. */
export function observeExecutionFileReference(stateDir, request) {
    return inspectExecutionFile(stateDir, request);
}
/** Raw text is kernel-local input to an authorized projection, never a tool/model result. */
export function readExecutionSessionText(stateDir, path) {
    return inspectExecutionFile(stateDir, { kind: "session", path }, SESSION_EVIDENCE_MAX_BYTES);
}
/** Explicit command capture input only; neither this read nor its path authorizes publication. */
export function readExecutionCaptureText(stateDir, path) {
    return inspectExecutionFile(stateDir, { kind: "capture", path }, RUN_STREAM_SOURCE_MAX_BYTES);
}
/** Canonical runner text is kernel-local input, not complete command capture or a model-visible privacy projection. */
export function readExecutionRunnerStreamText(stateDir, stream) {
    if (stream !== "stdout" && stream !== "stderr")
        return unavailable("invalid_reference");
    return inspectExecutionFile(stateDir, { kind: "runner_stream", path: `${stream}.log` }, RUN_STREAM_SOURCE_MAX_BYTES);
}
