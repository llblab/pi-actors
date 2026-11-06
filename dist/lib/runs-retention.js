/**
 * Run retirement owner.
 * Owns: lifecycle-serialized manual archive/prune, age-based cleanup and shared ownership/scope fences.
 * Excludes: native closure proof, process actuation and ordinary non-Run temp cleanup.
 */
import { createHash, randomUUID } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { acquireFileMutationLock, writeJsonAtomic, writeTextAtomic } from "./file-state.js";
import * as Limits from "./limits.js";
import { readJsonFileResilient, readJsonlFileResilient } from "./state-readers.js";
import { readRunContextIdentity, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "./runs-context-index.js";
import { readProcessLiveness } from "./runs-process.js";
import { acquireStateStartLock, assertNoActiveRunState } from "./runs-start.js";
import { resolveArtifactManifest, } from "./runs-artifacts.js";
import { assertNoRetainedDescendantLaunchScope } from "./runs-descendant-launches.js";
import { safeRunId } from "./runs-identity.js";
import { assertNoRetainedNativeLaunchScope } from "./runs-native-launches.js";
import { assertOwnedRunStateDirectory } from "./runs-ownership.js";
export const DEFAULT_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIREMENT_FAILURE_MESSAGE = "Run retirement failed; effects may already exist.";
function assertRetirableDirectory(status) {
    const stateDir = String(status.state_dir);
    assertOwnedRunStateDirectory(stateDir, String(status.run ?? basename(stateDir)));
    assertNoRetainedDescendantLaunchScope(stateDir);
    assertNoRetainedNativeLaunchScope(stateDir);
}
/** Manual API preserves its existing status/expected contract, not a native closure claim. */
export function retainRun(stateDir, action, expected, readStatus, options = {}) {
    const release = acquireStateStartLock(stateDir);
    let status;
    let evidenceId;
    const failures = [];
    try {
        expected.onLocked?.();
        status = readStatus(stateDir);
        if (expected.ownerId !== undefined && status.ownerId !== expected.ownerId) {
            return { [`${action}d`]: false, reason: "ownership changed", status };
        }
        if (expected.runInstanceId !== undefined && status.run_instance_id !== expected.runInstanceId) {
            return { [`${action}d`]: false, reason: "run generation changed", status };
        }
        if (status.status === "running")
            throw new Error("Only terminal runs can be archived or pruned.");
        if (resolve(String(status.state_dir)) !== resolve(stateDir))
            throw new Error("Run retirement state directory changed.");
        evidenceId = appendRunRetentionEvidence(status, action, "queued");
        const result = action === "archive" ? archiveTerminalRun(status) : pruneTerminalRun(status, options);
        appendRunRetentionEvidence(status, action, "handled", { id: evidenceId, result });
        return { ...result, retention_id: evidenceId };
    }
    catch (error) {
        failures.push(error);
        if (status && evidenceId) {
            let text;
            try {
                text = String(error instanceof Error ? error.message : error);
            }
            catch (formattingError) {
                text = "failure text unavailable";
                failures.push(formattingError);
            }
            try {
                appendRunRetentionEvidence(status, action, "failed", { error: text, id: evidenceId });
            }
            catch (recordingError) {
                failures.push(recordingError);
            }
        }
    }
    finally {
        try {
            release();
        }
        catch (releaseError) {
            if (failures.length)
                throw new AggregateError([...failures, releaseError], RETIREMENT_FAILURE_MESSAGE, { cause: failures[0] });
            throw releaseError;
        }
    }
    if (failures.length === 1)
        throw failures[0];
    throw new AggregateError(failures, RETIREMENT_FAILURE_MESSAGE, { cause: failures[0] });
}
/** Filesystem age selects candidates; it grants neither retirement nor native scope authority. */
export async function cleanupStaleRunEntries(runsDir, maxAgeMs = DEFAULT_RUN_MAX_AGE_MS, now = Date.now()) {
    let entries;
    const root = resolve(runsDir);
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    let removed = 0;
    const readJson = (path) => {
        const reading = readJsonFileResilient(path, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
        if (reading.diagnostics.length)
            throw new Error("Run retirement metadata is unavailable.");
        return reading.value;
    };
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const stateDir = join(root, entry.name);
        try {
            const selected = lstatSync(stateDir);
            if (now - Math.min(selected.birthtimeMs || selected.mtimeMs, selected.mtimeMs) <= maxAgeMs)
                continue;
            const candidate = readRunContextIdentity(stateDir, readJson(join(stateDir, "run.json")));
            if (candidate.state !== "available")
                continue;
            const release = acquireStateStartLock(stateDir);
            try {
                if (!candidate.unchanged())
                    continue;
                const current = lstatSync(stateDir);
                if (now - Math.min(current.birthtimeMs || current.mtimeMs, current.mtimeMs) <= maxAgeMs)
                    continue;
                const meta = readJson(join(stateDir, "run.json"));
                if (!meta || typeof meta.pid !== "number" || !candidate.unchanged())
                    continue;
                assertNoActiveRunState(stateDir, readJson, "");
                if (readProcessLiveness(meta.pid) !== "dead" || !candidate.unchanged())
                    continue;
                pruneTerminalRun(meta);
                removed++;
            }
            finally {
                release();
            }
        }
        catch {
            // Best-effort startup cleanup retains unavailable, replaced or still-fenced candidates.
        }
    }
    return removed;
}
export function appendRunRetentionEvidence(status, action, outcome, options = {}) {
    const stateDir = String(status.state_dir);
    const path = join(dirname(stateDir), "retention.jsonl");
    const id = options.id ?? randomUUID();
    const record = {
        action,
        ...(options.error ? { error: options.error } : {}),
        id,
        outcome,
        ...(options.result ? { result: options.result } : {}),
        run: String(status.run ?? basename(stateDir)),
        ...(typeof status.run_instance_id === "string" ? { run_instance_id: status.run_instance_id } : {}),
        ts: new Date().toISOString(),
    };
    const release = acquireFileMutationLock(path);
    let writeFailed = false, writeFailure;
    try {
        const records = [...readJsonlFileResilient(path).records, record]
            .slice(-Limits.RUN_RETENTION_MAX_RECORDS);
        let content = encodeRecords(records);
        while (records.length && Buffer.byteLength(content) > Limits.RUN_RETENTION_MAX_BYTES) {
            records.shift();
            content = encodeRecords(records);
        }
        if (!records.includes(record))
            throw new Error("Run retention record exceeds journal byte limit");
        writeTextAtomic(path, content);
    }
    catch (error) {
        writeFailed = true;
        writeFailure = error;
        throw error;
    }
    finally {
        try {
            release();
        }
        catch (releaseError) {
            if (writeFailed)
                throw new AggregateError([writeFailure, releaseError], "Run retention journal append and release failed", { cause: writeFailure });
            throw releaseError;
        }
    }
    return id;
}
function encodeRecords(records) {
    return records.length ? `${records.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}
function retainedArtifactFilename(name, path) {
    const readableName = name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "artifact";
    const identity = createHash("sha256")
        .update(`${name}\0${path}`)
        .digest("hex")
        .slice(0, 8);
    return `${readableName}-${identity}--${basename(path)}`;
}
function archivePathFor(run, stateDir) {
    const archiveRoot = join(dirname(stateDir), "archived");
    mkdirSync(archiveRoot, { recursive: true });
    return join(archiveRoot, `${safeRunId(run)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}
export function archiveTerminalRun(status) {
    const stateDir = String(status.state_dir);
    const run = String(status.run ?? basename(stateDir));
    assertRetirableDirectory(status);
    const archiveDir = archivePathFor(run, stateDir);
    renameSync(stateDir, archiveDir);
    mkdirSync(stateDir, { recursive: true });
    const tombstone = {
        archived: true,
        archive_dir: archiveDir,
        original_state_dir: stateDir,
        run,
        status: status.status,
        ts: new Date().toISOString(),
    };
    writeJsonAtomic(join(stateDir, "archive-tombstone.json"), tombstone);
    return tombstone;
}
export function pruneTerminalRun(status, options = {}, deps = {}) {
    const stateDir = String(status.state_dir);
    const run = String(status.run ?? basename(stateDir));
    assertRetirableDirectory(status);
    const manifest = options.preserveArtifacts ? resolveArtifactManifest(status.artifacts) : undefined;
    const preserved = {};
    if (options.preserveArtifacts && manifest) {
        const preserveRoot = join(dirname(stateDir), "preserved-artifacts", safeRunId(run));
        mkdirSync(preserveRoot, { recursive: true });
        for (const [name, artifact] of Object.entries(manifest)) {
            if (!artifact.exists)
                continue;
            const target = join(preserveRoot, retainedArtifactFilename(name, artifact.path));
            (deps.copyArtifact ?? cpSync)(artifact.path, target, {
                force: true,
                preserveTimestamps: true,
            });
            preserved[name] = target;
        }
    }
    rmSync(stateDir, { recursive: true, force: true });
    return {
        pruned: true,
        preserved_artifacts: preserved,
        run,
        state_dir: stateDir,
        ts: new Date().toISOString(),
    };
}
