/**
 * Canonical Run clock binding and explicit runtime-local supervision ownership.
 * Owns: bounded readonly clock/frame admission, origin/reference retention, first-natural timing freezes, composed snapshots and cooperative same-origin controller claims.
 * Excludes: origin creation/backfill, global/cross-runtime leases, independent supervision/recovery, work/native authority and actuation.
 */
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readRunSupervisionClock, createRunSupervisionController, createRunSupervisionTimebase } from "./run-supervision.js";
import { readRunContextIdentity, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, RUN_CONTEXT_INDEX_METADATA_MAX_BYTES } from "./runs-context-index.js";
import { readOwnedRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.js";
import { readJsonFileResilient } from "./state-readers.js";
import { admitRunSnapshotReferenceReader } from "./runs-context-exports.js";
import { readRunSnapshotFacts } from "./runs-status.js";
import { projectRunSnapshot } from "./runs-snapshot.js";
import { withRunNaturalResultTimingAdmission, readRunNaturalResultTimingAcceptance } from "./runs-results.js";
function unavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
function sameObject(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a, b) {
    return b.isFile() && sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function observeBinding(stateDir, expected) {
    const owner = readRunContextIdentity(stateDir, expected);
    if (owner.state === "unavailable")
        return owner;
    try {
        const root = owner.local_path;
        const path = join(root, "run.json");
        const markerPath = join(root, RUN_STATE_OWNERSHIP_FILE);
        const directory = lstatSync(root, { bigint: true });
        const marker = lstatSync(markerPath, { bigint: true });
        const before = lstatSync(path, { bigint: true });
        if (!directory.isDirectory() || !marker.isFile() || !before.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
            return unavailable("clock_metadata_unavailable");
        const read = readJsonFileResilient(path, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
        const unchanged = () => {
            try {
                return owner.unchanged() && sameFile(before, lstatSync(path, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!unchanged())
            return unavailable("observation_changed");
        if (read.diagnostics.length || !read.value || typeof read.value !== "object" || Array.isArray(read.value))
            return unavailable("clock_metadata_unavailable");
        const meta = read.value;
        if (meta.run !== owner.identity.run || meta.run_instance_id !== owner.identity.run_instance_id || meta.ownerId !== owner.identity.ownerId || meta.state_dir !== root)
            return unavailable("identity_mismatch");
        let decoded;
        try {
            decoded = readRunSupervisionClock(meta);
        }
        catch {
            return unavailable("clock_invalid");
        }
        if (!decoded)
            return unavailable("clock_unconfigured");
        const clock = Object.freeze({ started_at: decoded.started_at, supervision: Object.freeze({ ...decoded.supervision }) });
        const frameUnchanged = () => {
            try {
                const current = lstatSync(root, { bigint: true });
                return current.isDirectory() && sameObject(directory, current) && sameFile(marker, lstatSync(markerPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!unchanged() || !frameUnchanged())
            return unavailable("observation_changed");
        return Object.freeze({ state: "available", identity: owner.identity, clock, unchanged, frameUnchanged });
    }
    catch {
        return unavailable("clock_metadata_unavailable");
    }
}
/** Curated metadata only; no current-time read, clock repair, lifecycle/native observation or role body. */
export function readRunSupervisionBinding(stateDir, expected) {
    const observed = observeBinding(stateDir, expected);
    return observed.state === "unavailable" ? observed : Object.freeze({ state: "available", identity: observed.identity, clock: observed.clock, unchanged: observed.unchanged });
}
/** Does not start automatically; origin must be the genuine reference retained from generation admission. */
export function createRunSupervisionControllerFromState(stateDir, expected, origin, ports) {
    const initial = observeBinding(stateDir, expected);
    if (initial.state === "unavailable")
        return initial;
    const timebase = createRunSupervisionTimebase(initial.clock, origin);
    if (timebase.state === "unavailable")
        return timebase;
    if (!initial.unchanged())
        return unavailable("observation_changed");
    const controller = createRunSupervisionController(initial.identity, timebase.timebase, {
        ...ports,
        readCurrent: () => {
            if (!initial.frameUnchanged())
                return null;
            const current = observeBinding(stateDir, initial.identity);
            if (current.state === "unavailable" || !current.unchanged() || !initial.frameUnchanged())
                return null;
            return Object.freeze({ identity: current.identity, clock: current.clock });
        },
    });
    return Object.freeze({ state: "available", controller });
}
// Cooperative claims share only genuine origins in this module/runtime, never persisted or native scope authority.
const sharedOriginClaims = new WeakMap();
function own(value, key) {
    return value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}
function ownerIdentity(value) {
    const run = own(value, "run");
    const generation = own(value, "run_instance_id");
    const descriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "ownerId") : undefined;
    const owner = descriptor?.value;
    if (typeof run !== "string" || !run || /[^A-Za-z0-9_.-]/u.test(run) || typeof generation !== "string" || !generation ||
        (descriptor && !Object.hasOwn(descriptor, "value")) || (owner !== undefined && (typeof owner !== "string" || !owner)))
        return undefined;
    return Object.freeze({ run, run_instance_id: generation, ...(owner === undefined ? {} : { ownerId: owner }) });
}
function ownerKey(identity) { return JSON.stringify([identity.run, identity.run_instance_id, identity.ownerId ?? null]); }
function retainAdmissionFrame(stateDir, run) {
    try {
        const directory = lstatSync(stateDir, { bigint: true });
        const markerPath = join(stateDir, RUN_STATE_OWNERSHIP_FILE);
        const marker = lstatSync(markerPath, { bigint: true });
        if (!directory.isDirectory() || !marker.isFile())
            return undefined;
        const unchanged = () => {
            try {
                const current = lstatSync(stateDir, { bigint: true });
                return current.isDirectory() && sameObject(directory, current) && sameFile(marker, lstatSync(markerPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        const owned = readOwnedRunStateDirectory(stateDir, { maxBytes: RUN_CONTEXT_INDEX_METADATA_MAX_BYTES });
        return owned.run === run && owned.stateDir === stateDir && unchanged() ? unchanged : undefined;
    }
    catch {
        return undefined;
    }
}
/** Explicit retention with cooperative same-origin claims; no default watcher, cross-process lease or independent supervisor. */
export function createRunSupervisionOwner(ports) {
    const schedule = ports.schedule;
    const notify = ports.onDeadlineDue;
    if (typeof notify !== "function" || (schedule !== undefined && typeof schedule !== "function"))
        throw new Error("Run supervision owner requires synchronous controller ports.");
    const retainedPorts = Object.freeze({ onDeadlineDue: notify.bind(ports), ...(schedule === undefined ? {} : { schedule: schedule.bind(ports) }) });
    const records = new Map();
    const origins = new WeakMap();
    let closed = false;
    let cleanupUnproven = false;
    const absent = (reason) => Object.freeze({ state: "unavailable", reason });
    const find = (expected) => {
        if (closed)
            return absent("owner_closed");
        const identity = ownerIdentity(expected);
        if (!identity)
            return absent("identity_invalid");
        return records.get(ownerKey(identity)) ?? absent("origin_not_retained");
    };
    const view = (record) => {
        const controller = record.controller?.snapshot();
        return record.stopped ? Object.freeze({ state: "stopped", identity: record.identity, ...(controller ? { controller } : {}) })
            : controller ? Object.freeze({ state: "controlled", identity: record.identity, controller })
                : Object.freeze({ state: "retained", identity: record.identity });
    };
    const snapshot = (expected) => { const record = find(expected); return "state" in record ? record : view(record); };
    const rememberCleanup = (record) => { if (record.controller?.snapshot().timer_cleanup === "unproven")
        cleanupUnproven = true; };
    const releaseClaim = (record) => { if (record.claim.holder === record.token)
        record.claim.holder = undefined; };
    const stopRecord = (record) => {
        if (record.stopped)
            return;
        record.stopped = true;
        record.controller?.stop();
        rememberCleanup(record);
    };
    const revokedRecord = (record) => {
        if (closed)
            return absent("owner_closed");
        if (records.get(ownerKey(record.identity)) !== record)
            return absent("origin_not_retained");
        if (record.stopped)
            return Object.freeze({ state: "unavailable", reason: "owner_stopped" });
        if (!record.frameUnchanged())
            return absent("observation_changed");
        // Frame ports are synchronous, but can reenter this owner; never let their last read hide revocation.
        if (closed)
            return absent("owner_closed");
        if (records.get(ownerKey(record.identity)) !== record)
            return absent("origin_not_retained");
        return record.stopped ? Object.freeze({ state: "unavailable", reason: "owner_stopped" }) : undefined;
    };
    const owner = Object.freeze({
        onSupervisionClockCaptured: (capture) => {
            if (closed)
                throw new Error("Run supervision owner is closed.");
            const identity = ownerIdentity(own(capture, "identity"));
            const stateDir = own(capture, "state_dir");
            const origin = own(capture, "origin");
            const metadata = own(capture, "clock");
            if (own(capture, "kind") !== "run_clock_origin_captured" || own(capture, "visibility") !== "kernel_only" ||
                own(capture, "publication") !== "unpublished" || own(capture, "work_started") !== false ||
                !identity || typeof stateDir !== "string" || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir || !origin || typeof origin !== "object") {
                throw new Error("Run supervision clock capture is invalid.");
            }
            const referenceDescriptor = Object.getOwnPropertyDescriptor(capture, "snapshot_references");
            const references = referenceDescriptor && Object.hasOwn(referenceDescriptor, "value")
                ? admitRunSnapshotReferenceReader(stateDir, identity, referenceDescriptor.value) : undefined;
            if (referenceDescriptor && !references)
                throw new Error("Run supervision snapshot-reference capture is invalid.");
            const key = ownerKey(identity);
            const existing = records.get(key);
            let decoded;
            const policy = own(metadata, "supervision");
            try {
                decoded = readRunSupervisionClock({ started_at: own(metadata, "started_at"), supervision: {
                        report_every_ms: own(policy, "report_every_ms"), max_runtime_ms: own(policy, "max_runtime_ms"), deadline_at: own(policy, "deadline_at"),
                    }, ...(metadata && typeof metadata === "object" && Object.hasOwn(metadata, "createdAt") ? { createdAt: own(metadata, "createdAt") } : {}) });
            }
            catch {
                throw new Error("Run supervision clock capture is invalid.");
            }
            if (!decoded)
                throw new Error("Run supervision clock capture is invalid.");
            const clockKey = JSON.stringify(decoded);
            if (existing) {
                if (existing.origin !== origin || existing.stateDir !== stateDir || existing.clockKey !== clockKey || existing.references !== references || !existing.frameUnchanged()) {
                    throw new Error("Run supervision clock capture conflicts with retained identity, state or origin.");
                }
                return;
            }
            if (origins.has(origin))
                throw new Error("Run supervision origin is already retained or released by this owner.");
            const timebase = createRunSupervisionTimebase(decoded, origin);
            if (timebase.state === "unavailable")
                throw new Error("Run supervision clock capture origin is unavailable or incompatible.");
            const frameUnchanged = retainAdmissionFrame(stateDir, identity.run);
            if (!frameUnchanged)
                throw new Error("Run supervision admission state frame is unavailable or changed.");
            const binding = JSON.stringify([stateDir, key]);
            let claim = sharedOriginClaims.get(origin);
            if (claim && claim.binding !== binding)
                throw new Error("Run supervision origin binding already belongs to another identity or state.");
            if (claim && !claim.frameUnchanged())
                throw new Error("Run supervision origin admission frame changed.");
            if (closed)
                throw new Error("Run supervision owner is closed.");
            if (records.has(key) || origins.has(origin))
                throw new Error("Run supervision origin is already retained or released by this owner.");
            if (!claim) {
                claim = { binding, frameUnchanged };
                sharedOriginClaims.set(origin, claim);
            }
            records.set(key, { identity, stateDir, origin, clockKey, references, frameUnchanged: claim.frameUnchanged, claim, token: {}, stopped: false });
            origins.set(origin, key);
        },
        start: (expected) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            if (record.stopped)
                return view(record);
            if (!record.controller) {
                if (!record.frameUnchanged())
                    return absent("observation_changed");
                if (record.claim.holder && record.claim.holder !== record.token)
                    return absent("controller_claimed");
                record.claim.holder = record.token;
                try {
                    const scheduleWake = retainedPorts.schedule;
                    const controllerPorts = scheduleWake ? { ...retainedPorts, schedule: (wake, milliseconds) => scheduleWake(() => { try {
                            wake();
                        }
                        finally {
                            rememberCleanup(record);
                        } }, milliseconds) } : retainedPorts;
                    const reading = createRunSupervisionControllerFromState(record.stateDir, record.identity, record.origin, controllerPorts);
                    if (reading.state === "unavailable")
                        return reading;
                    if (!record.frameUnchanged()) {
                        reading.controller.stop();
                        return absent("observation_changed");
                    }
                    if (closed || records.get(ownerKey(record.identity)) !== record || record.stopped) {
                        reading.controller.stop();
                        return snapshot(expected);
                    }
                    record.controller = reading.controller;
                }
                finally {
                    if (!record.controller)
                        releaseClaim(record);
                }
            }
            record.controller.start();
            rememberCleanup(record);
            return snapshot(expected);
        },
        stop: (expected) => { const record = find(expected); if ("state" in record)
            return record; stopRecord(record); return view(record); },
        release: (expected) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            stopRecord(record);
            releaseClaim(record);
            records.delete(ownerKey(record.identity));
            const controller = record.controller?.snapshot();
            return Object.freeze({ state: "released", identity: record.identity, ...(controller ? { controller } : {}) });
        },
        snapshot,
        observeReferences: (expected, stateDir) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            if (stateDir !== undefined && stateDir !== record.stateDir)
                return absent("identity_mismatch");
            const revoked = () => revokedRecord(record);
            const initial = revoked();
            if (initial)
                return initial;
            if (!record.references)
                return Object.freeze({ state: "unavailable", reason: "references_not_retained" });
            const reading = record.references.read();
            const afterRead = revoked();
            if (afterRead)
                return afterRead;
            if (reading.state === "unavailable")
                return reading;
            const unchanged = () => !revoked() && reading.unchanged() && !revoked() &&
                !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
            if (!unchanged())
                return revoked() ?? absent("observation_changed");
            return Object.freeze({ ...reading, unchanged });
        },
        captureNaturalTime: (expected, producer, admission, stateDir) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            if (stateDir !== undefined && stateDir !== record.stateDir)
                return absent("identity_mismatch");
            const initial = revokedRecord(record);
            if (initial)
                return initial;
            let attempt;
            let staged;
            let stable;
            try {
                const refused = withRunNaturalResultTimingAdmission(record.stateDir, producer, admission, acceptance => {
                    if (ownerKey(acceptance.identity) !== ownerKey(record.identity))
                        return absent("identity_mismatch");
                    const existing = record.claim.natural;
                    if (existing)
                        return existing.admission !== admission || existing.producer !== producer
                            ? Object.freeze({ state: "unavailable", reason: "natural_acceptance_mismatch" }) : undefined;
                    attempt = Object.freeze({ state: "capturing", producer, admission });
                    record.claim.natural = attempt;
                    const observed = owner.observeTime(record.identity, record.stateDir);
                    if (observed.state === "available" && observed.timing.state === "available") {
                        stable = observed.unchanged;
                        staged = Object.freeze({ state: "frozen", producer, admission, acceptance, elapsed_ms: observed.timing.elapsed_ms });
                    }
                    return undefined;
                });
                if (refused)
                    return refused;
                if (attempt && record.claim.natural === attempt) {
                    const revoked = revokedRecord(record);
                    if (!staged || !stable || !stable() || revoked || revokedRecord(record)) {
                        record.claim.natural = Object.freeze({ state: "unproven", producer, admission });
                        return revoked ?? revokedRecord(record) ?? Object.freeze({ state: "unavailable", reason: "natural_time_unproven" });
                    }
                    record.claim.natural = staged;
                }
            }
            catch (error) {
                if (attempt && record.claim.natural === attempt)
                    record.claim.natural = Object.freeze({ state: "unproven", producer, admission });
                throw error;
            }
            return owner.observeFrozenNaturalTime(record.identity, record.stateDir);
        },
        observeFrozenNaturalTime: (expected, stateDir) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            if (stateDir !== undefined && stateDir !== record.stateDir)
                return absent("identity_mismatch");
            const initial = revokedRecord(record);
            if (initial)
                return initial;
            const frozen = record.claim.natural;
            if (!frozen)
                return Object.freeze({ state: "unavailable", reason: "natural_time_not_captured" });
            if (frozen.state !== "frozen")
                return Object.freeze({ state: "unavailable", reason: frozen.state === "capturing" ? "natural_time_capturing" : "natural_time_unproven" });
            const acceptance = readRunNaturalResultTimingAcceptance(record.stateDir, frozen.producer, frozen.admission);
            if (acceptance !== frozen.acceptance)
                return Object.freeze({ state: "unavailable", reason: "natural_acceptance_mismatch" });
            const binding = observeBinding(record.stateDir, record.identity);
            const afterRead = revokedRecord(record);
            if (afterRead)
                return afterRead;
            if (binding.state === "unavailable")
                return binding;
            if (JSON.stringify(binding.clock) !== record.clockKey)
                return absent("clock_changed");
            const unchanged = () => !revokedRecord(record) && record.claim.natural === frozen && binding.unchanged() && binding.frameUnchanged() &&
                !revokedRecord(record) && !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
            if (!unchanged())
                return revokedRecord(record) ?? absent("observation_changed");
            return Object.freeze({ state: "available", basis: "first_natural_acceptance", identity: record.identity, elapsed_ms: frozen.elapsed_ms,
                natural_acceptance: Object.freeze({ code: acceptance.code, recorded_status: acceptance.recorded_status, completed_at: acceptance.completed_at }), unchanged });
        },
        observeSnapshot: (expected, capturedAt, stateDir) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            if (stateDir !== undefined && stateDir !== record.stateDir)
                return absent("identity_mismatch");
            const initial = revokedRecord(record);
            if (initial)
                return initial;
            const references = owner.observeReferences(record.identity, record.stateDir);
            const afterReferences = revokedRecord(record);
            if (afterReferences)
                return afterReferences;
            if (references.state === "unavailable")
                return references;
            if (references.references.cwd === null)
                return Object.freeze({ state: "unavailable", reason: "references_unavailable" });
            const facts = readRunSnapshotFacts(record.stateDir, record.identity, capturedAt, owner.observeTime, owner.observeFrozenNaturalTime);
            const afterFacts = revokedRecord(record);
            if (afterFacts)
                return afterFacts;
            if (facts.state === "unavailable")
                return facts;
            const unchanged = () => !revokedRecord(record) && references.unchanged() && facts.unchanged() &&
                !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
            if (!unchanged())
                return revokedRecord(record) ?? absent("observation_changed");
            // Canonical lifecycle/time are facts, not permission to expose their mutable cwd/index fields.
            const projected = projectRunSnapshot(record.identity, { identity: facts.facts.identity, captured_at: facts.facts.captured_at,
                lifecycle: facts.facts.lifecycle, timing: facts.facts.timing, cwd: references.references.cwd,
                ...(references.references.context_index ? { context_index: references.references.context_index } : {}) });
            if (!unchanged())
                return revokedRecord(record) ?? absent("observation_changed");
            return projected.state === "unavailable" ? projected : Object.freeze({ ...projected, unchanged });
        },
        observeTime: (expected, stateDir) => {
            const record = find(expected);
            if ("state" in record)
                return record;
            if (stateDir !== undefined && stateDir !== record.stateDir)
                return absent("identity_mismatch");
            const revoked = () => revokedRecord(record);
            const initial = revoked();
            if (initial)
                return initial;
            const binding = observeBinding(record.stateDir, record.identity);
            const afterRead = revoked();
            if (afterRead)
                return afterRead;
            if (binding.state === "unavailable")
                return binding;
            if (JSON.stringify(binding.clock) !== record.clockKey)
                return absent("clock_changed");
            const timebase = createRunSupervisionTimebase(binding.clock, record.origin);
            if (timebase.state === "unavailable")
                return timebase;
            const unchanged = () => !revoked() && binding.unchanged() && binding.frameUnchanged() &&
                !closed && records.get(ownerKey(record.identity)) === record && !record.stopped;
            if (!unchanged())
                return revoked() ?? absent("observation_changed");
            const timing = timebase.timebase.observe();
            const afterSample = revoked();
            if (afterSample)
                return afterSample;
            if (!unchanged())
                return revoked() ?? absent("observation_changed");
            return Object.freeze({ state: "available", basis: "since_admission", identity: record.identity, timing, unchanged });
        },
        close: () => {
            if (!closed) {
                closed = true;
                for (const record of records.values()) {
                    stopRecord(record);
                    releaseClaim(record);
                }
                records.clear();
            }
            return Object.freeze({ state: "closed", ...(cleanupUnproven ? { timer_cleanup: "unproven" } : {}) });
        },
    });
    return owner;
}
