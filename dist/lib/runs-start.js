/**
 * Async run start guards.
 * Owns: active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */
import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireFileMutationLock, mutationLockPath, } from "./file-state.js";
import { assertNoRetainedDescendantLaunchScope } from "./runs-descendant-launches.js";
import { assertNoRetainedNativeLaunchScope } from "./runs-native-launches.js";
import { isRunStopResultCapture, readRunStopClaim, RUN_STOP_CLAIM_FILE } from "./runs-outcomes.js";
import { RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.js";
import { isAlive, verifyRunProcessIdentity, } from "./runs-process.js";
function assertNoPendingStop(stateDir, meta) {
    const stop = readRunStopClaim(stateDir, meta);
    if (stop.state === "pending" || stop.state === "invalid") {
        throw new Error("Run stop is pending or unproven; confirm the complete owned scope before restarting.");
    }
}
function assertNoUnresolvedCapture(result) {
    if (isRunStopResultCapture(result)) {
        throw new Error("Run stop result capture is not confirmed terminal evidence.");
    }
}
export function readActiveOwnedRunState(stateDir, readJson, _runnerPath) {
    const meta = readJson(join(stateDir, "run.json"));
    if (!meta)
        return undefined;
    assertNoPendingStop(stateDir, meta);
    const result = readJson(join(stateDir, "result.json"));
    assertNoUnresolvedCapture(result);
    if (typeof result?.completedAt === "string")
        return undefined;
    const pid = Number(meta.pid || 0);
    if (!pid || !isAlive(pid))
        return undefined;
    const identity = verifyRunProcessIdentity(pid, meta.process_identity);
    if (identity.status === "owner_mismatch") {
        throw new Error(`Run state process identity does not match the live pid: ${String(meta.run ?? stateDir)}. Refusing to reuse the state directory while pid ${pid} is alive.`);
    }
    if (identity.status === "unsupported_proof") {
        throw new Error(`Run state process identity proof is unavailable: ${String(meta.run ?? stateDir)}. Refusing to reuse the state directory while pid ${pid} is alive.`);
    }
    return identity.valid ? meta : undefined;
}
export function assertNoActiveRunState(stateDir, readJson, runnerPath) {
    assertNoRetainedDescendantLaunchScope(stateDir);
    assertNoRetainedNativeLaunchScope(stateDir);
    const meta = readActiveOwnedRunState(stateDir, readJson, runnerPath);
    if (meta) {
        throw new Error(`Run state already has an active owned process: ${String(meta.run ?? stateDir)}. Stop it before reusing the same run_id or state_dir.`);
    }
}
/** Prepare-only metadata must neither replace an earlier Run nor erase unrelated retained evidence. */
export function assertFreshRunPreparationState(stateDir) {
    assertNoRetainedDescendantLaunchScope(stateDir);
    let entries;
    try {
        entries = readdirSync(stateDir);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    const lock = basename(mutationLockPath(join(stateDir, ".lifecycle")));
    if (entries.some((name) => name !== RUN_STATE_OWNERSHIP_FILE && name !== lock && !name.startsWith(`${lock}.`))) {
        throw new Error("Run descendant preparation requires fresh state without published Run metadata or retained evidence.");
    }
}
export function acquireStateStartLock(stateDir, options = {}) {
    return acquireFileMutationLock(join(stateDir, ".lifecycle"), options);
}
export function prepareStateDirForStart(stateDir, readJson, _runnerPath) {
    assertNoRetainedDescendantLaunchScope(stateDir);
    assertNoRetainedNativeLaunchScope(stateDir);
    const existing = readJson(join(stateDir, "run.json"));
    assertNoPendingStop(stateDir, existing ?? {});
    assertNoUnresolvedCapture(readJson(join(stateDir, "result.json")));
    const existingPid = Number(existing?.pid || 0);
    if (existingPid && isAlive(existingPid)) {
        const identity = verifyRunProcessIdentity(existingPid, existing?.process_identity);
        if (identity.status === "owner_mismatch") {
            throw new Error(`Run state process identity does not match the live pid: ${String(existing?.run ?? stateDir)}. Refusing to prepare the state directory while pid ${existingPid} is alive.`);
        }
        if (identity.status === "unsupported_proof") {
            throw new Error(`Run state process identity proof is unavailable: ${String(existing?.run ?? stateDir)}. Refusing to prepare the state directory while pid ${existingPid} is alive.`);
        }
        if (identity.valid) {
            throw new Error(`Run state already has an active owned process: ${String(existing?.run ?? stateDir)}. Stop it before restarting.`);
        }
    }
    for (const file of [
        "control-endpoint.json",
        "controls.jsonl",
        "events.jsonl",
        "execution.json",
        "progress.json",
        "result.json",
        RUN_STOP_CLAIM_FILE,
        "stderr.log",
        "stdout.log",
        "terminal-delivery-failure.json",
        "terminal-handled.json",
        "trace.jsonl",
    ]) {
        rmSync(join(stateDir, file), { force: true });
    }
}
