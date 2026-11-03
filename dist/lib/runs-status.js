/**
 * Async run status and log readers.
 * Owns: status derivation, readonly canonical snapshot-fact admission and bounded log/event tails.
 * Excludes: snapshot timing/visibility authority, export publication, scheduling and native scope closure.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { types as UtilTypes } from "node:util";
import { RUN_DELIVERY_MODEL_MAX_BYTES } from "./limits.js";
import { readRunContextIdentity, readRunContextIndex, RUN_CONTEXT_INDEX_FILE, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "./runs-context-index.js";
import { RUN_OUTCOME_PROTOCOL, RUN_STOP_CLAIM_FILE, isRunStopResultCapture, readRunNaturalOutcomeSnapshot, readRunStopClaim } from "./runs-outcomes.js";
import { RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.js";
import { isAlive, observeRunProcessExit, readWindowsProcessIdentities, WINDOWS_IDENTITY_QUERY_PID_LIMIT, verifyRunProcessIdentity, } from "./runs-process.js";
import { readJsonFileResilient, readJsonlFileResilient } from "./state-readers.js";
function getInterruptedRunStatus(stateDir) {
    const trace = readJsonlFileResilient(join(stateDir, "trace.jsonl")).records.slice(-200);
    for (const event of trace.reverse()) {
        if (event.kind === "run.kill")
            return "killed";
        if (event.kind === "run.cancel")
            return "cancelled";
    }
    const legacyEvents = readJsonlFileResilient(join(stateDir, "events.jsonl")).records.slice(-200);
    for (const event of legacyEvents.reverse()) {
        if (event.event === "run.kill")
            return "killed";
        if (event.event === "run.cancel")
            return "cancelled";
    }
    return undefined;
}
export function buildRunStatus(stateDir, runOrDir, meta, readJson, _runnerPath, _runnerIdentityGraceMs) {
    return deriveRunStatus(stateDir, meta, readJson, (pid, expected) => verifyRunProcessIdentity(pid, expected));
}
function deriveRunStatus(stateDir, meta, readJson, observeIdentity) {
    const snapshot = readRunNaturalOutcomeSnapshot(stateDir, meta, readJson);
    const rawResult = snapshot.result;
    const staleResult = rawResult?.run_instance_id !== undefined && rawResult.run_instance_id !== meta.run_instance_id;
    const result = staleResult ? undefined : rawResult;
    const stop = readRunStopClaim(stateDir, meta);
    const unresolvedCapture = isRunStopResultCapture(result);
    const natural = snapshot.outcome;
    const stopping = natural.state !== "accepted" && (stop.state === "pending" || stop.state === "invalid" || unresolvedCapture);
    const pid = Number(meta.pid || 0);
    const processIdentity = observeIdentity(pid, meta.process_identity);
    const aliveOwnedRunner = Boolean(pid &&
        (processIdentity.valid || processIdentity.status === "unsupported_proof"));
    const status = natural.state === "accepted"
        ? natural.status
        : stopping
            ? "running"
            : result
                ? Number(result.code ?? 0) === 0
                    ? "done"
                    : "failed"
                : aliveOwnedRunner
                    ? "running"
                    : (getInterruptedRunStatus(stateDir) ?? "exited");
    const terminalHandled = readJson(join(stateDir, "terminal-handled.json"));
    const terminalDeliveryFailure = readJson(join(stateDir, "terminal-delivery-failure.json"));
    return {
        ...meta,
        traceFile: join(stateDir, "trace.jsonl"),
        executionFile: join(stateDir, "execution.json"),
        process_identity_status: processIdentity.status,
        ...(stopping ? { phase: "stopping", stopped: false } : {}),
        ...(stopping && stop.state === "pending" ? { stop_reason: stop.claim.reason, stop_claim_id: stop.claim.claim_id } : {}),
        ...(stop.state === "invalid" || (unresolvedCapture && stop.state !== "pending")
            ? { stop_error: "claim_unavailable" } : {}),
        ...(staleResult ? { result_error: "generation_mismatch" } : {}),
        progress: readJson(join(stateDir, "progress.json")) || null,
        result: result || null,
        ...(terminalDeliveryFailure
            ? { terminal_delivery_failure: terminalDeliveryFailure } : {}),
        ...(terminalHandled ? { terminal_handled: terminalHandled } : {}),
        state_dir: String(meta.state_dir ?? stateDir),
        stderrLog: join(stateDir, "stderr.log"),
        stdoutLog: join(stateDir, "stdout.log"),
        status,
    };
}
function readInventorySource(path) {
    let fd;
    try {
        const stamp = snapshotStamp(path);
        if (!stamp?.isFile() || stamp.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
            return undefined;
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== stamp.dev || opened.ino !== stamp.ino || !opened.isFile() || opened.size !== stamp.size ||
            opened.mtimeNs !== stamp.mtimeNs || opened.ctimeNs !== stamp.ctimeNs)
            return undefined;
        const bytes = Buffer.alloc(Number(stamp.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count)
                return undefined;
            offset += count;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
            !sameSnapshotStamp(stamp, path))
            return undefined;
        const after = fstatSync(fd, { bigint: true });
        return after.size === stamp.size && after.mtimeNs === stamp.mtimeNs && after.ctimeNs === stamp.ctimeNs ? { stamp, bytes } : undefined;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function admitInventoryRow(stateDir) {
    const path = join(stateDir, "run.json");
    const markerPath = join(stateDir, RUN_STATE_OWNERSHIP_FILE);
    const source = readInventorySource(path);
    if (!source)
        return undefined;
    let meta;
    try {
        meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes));
    }
    catch {
        return undefined;
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.state_dir !== stateDir ||
        typeof meta.pid !== "number" || !Number.isSafeInteger(meta.pid) || meta.pid <= 0)
        return undefined;
    const expected = meta.process_identity;
    if (!expected || expected.platform !== "win32" || typeof expected.command !== "string" ||
        typeof expected.start_time !== "string" || (expected.cwd !== undefined && typeof expected.cwd !== "string"))
        return undefined;
    const owner = readRunContextIdentity(stateDir, meta);
    if (owner.state !== "available" || owner.local_path !== stateDir)
        return undefined;
    const marker = readInventorySource(markerPath);
    if (!marker)
        return undefined;
    const unchanged = () => {
        if (!owner.unchanged() || !sameSnapshotStamp(source.stamp, path) || !sameSnapshotStamp(marker.stamp, markerPath))
            return false;
        const current = readInventorySource(path);
        const currentMarker = readInventorySource(markerPath);
        return !!current && !!currentMarker && source.bytes.equals(current.bytes) && marker.bytes.equals(currentMarker.bytes) && owner.unchanged();
    };
    // Once admitted, a changed row can only be discarded, never reread through the scalar facade.
    return { meta, pid: meta.pid, expected, unchanged };
}
/** Fixed kernel inventory path. Native frames are synchronous locals, never capabilities returned to consumers. */
export function readRunInventoryStatuses(stateDirs, readJson, scalarStatus) {
    const scalar = (stateDir) => { try {
        return scalarStatus(stateDir);
    }
    catch {
        return undefined;
    } };
    if (platform() !== "win32")
        return stateDirs.map(scalar);
    const rows = stateDirs.map(stateDir => { try {
        return admitInventoryRow(stateDir);
    }
    catch {
        return undefined;
    } });
    // This selects optional acquisition only; assembly still verifies freshly and excluded rows retain scalar fallback.
    const pids = [...new Set(rows.flatMap(row => row ? [row.pid] : []))].filter(isAlive);
    const observations = new Map();
    for (let offset = 0; offset < pids.length; offset += WINDOWS_IDENTITY_QUERY_PID_LIMIT) {
        const chunk = pids.slice(offset, offset + WINDOWS_IDENTITY_QUERY_PID_LIMIT);
        const identities = readWindowsProcessIdentities(chunk);
        for (const pid of chunk)
            observations.set(pid, identities);
    }
    const statuses = stateDirs.map((stateDir, index) => {
        const row = rows[index];
        if (!row)
            return scalar(stateDir);
        try {
            if (!row.unchanged())
                return undefined;
            const identities = observations.get(row.pid);
            const status = deriveRunStatus(stateDir, row.meta, readJson, () => {
                if (!row.unchanged())
                    throw new Error("Inventory frame changed");
                const identity = identities === undefined ? verifyRunProcessIdentity(row.pid, row.expected)
                    : verifyRunProcessIdentity(row.pid, row.expected, "win32", pid => identities.get(pid));
                if (!row.unchanged())
                    throw new Error("Inventory frame changed");
                return identity;
            });
            return row.unchanged() ? status : undefined;
        }
        catch {
            return undefined;
        }
    });
    // Later row assembly can reenter file readers and invalidate an earlier assembled row.
    return statuses.map((status, index) => {
        const row = rows[index];
        if (!status || !row)
            return status;
        try {
            return row.unchanged() ? status : undefined;
        }
        catch {
            return undefined;
        }
    });
}
function snapshotStamp(path) {
    try {
        return lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function sameSnapshotStamp(before, path) {
    const after = snapshotStamp(path);
    return before === undefined ? after === undefined : after !== undefined && before.dev === after.dev && before.ino === after.ino &&
        before.mode === after.mode && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function snapshotDeferred(value) {
    if (!UtilTypes.isPromise(value))
        return false;
    void Promise.prototype.then.call(value, undefined, () => { });
    return true;
}
function snapshotData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    for (let target = value; target; target = Object.getPrototypeOf(target)) {
        const then = Object.getOwnPropertyDescriptor(target, "then");
        if (then && (!Object.hasOwn(then, "value") || typeof then.value === "function"))
            return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(field => Object.hasOwn(field, "value"))
        ? Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value])) : undefined;
}
/** Kernel-local facts only. Opt-in timing must be the original retained owner's method, never actor data or a cached DTO. */
export function readRunSnapshotFacts(stateDir, expected, capturedAt, observeTime, observeFrozenNaturalTime) {
    const unavailable = (reason) => Object.freeze({ state: "unavailable", reason });
    if ((observeTime !== undefined && typeof observeTime !== "function") ||
        (observeFrozenNaturalTime !== undefined && typeof observeFrozenNaturalTime !== "function") || typeof capturedAt !== "string" || capturedAt.length > 32)
        return unavailable("observation_unavailable");
    const capturedMs = Date.parse(capturedAt);
    if (!Number.isSafeInteger(capturedMs) || new Date(capturedMs).toISOString() !== capturedAt)
        return unavailable("observation_unavailable");
    const owner = readRunContextIdentity(stateDir, expected);
    if (owner.state !== "available")
        return unavailable(owner.reason);
    try {
        const root = owner.local_path;
        const metadataPath = join(root, "run.json");
        const resultPath = join(root, "result.json");
        const indexPath = join(root, RUN_CONTEXT_INDEX_FILE);
        const metadata = snapshotStamp(metadataPath);
        if (!metadata?.isFile() || metadata.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
            return unavailable("observation_unavailable");
        const read = readJsonFileResilient(metadataPath, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
        if (!owner.unchanged() || !sameSnapshotStamp(metadata, metadataPath))
            return unavailable("observation_changed");
        if (read.diagnostics.length || !read.value || typeof read.value !== "object" || Array.isArray(read.value))
            return unavailable("observation_unavailable");
        const meta = read.value;
        if (meta.run !== owner.identity.run || meta.run_instance_id !== owner.identity.run_instance_id || meta.ownerId !== owner.identity.ownerId || meta.state_dir !== root)
            return unavailable("identity_mismatch");
        if (typeof meta.cwd !== "string" || !isAbsolute(meta.cwd) || /[\u0000-\u001f\u007f]/u.test(meta.cwd))
            return unavailable("references_unavailable");
        if (meta.cwd.length > RUN_DELIVERY_MODEL_MAX_BYTES)
            return unavailable("snapshot_too_large");
        const result = snapshotStamp(resultPath);
        const index = snapshotStamp(indexPath);
        if (result && !result.isFile())
            return unavailable("observation_unavailable");
        const outcome = readRunNaturalOutcomeSnapshot(root, meta, path => {
            const canonical = readJsonFileResilient(path, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
            return canonical.diagnostics.length ? undefined : canonical.value;
        });
        const natural = outcome.outcome;
        const context = readRunContextIndex(root, owner.identity);
        const stopPath = join(root, RUN_STOP_CLAIM_FILE);
        let stopObserved = false;
        let stopStamp;
        let timingUnchanged;
        const frameUnchanged = () => owner.unchanged() && sameSnapshotStamp(metadata, metadataPath) &&
            sameSnapshotStamp(result, resultPath) && sameSnapshotStamp(index, indexPath) && (!stopObserved || sameSnapshotStamp(stopStamp, stopPath));
        const unchanged = () => {
            try {
                if (!frameUnchanged())
                    return false;
                if (!timingUnchanged)
                    return true;
                const stable = timingUnchanged();
                return !snapshotDeferred(stable) && stable === true && frameUnchanged();
            }
            catch {
                return false;
            }
        };
        if (!unchanged())
            return unavailable("observation_changed");
        let lifecycle = meta.outcome_protocol === RUN_OUTCOME_PROTOCOL && natural.state === "accepted"
            ? Object.freeze({ status: natural.status }) : Object.freeze({ status: "unproven" });
        let timing = Object.freeze({ basis: "unproven" });
        if (observeFrozenNaturalTime && meta.outcome_protocol === RUN_OUTCOME_PROTOCOL && natural.state === "accepted") {
            const retained = observeFrozenNaturalTime(owner.identity, root);
            if (snapshotDeferred(retained))
                return unavailable("observation_unavailable");
            const frozen = snapshotData(retained);
            if (!frozen)
                return unavailable("observation_unavailable");
            if (frozen.state === "available") {
                const identity = snapshotData(frozen.identity);
                const accepted = snapshotData(frozen.natural_acceptance);
                if (!identity || identity.run !== owner.identity.run || identity.run_instance_id !== owner.identity.run_instance_id || identity.ownerId !== owner.identity.ownerId)
                    return unavailable("identity_mismatch");
                if (frozen.basis !== "first_natural_acceptance" || !accepted || accepted.recorded_status !== natural.status || accepted.code !== outcome.result?.code ||
                    accepted.completed_at !== outcome.result?.completedAt || typeof frozen.elapsed_ms !== "number" || !Number.isSafeInteger(frozen.elapsed_ms) || frozen.elapsed_ms < 0 ||
                    typeof frozen.unchanged !== "function")
                    return unavailable("observation_unavailable");
                timingUnchanged = frozen.unchanged;
                timing = Object.freeze({ basis: "terminal", elapsed_ms: frozen.elapsed_ms });
            }
            else if (frozen.state !== "unavailable")
                return unavailable("observation_unavailable");
            if (!unchanged())
                return unavailable("observation_changed");
        }
        if (observeTime && meta.outcome_protocol === RUN_OUTCOME_PROTOCOL && (natural.state === "absent" || natural.state === "captured") &&
            typeof meta.pid === "number" && Number.isSafeInteger(meta.pid) && meta.pid > 0) {
            stopObserved = true;
            stopStamp = snapshotStamp(stopPath);
            const stop = readRunStopClaim(root, meta);
            const eligible = (natural.state === "absent" && (stop.state === "absent" || stop.state === "stale" || stop.state === "pending")) ||
                (natural.state === "captured" && stop.state === "pending" && outcome.result?.stop_claim_id === stop.claim.claim_id);
            if (eligible && observeRunProcessExit(meta.pid, meta.process_identity).status === "running") {
                if (!unchanged())
                    return unavailable("observation_changed");
                const sampled = observeTime(owner.identity, root);
                if (snapshotDeferred(sampled))
                    return unavailable("observation_unavailable");
                const observed = snapshotData(sampled);
                if (!observed)
                    return unavailable("observation_unavailable");
                if (observed.state === "available") {
                    const identity = snapshotData(observed.identity);
                    const measured = snapshotData(observed.timing);
                    if (!identity || identity.run !== owner.identity.run || identity.run_instance_id !== owner.identity.run_instance_id || identity.ownerId !== owner.identity.ownerId)
                        return unavailable("identity_mismatch");
                    if (observed.basis !== "since_admission" || !measured || typeof observed.unchanged !== "function")
                        return unavailable("observation_unavailable");
                    timingUnchanged = observed.unchanged;
                    lifecycle = Object.freeze({ status: "running", ...(stop.state === "pending" ? { phase: "stopping" } : {}) });
                    if (measured.state === "available" && typeof measured.elapsed_ms === "number" && Number.isSafeInteger(measured.elapsed_ms) && measured.elapsed_ms >= 0) {
                        timing = Object.freeze({ basis: "live", elapsed_ms: measured.elapsed_ms });
                    }
                    else if (measured.state !== "unproven" || measured.elapsed_ms !== null)
                        return unavailable("observation_unavailable");
                }
                else if (observed.state !== "unavailable")
                    return unavailable("observation_unavailable");
                if (!unchanged() || observeRunProcessExit(meta.pid, meta.process_identity).status !== "running" || !unchanged())
                    return unavailable("observation_changed");
            }
        }
        const facts = Object.freeze({ identity: owner.identity, captured_at: capturedAt,
            lifecycle, timing, cwd: meta.cwd,
            ...(context.state === "available" ? { context_index: Object.freeze({ identity: context.identity, path: context.local_path }) } : {}) });
        if (Buffer.byteLength(JSON.stringify(facts)) > RUN_DELIVERY_MODEL_MAX_BYTES)
            return unavailable("snapshot_too_large");
        return unchanged() ? Object.freeze({ state: "available", facts, unchanged }) : unavailable("observation_changed");
    }
    catch {
        return unavailable("observation_unavailable");
    }
}
export function tailFile(path, lines) {
    if (!existsSync(path))
        return "";
    const content = readFileSync(path, "utf8").trimEnd();
    if (!content)
        return "";
    return content.split("\n").slice(-lines).join("\n");
}
export function tailLines(path, lines) {
    const content = tailFile(path, lines);
    return content ? content.split("\n") : [];
}
