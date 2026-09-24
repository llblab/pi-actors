/**
 * Async run start guards.
 * Owns: active-run reuse checks, start lock acquisition, and safe state-dir
 * preparation before a new runner process is spawned.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { acquireFileMutationLock, } from "./file-state.js";
import { isAlive, verifyRunProcessIdentity, } from "./runs-process.js";
export function readActiveOwnedRunState(stateDir, readJson, _runnerPath) {
    const meta = readJson(join(stateDir, "run.json"));
    if (!meta)
        return undefined;
    const result = readJson(join(stateDir, "result.json"));
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
    const meta = readActiveOwnedRunState(stateDir, readJson, runnerPath);
    if (meta) {
        throw new Error(`Run state already has an active owned process: ${String(meta.run ?? stateDir)}. Stop it before reusing the same run_id or state_dir.`);
    }
}
export function acquireStateStartLock(stateDir, options = {}) {
    return acquireFileMutationLock(join(stateDir, ".lifecycle"), options);
}
export function prepareStateDirForStart(stateDir, readJson, _runnerPath) {
    const existing = readJson(join(stateDir, "run.json"));
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
        "stderr.log",
        "stdout.log",
        "terminal-delivery-failure.json",
        "terminal-handled.json",
        "trace.jsonl",
    ]) {
        rmSync(join(stateDir, file), { force: true });
    }
}
