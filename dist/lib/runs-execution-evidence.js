/**
 * Owned-generation execution evidence and explicit kernel source selection.
 * Owns: data-only manifest projection, recorded capture/session reference admission and checked canonical runner stream input.
 * Excludes: raw-body exposure permission, session discovery, primary-source completeness, producer/work authority and native closure.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { observeExecutionFileReference, readExecutionRunnerStreamText } from "./execution-files.js";
import { createRunRecipeEvidenceRedactor } from "./recipe-projection.js";
import { readRunContextIdentity, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "./runs-context-index.js";
import { readJsonFileResilient } from "./state-readers.js";
function manifestField(value, key) { return Object.hasOwn(value, key) ? value[key] : undefined; }
function count(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function code(value) { return typeof value === "number" && Number.isSafeInteger(value); }
function timestamp(value) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isSafeInteger(time) && new Date(time).toISOString() === value;
}
function capture(value) {
    const source = record(value);
    if (!source)
        return undefined;
    const saved = manifestField(source, "bytes");
    const observed = manifestField(source, "bytes_observed");
    const complete = manifestField(source, "complete");
    const error = manifestField(source, "error");
    if ((saved !== null && !count(saved)) || (observed !== undefined && !count(observed)) ||
        (complete !== undefined && typeof complete !== "boolean") || (error !== undefined && error !== "capture_write_failed") ||
        (typeof saved === "number" && typeof observed === "number" && saved > observed) || (error !== undefined && complete !== false))
        return undefined;
    return Object.freeze({ reported_saved_bytes: saved,
        persistence: complete === false ? "incomplete" : saved === null ? "unproven" : "reported_complete",
        ...(typeof observed === "number" ? { reported_observed_bytes: observed } : {}), ...(error ? { error } : {}) });
}
function attempt(value, ordinal) {
    const source = record(value);
    if (!source || manifestField(source, "attempt") !== ordinal || !code(manifestField(source, "code")))
        return undefined;
    const nativeCode = manifestField(source, "native_exit_code");
    const signal = manifestField(source, "native_signal");
    const killed = manifestField(source, "killed");
    if ((nativeCode !== undefined && nativeCode !== null && !code(nativeCode)) ||
        (signal !== undefined && (typeof signal !== "string" || !/^SIG[A-Z0-9]{1,31}$/u.test(signal))) ||
        (killed !== undefined && typeof killed !== "boolean"))
        return undefined;
    const stdout = capture(manifestField(source, "stdout"));
    const stderr = capture(manifestField(source, "stderr"));
    if (!stdout || !stderr)
        return undefined;
    return Object.freeze({ attempt: ordinal, code: source.code, stdout, stderr,
        ...(nativeCode !== undefined ? { native_exit_code: nativeCode } : {}),
        ...(typeof signal === "string" ? { native_signal: signal } : {}),
        ...(typeof killed === "boolean" ? { reported_killed: killed } : {}) });
}
/** Already-captured metadata is data, never a reconstructed producer/work/close capability. */
export function projectRunExecutionManifest(expected, value, recipe = {}, redactEvidence) {
    const invalid = () => Object.freeze({ state: "unavailable", reason: "manifest_invalid" });
    const identity = record(expected);
    const source = record(value);
    if (!identity || typeof manifestField(identity, "run") !== "string" || !identity.run ||
        typeof manifestField(identity, "run_instance_id") !== "string" || !identity.run_instance_id || !source || manifestField(source, "version") !== 1)
        return invalid();
    if (manifestField(source, "run") !== expected.run || manifestField(source, "run_instance_id") !== expected.run_instance_id) {
        return Object.freeze({ state: "unavailable", reason: "identity_mismatch" });
    }
    const status = manifestField(source, "status");
    const updated = manifestField(source, "updated_at");
    const active = manifestField(source, "active_subagents");
    const records = manifestField(source, "commands");
    if (typeof status !== "string" || !["running", "stopping", "done", "failed"].includes(status) || !timestamp(updated) ||
        !count(active) || !Array.isArray(records))
        return invalid();
    const redact = redactEvidence ?? createRunRecipeEvidenceRedactor(recipe);
    const commands = [];
    const ids = new Set();
    let attemptsReported = 0;
    for (const value of records) {
        const command = record(value);
        if (!command)
            return invalid();
        const id = manifestField(command, "id");
        const state = manifestField(command, "status");
        const rows = manifestField(command, "attempts");
        if (typeof id !== "string" || !/^command-[0-9]{3,}$/u.test(id) || !count(Number(id.slice(8))) || Number(id.slice(8)) === 0 || ids.has(id) ||
            typeof state !== "string" || !["running", "done", "failed", "interrupted"].includes(state) || !Array.isArray(rows))
            return invalid();
        ids.add(id);
        const attempts = [];
        for (const [index, row] of rows.entries()) {
            const item = attempt(row, index + 1);
            if (!item)
                return invalid();
            attempts.push(item);
        }
        const details = {};
        for (const key of ["stage", "command", "label"]) {
            const item = manifestField(command, key);
            if (item !== undefined) {
                if (typeof item !== "string")
                    return invalid();
                details[key] = redact(item);
            }
        }
        for (const key of ["occurrence", "branch_index", "prompt_bytes"]) {
            const item = manifestField(command, key);
            if (item !== undefined) {
                if (!count(item) || (key === "occurrence" && item === 0))
                    return invalid();
                details[key] = item;
            }
        }
        for (const key of ["started_at", "completed_at"]) {
            const item = manifestField(command, key);
            if (item !== undefined) {
                if (!timestamp(item))
                    return invalid();
                details[key] = item;
            }
        }
        for (const key of ["exit_code", "effective_exit_code", "native_exit_code"]) {
            const item = manifestField(command, key);
            if (item !== undefined) {
                if (!(key === "native_exit_code" && item === null) && !code(item))
                    return invalid();
                details[key] = item;
            }
        }
        const semantic = manifestField(command, "semantic_acceptance");
        if (semantic !== undefined) {
            if (typeof semantic !== "string" || !["pending", "accepted", "rejected", "not_required", "unavailable"].includes(semantic))
                return invalid();
            details.semantic_acceptance = semantic;
        }
        const killed = manifestField(command, "killed");
        if (killed !== undefined) {
            if (typeof killed !== "boolean")
                return invalid();
            details.reported_killed = killed;
        }
        const sessions = manifestField(command, "session_files");
        if (sessions !== undefined) {
            if (!Array.isArray(sessions) || sessions.some(file => typeof file !== "string"))
                return invalid();
            details.reported_session_file_count = sessions.length;
        }
        const interruption = record(manifestField(command, "interruption"));
        const message = interruption ? manifestField(interruption, "message") : undefined;
        if (typeof message === "string")
            details.interruption = redact(message);
        commands.push(Object.freeze({ id, reported_status: state, attempts: Object.freeze(attempts), ...details }));
        attemptsReported += attempts.length;
    }
    return Object.freeze({ state: "available", view: Object.freeze({ reported_status: status, updated_at: updated,
            reported_active_subagents: active, commands_total: commands.length, settled_attempts_reported: attemptsReported,
            commands: Object.freeze(commands) }) });
}
function streamUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Never serialize this raw source as tool/model evidence: an export owner still owes a fixed privacy projection. */
export function readRunStreamSource(stateDir, expected, stream) {
    if (stream !== "stdout" && stream !== "stderr")
        return streamUnavailable("stream_invalid");
    const owner = readRunContextIdentity(stateDir, expected);
    if (owner.state === "unavailable")
        return owner;
    const source = readExecutionRunnerStreamText(owner.local_path, stream);
    if (!owner.unchanged())
        return streamUnavailable("observation_changed");
    if (source.availability === "unavailable")
        return streamUnavailable(source.reason === "reference_changed" ? "observation_changed"
            : source.reason === "reference_missing" ? "stream_missing" : source.reason === "reference_too_large" ? "stream_too_large"
                : source.reason === "reference_invalid_text" ? "stream_invalid_text" : "stream_unavailable");
    const { reference, text } = source;
    const unchanged = () => owner.unchanged() && reference.unchanged();
    if (!unchanged())
        return streamUnavailable("observation_changed");
    return Object.freeze({ state: "available", identity: owner.identity, stream, source_scope: "canonical_runner_stream",
        visibility: "kernel_only", capture_completeness: "not_asserted", bytes_total: reference.bytes_total, text, unchanged });
}
function unavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function own(value, key) { return Object.getOwnPropertyDescriptor(value, key)?.value; }
function request(value) {
    const source = record(value);
    if (!source)
        return undefined;
    const kind = own(source, "kind");
    const command = own(source, "command_id");
    if (typeof command !== "string" || !/^command-[0-9]{3,}$/u.test(command) || !Number.isSafeInteger(Number(command.slice(8))) || Number(command.slice(8)) < 1)
        return undefined;
    if (kind === "capture") {
        const attempt = own(source, "attempt");
        const stream = own(source, "stream");
        return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 && (stream === "stdout" || stream === "stderr") &&
            Object.keys(source).every(key => ["kind", "command_id", "attempt", "stream"].includes(key))
            ? Object.freeze({ kind, command_id: command, attempt, stream }) : undefined;
    }
    const path = own(source, "path");
    return kind === "session" && typeof path === "string" && path.length > 0 && Object.keys(source).every(key => ["kind", "command_id", "path"].includes(key))
        ? Object.freeze({ kind, command_id: command, path }) : undefined;
}
function sameFile(left, right) {
    return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
/** Local paths and unchanged callbacks describe data only, never readable-body exposure or native capabilities. */
export function readRunExecutionReference(stateDir, expected, query) {
    const selected = request(query);
    if (!selected)
        return unavailable("request_invalid");
    const owner = readRunContextIdentity(stateDir, expected);
    if (owner.state === "unavailable")
        return unavailable(owner.reason);
    const sourcePath = join(owner.local_path, "execution.json");
    try {
        let before;
        try {
            before = lstatSync(sourcePath, { bigint: true });
        }
        catch (error) {
            return unavailable(error.code === "ENOENT" ? "manifest_absent" : "manifest_unavailable");
        }
        if (!before.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
            return unavailable("manifest_unavailable");
        const captured = readJsonFileResilient(sourcePath, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
        const sourceUnchanged = () => {
            try {
                return owner.unchanged() && sameFile(before, lstatSync(sourcePath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!sourceUnchanged())
            return unavailable("observation_changed");
        if (captured.diagnostics.length)
            return unavailable("manifest_invalid");
        const projected = projectRunExecutionManifest(owner.identity, captured.value);
        if (projected.state === "unavailable")
            return unavailable(projected.reason === "identity_mismatch" ? "manifest_identity_mismatch" : "manifest_invalid");
        const index = projected.view.commands.findIndex(command => command.id === selected.command_id);
        if (index < 0)
            return unavailable("reference_not_recorded");
        const command = record(captured.value).commands[index];
        const view = projected.view.commands[index];
        let relative;
        let capture;
        if (selected.kind === "capture") {
            const attempt = command.attempts[selected.attempt - 1];
            const reported = record(attempt?.[selected.stream]);
            if (!reported || !Object.hasOwn(reported, "path"))
                return unavailable("reference_not_recorded");
            relative = `captures/${selected.command_id}/attempt-${String(selected.attempt).padStart(3, "0")}/${selected.stream}.log`;
            if (reported.path !== relative)
                return unavailable("reference_invalid");
            capture = view.attempts[selected.attempt - 1][selected.stream];
        }
        else {
            if (!Array.isArray(command.session_files) || !command.session_files.includes(selected.path))
                return unavailable("reference_not_recorded");
            relative = selected.path;
        }
        const observed = observeExecutionFileReference(owner.local_path, { kind: selected.kind, path: relative });
        if (!sourceUnchanged())
            return unavailable("observation_changed");
        if (observed.availability === "unavailable")
            return unavailable(observed.reason === "invalid_reference" ? "reference_invalid" : observed.reason);
        if (!observed.unchanged())
            return unavailable("reference_changed");
        if (capture && capture.reported_saved_bytes !== null && capture.reported_saved_bytes !== observed.bytes_total)
            return unavailable("capture_size_mismatch");
        const base = { command_id: selected.command_id, path: observed.path, local_path: observed.local_path, bytes_total: observed.bytes_total, mutable: true };
        const reference = selected.kind === "capture"
            ? Object.freeze({ ...base, kind: "capture", attempt: selected.attempt, stream: selected.stream, capture: capture })
            : Object.freeze({ ...base, kind: "session" });
        return Object.freeze({ state: "available", identity: owner.identity, source_updated_at: projected.view.updated_at,
            reference, unchanged: () => sourceUnchanged() && observed.unchanged() });
    }
    catch {
        return unavailable("manifest_unavailable");
    }
}
