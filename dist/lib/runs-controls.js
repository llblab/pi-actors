/**
 * Run Control journal.
 * Zones: durable records, atomic admission, claims, transitions, compaction
 * Owns Run-local Control persistence; lifecycle authorization and transport stay in adapters.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Control from "./control.js";
import { acquireFileMutationLock, writeTextAtomic } from "./file-state.js";
import * as Limits from "./limits.js";
import { classifyRunControlRecord, computeRunControlCapacity, decideRunControlAdmission, runControlStatusTimestamp, } from "./run-evidence-policy.js";
export { RUN_CONTROL_TERMINAL_LIMIT } from "./limits.js";
function admissionError(details) {
    return Object.assign(new Error(details.reason === "control_backpressure"
        ? `Run Control admission backpressured: pending=${details.pending}/${details.limit}`
        : `Run Control journal integrity failed: ${details.integrity_reason ?? "unknown"}`), details);
}
const STATUSES = new Set([
    "queued", "delivered", "claimed", "handled", "failed",
]);
export function runControlsFile(stateDir) {
    return join(stateDir, "controls.jsonl");
}
export function readRunControlJournalFromStateDir(stateDir) {
    const path = runControlsFile(stateDir);
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { diagnostics: [], records: [] };
        return { diagnostics: [{ message: String(error), path }], records: [] };
    }
    try {
        const bytes = fstatSync(fd).size;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Limits.RUN_CONTROL_JOURNAL_MAX_BYTES) {
            return { diagnostics: [{ message: "Run Control journal exceeds bounded read limit", path }], records: [] };
        }
        const buffer = Buffer.allocUnsafe(bytes);
        let consumed = 0;
        while (consumed < bytes) {
            const count = readSync(fd, buffer, consumed, bytes - consumed, consumed);
            if (count === 0)
                return { diagnostics: [{ message: "Run Control journal changed during bounded read", path }], records: [] };
            consumed += count;
        }
        if (fstatSync(fd).size !== bytes)
            return { diagnostics: [{ message: "Run Control journal changed during bounded read", path }], records: [] };
        const records = [];
        const diagnostics = [];
        for (const [index, line] of buffer.toString("utf8").split("\n").entries()) {
            if (!line.trim())
                continue;
            try {
                records.push(JSON.parse(line));
            }
            catch (error) {
                diagnostics.push({ line: index + 1, message: String(error), path });
            }
        }
        return { diagnostics, records };
    }
    catch (error) {
        return { diagnostics: [{ message: String(error), path }], records: [] };
    }
    finally {
        closeSync(fd);
    }
}
export function readRunControlsFromStateDir(stateDir) {
    return readRunControlJournalFromStateDir(stateDir).records;
}
function acquireRunControlsLock(stateDir) {
    return acquireFileMutationLock(runControlsFile(stateDir));
}
function compactRunControls(records) {
    const active = records.filter((record) => classifyRunControlRecord(record) !== "terminal");
    const terminal = records.filter((record) => classifyRunControlRecord(record) === "terminal")
        .slice(-Limits.RUN_CONTROL_TERMINAL_LIMIT);
    const retained = new Set([...active, ...terminal]);
    return records.filter((record) => retained.has(record)).map((record) => typeof record.error === "string" && Buffer.byteLength(record.error) > Limits.RUN_CONTROL_ERROR_MAX_BYTES
        ? { ...record, error: boundedControlError(record.error) } : record);
}
function encodeRunControls(records) {
    return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}
function boundedControlError(value) {
    if (Buffer.byteLength(value) <= Limits.RUN_CONTROL_ERROR_MAX_BYTES)
        return value;
    const suffix = "… [truncated]";
    const limit = Limits.RUN_CONTROL_ERROR_MAX_BYTES - Buffer.byteLength(suffix);
    const bytes = Buffer.from(value);
    let end = limit;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80)
        end -= 1;
    return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}
function writeRunControls(stateDir, records) {
    const encoded = encodeRunControls(compactRunControls(records));
    if (Buffer.byteLength(encoded) > Limits.RUN_CONTROL_JOURNAL_MAX_BYTES) {
        throw new Error("Run Control journal transition exceeds bounded byte limit");
    }
    writeTextAtomic(runControlsFile(stateDir), encoded);
}
function readMutableRunControls(stateDir, runInstanceId) {
    const journal = readRunControlJournalFromStateDir(stateDir);
    if (journal.diagnostics.length)
        return undefined;
    const records = journal.records;
    if (runInstanceId && records.some((record) => controlIntegrity(record, runInstanceId) !== "valid"))
        return undefined;
    return records;
}
function controlIntegrity(value, runInstanceId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return "invalid_record";
    const record = value;
    if (typeof record.id !== "string" || !record.id ||
        typeof record.run_instance_id !== "string" || !record.run_instance_id ||
        typeof record.status !== "string" || !STATUSES.has(record.status) ||
        (record.error !== undefined && typeof record.error !== "string"))
        return "invalid_record";
    try {
        Control.normalizeControlAction(record.action);
        if (record.input !== undefined)
            Control.normalizeControlInput(record.input);
    }
    catch {
        return "invalid_record";
    }
    const timestamp = runControlStatusTimestamp(record, record.status);
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))
        return "invalid_status_timestamp";
    if (classifyRunControlRecord(record) === "pending" &&
        record.run_instance_id !== runInstanceId)
        return "generation_mismatch";
    return "valid";
}
export function appendRunControlInStateDir(stateDir, request) {
    const action = Control.normalizeControlAction(request.action);
    const input = request.input === undefined ? undefined : Control.normalizeControlInput(request.input);
    const record = {
        id: randomUUID(),
        run_instance_id: request.run_instance_id,
        action,
        ...(input !== undefined ? { input } : {}),
        status: "queued",
        queued_at: new Date().toISOString(),
    };
    const encodedRecordBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    const releaseLock = acquireRunControlsLock(stateDir);
    try {
        const path = runControlsFile(stateDir);
        let bytes = 0;
        try {
            bytes = statSync(path).size;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                bytes = Number.MAX_SAFE_INTEGER;
        }
        const journal = bytes > Limits.RUN_CONTROL_JOURNAL_MAX_BYTES
            ? { diagnostics: [], records: [] } : readRunControlJournalFromStateDir(stateDir);
        let integrity = bytes > Limits.RUN_CONTROL_JOURNAL_MAX_BYTES
            ? "journal_bytes"
            : journal.diagnostics.some((item) => item.line !== undefined)
                ? "malformed"
                : journal.diagnostics.length ? "unreadable" : "valid";
        for (const value of journal.records) {
            if (integrity !== "valid")
                break;
            integrity = controlIntegrity(value, request.run_instance_id);
        }
        const records = journal.records;
        const retained = encodeRunControls(compactRunControls(records));
        const decision = decideRunControlAdmission({
            integrity,
            journalBytes: bytes,
            newRecordBytes: encodedRecordBytes,
            records,
            retainedJournalBytes: Buffer.byteLength(retained),
            runInstanceId: request.run_instance_id,
            capacity: computeRunControlCapacity(records),
        });
        if (!decision.admitted)
            throw admissionError(decision.error);
        writeTextAtomic(path, `${retained}${JSON.stringify(record)}\n`);
        return record;
    }
    finally {
        releaseLock();
    }
}
export function updateRunControlStatusInStateDir(stateDir, id, nextStatus, metadata = {}, expectedStatuses) {
    const releaseLock = acquireRunControlsLock(stateDir);
    try {
        const records = readMutableRunControls(stateDir);
        if (!records)
            return false;
        const index = records.findIndex((record) => record.id === id);
        if (index < 0)
            return false;
        const record = records[index];
        if (records.some((value) => controlIntegrity(value, record.run_instance_id) !== "valid"))
            return false;
        if (expectedStatuses && !expectedStatuses.includes(record.status))
            return false;
        if (record.status === nextStatus)
            return false;
        const timestamp = new Date().toISOString();
        if (nextStatus === "delivered") {
            if (record.delivered_at)
                return false;
            records[index] = { ...record, delivered_at: timestamp,
                ...(record.status === "queued" ? { status: "delivered" } : {}) };
        }
        else {
            if (classifyRunControlRecord(record) === "terminal" || nextStatus === "queued")
                return false;
            if ((nextStatus === "claimed" && record.status !== "queued" &&
                record.status !== "delivered") ||
                (nextStatus === "handled" && record.status !== "claimed"))
                return false;
            records[index] = { ...record,
                ...(metadata.error !== undefined ? { error: boundedControlError(metadata.error) } : {}),
                [`${nextStatus}_at`]: timestamp, status: nextStatus };
        }
        writeRunControls(stateDir, records);
        return true;
    }
    finally {
        releaseLock();
    }
}
function claimRunControl(stateDir, runInstanceId, controlId) {
    const releaseLock = acquireRunControlsLock(stateDir);
    try {
        const records = readMutableRunControls(stateDir, runInstanceId);
        if (!records)
            return undefined;
        const index = records.findIndex((record) => (controlId === undefined || record.id === controlId) &&
            record.run_instance_id === runInstanceId &&
            (record.status === "queued" || record.status === "delivered"));
        if (index < 0)
            return undefined;
        const claimed = {
            ...records[index], claimed_at: new Date().toISOString(), status: "claimed"
        };
        records[index] = claimed;
        writeRunControls(stateDir, records);
        return claimed;
    }
    finally {
        releaseLock();
    }
}
export function claimRunControlInStateDir(stateDir, runInstanceId) {
    return claimRunControl(stateDir, runInstanceId);
}
export function claimRunControlByIdInStateDir(stateDir, runInstanceId, controlId) {
    return claimRunControl(stateDir, runInstanceId, controlId);
}
export async function processRunControlsInStateDir(stateDir, runInstanceId, handler, limit = 1) {
    const result = { claimed: 0, failed: 0, handled: 0 };
    for (let index = 0; index < Math.max(1, limit); index += 1) {
        const control = claimRunControlInStateDir(stateDir, runInstanceId);
        if (!control)
            break;
        result.claimed += 1;
        try {
            await handler(control);
            if (updateRunControlStatusInStateDir(stateDir, control.id, "handled", {}, ["claimed"]))
                result.handled += 1;
        }
        catch (error) {
            if (updateRunControlStatusInStateDir(stateDir, control.id, "failed", { error: error instanceof Error ? error.message : String(error) }, ["claimed"]))
                result.failed += 1;
        }
    }
    return result;
}
