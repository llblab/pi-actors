/**
 * Async run process identity helpers.
 * Owns: cross-platform liveness, stable runner identity, and single-process exit observations.
 * Excludes: stop claims, signal dispatch, descendant/group cleanup, and lifecycle finalization.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { posix, win32 } from "node:path";
export function readProcessLiveness(pid, probe = process.kill.bind(process)) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return "unknown";
    try {
        return probe(pid, 0) === true ? "alive" : "unknown";
    }
    catch (error) {
        return error?.code === "ESRCH" ? "dead" : "unknown";
    }
}
/** POSIX group presence only: neither ownership, membership completeness, nor whole-Run stop proof. */
export function readProcessGroupLiveness(processGroupId, runtimePlatform = platform(), probe = process.kill.bind(process)) {
    if (runtimePlatform !== "linux" && runtimePlatform !== "darwin")
        return "unknown";
    return readProcessLiveness(processGroupId, (validatedId, signal) => probe(-validatedId, signal));
}
/** Unknown liveness must retain active-state guards, never authorize state reuse. */
export function isAlive(pid) {
    return readProcessLiveness(pid) !== "dead";
}
function readLinuxIdentity(pid) {
    if (!existsSync(`/proc/${pid}`))
        return undefined;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const fields = stat.slice(close + 2).trim().split(/\s+/);
        const startTime = fields[19];
        if (!startTime)
            return undefined;
        return {
            command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
            cwd: readlinkSync(`/proc/${pid}/cwd`),
            platform: "linux",
            start_time: startTime,
        };
    }
    catch {
        return undefined;
    }
}
function readDarwinIdentity(pid) {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" });
    if (result.status !== 0)
        return undefined;
    const match = result.stdout.trim().match(/^(.{24})\s+(.+)$/s);
    if (!match)
        return undefined;
    return {
        command: match[2].trim(),
        platform: "darwin",
        start_time: match[1].trim(),
    };
}
function readWindowsIdentity(pid) {
    const command = [
        `$p = Get-CimInstance Win32_Process -Property CreationDate,ExecutablePath,CommandLine -Filter \"ProcessId = ${pid}\";`,
        "if ($null -eq $p) { exit 3 };",
        "$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ].join(" ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0)
        return undefined;
    try {
        return decodeWindowsIdentity(JSON.parse(result.stdout));
    }
    catch {
        return undefined;
    }
}
function decodeWindowsIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const row = value;
    if (typeof row.CreationDate !== "string")
        return undefined;
    const executable = typeof row.ExecutablePath === "string" ? row.ExecutablePath : "";
    const commandLine = typeof row.CommandLine === "string" ? row.CommandLine : "";
    return { command: `${executable}\n${commandLine}`.trim(), platform: "win32", start_time: row.CreationDate };
}
export const WINDOWS_IDENTITY_QUERY_PID_LIMIT = 64;
const WINDOWS_IDENTITY_QUERY_MAX_BYTES = 1024 * 1024;
/** One bounded, complete CIM observation; undefined means query failure, never process absence. */
export function readWindowsProcessIdentities(pids) {
    if (!pids.length || pids.length > WINDOWS_IDENTITY_QUERY_PID_LIMIT || new Set(pids).size !== pids.length ||
        pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0))
        return undefined;
    // 64 safe integers (at most 16 digits) keep this ASCII command below 4096 characters,
    // independently of native output. No shell, encoded command, or widened process scan.
    const command = ['$ErrorActionPreference = "Stop";',
        `$p = Get-CimInstance Win32_Process -Property ProcessId,CreationDate,ExecutablePath,CommandLine -Filter "${pids.map(pid => `ProcessId = ${pid}`).join(" OR ")}";`,
        "ConvertTo-Json -InputObject @($p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine) -Compress"].join(" ");
    if (command.length > 4096)
        return undefined;
    try {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, maxBuffer: WINDOWS_IDENTITY_QUERY_MAX_BYTES });
        if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string" ||
            result.stdout.length > WINDOWS_IDENTITY_QUERY_MAX_BYTES || Buffer.byteLength(result.stdout) > WINDOWS_IDENTITY_QUERY_MAX_BYTES)
            return undefined;
        // Parse the entire bounded output, not a clipped prefix. Every row must correlate exactly once.
        const rows = JSON.parse(result.stdout);
        if (!Array.isArray(rows) || rows.length > pids.length)
            return undefined;
        const selected = new Set(pids);
        const identities = new Map();
        for (const row of rows) {
            if (!row || typeof row !== "object" || Array.isArray(row))
                return undefined;
            const pid = row.ProcessId;
            if (typeof pid !== "number" || !selected.has(pid) || identities.has(pid))
                return undefined;
            const identity = decodeWindowsIdentity(row);
            if (!identity)
                return undefined;
            identities.set(pid, identity);
        }
        return identities;
    }
    catch {
        return undefined;
    }
}
export function readProcessIdentity(pid, runtimePlatform = platform()) {
    if (runtimePlatform === "linux")
        return readLinuxIdentity(pid);
    if (runtimePlatform === "darwin")
        return readDarwinIdentity(pid);
    if (runtimePlatform === "win32")
        return readWindowsIdentity(pid);
    return undefined;
}
export function runProcessIdentityDigest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const identity = value;
    if (typeof identity.platform !== "string" || !["linux", "darwin", "win32"].includes(identity.platform) ||
        typeof identity.start_time !== "string" || !identity.start_time ||
        typeof identity.command !== "string" || !identity.command ||
        (identity.cwd !== undefined && typeof identity.cwd !== "string"))
        return undefined;
    return createHash("sha256").update(JSON.stringify([
        identity.platform, identity.start_time, identity.command, identity.cwd ?? null,
    ])).digest("hex");
}
function matchesRunCwd(identity, cwd, runtimePlatform) {
    const pathApi = runtimePlatform === "win32" ? win32 : posix;
    const resolvedCwd = pathApi.resolve(cwd);
    const canonicalCwd = runtimePlatform === platform() && existsSync(resolvedCwd)
        ? realpathSync.native(resolvedCwd)
        : resolvedCwd;
    const expectedCwd = runtimePlatform === "win32" ? canonicalCwd.toLowerCase() : canonicalCwd;
    const actualCwd = runtimePlatform === "win32" && identity.cwd ? identity.cwd.toLowerCase() : identity.cwd;
    return !actualCwd || actualCwd === expectedCwd;
}
export function captureRunProcessIdentity(pid, cwd, stateDir, runnerPath, runtimePlatform = platform(), reader = readProcessIdentity) {
    const identity = reader(pid, runtimePlatform);
    if (!identity || !identity.command.includes(runnerPath) || !identity.command.includes(stateDir) ||
        !matchesRunCwd(identity, cwd, runtimePlatform))
        return undefined;
    return identity;
}
/** Fresh spawn only, while its lifecycle lock/child handle is retained and workload is not admitted. */
export function captureSpawnedRunProcessIdentity(child, cwd, stateDir, runnerPath, deps = {}) {
    return captureFreshProcessIdentity(child, deps, (current, runtimePlatform) => captureRunProcessIdentity(child.pid, cwd, stateDir, runnerPath, runtimePlatform, () => current), (current, runtimePlatform) => matchesRunCwd(current, cwd, runtimePlatform));
}
/** Immediate managed-native callback only; this observation is not complete membership or termination authority. */
export function captureSpawnedNativeProcessIdentity(child, deps = {}) {
    const runtimePlatform = deps.runtimePlatform ?? platform();
    if (!["linux", "darwin", "win32"].includes(runtimePlatform))
        return undefined;
    return captureFreshProcessIdentity(child, deps, (current) => current, () => true);
}
function captureFreshProcessIdentity(child, deps, accept, acceptEmpty) {
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || !pid || pid <= 0)
        return undefined;
    const runtimePlatform = deps.runtimePlatform ?? platform();
    const read = deps.readIdentity ?? readProcessIdentity;
    const now = deps.now ?? (() => performance.now());
    const wait = deps.wait ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
    const started = now();
    let birth;
    // Bound startup retries, not OS probe latency; never retry an observed contradiction.
    for (let attempt = 0; attempt <= 100; attempt++) {
        if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null)
            return undefined;
        const current = read(pid, runtimePlatform);
        if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null)
            return undefined;
        if (current) {
            if (current.platform !== runtimePlatform || typeof current.start_time !== "string" || !current.start_time ||
                typeof current.command !== "string" || (current.cwd !== undefined && (typeof current.cwd !== "string" || !current.cwd)) ||
                (birth !== undefined && current.start_time !== birth))
                return undefined;
            birth = current.start_time;
            if (current.command) {
                return accept({ ...current }, runtimePlatform);
            }
            if (!acceptEmpty(current, runtimePlatform))
                return undefined;
        }
        const elapsed = now() - started;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 500)
            return undefined;
        wait(Math.min(5, 500 - elapsed));
    }
    return undefined;
}
export function verifyRunProcessIdentity(pid, expected, runtimePlatform = platform(), reader = readProcessIdentity, alive = isAlive) {
    if (!alive(pid))
        return { status: "dead_pid", valid: false };
    if (!expected || expected.platform !== runtimePlatform) {
        return { status: "unsupported_proof", valid: false };
    }
    const current = reader(pid, runtimePlatform);
    if (!current)
        return { status: "unsupported_proof", valid: false };
    const valid = current.start_time === expected.start_time &&
        current.command === expected.command &&
        current.cwd === expected.cwd;
    return { status: valid ? "valid" : "owner_mismatch", valid };
}
/** Observes one captured process only; signal dispatch and descendant cleanup are separate facts. */
export function observeRunProcessExit(pid, expected, deps = {}) {
    const runtimePlatform = deps.runtimePlatform ?? platform();
    if (!expected || expected.platform !== runtimePlatform ||
        typeof expected.command !== "string" || !expected.command ||
        typeof expected.start_time !== "string" || !expected.start_time ||
        (expected.cwd !== undefined && typeof expected.cwd !== "string")) {
        return { status: "unproven", process_identity_status: "unsupported_proof" };
    }
    const liveness = readProcessLiveness(pid, deps.probe);
    if (liveness === "unknown") {
        return { status: "unproven", process_identity_status: "unsupported_proof" };
    }
    const identity = verifyRunProcessIdentity(pid, expected, runtimePlatform, deps.readIdentity ?? readProcessIdentity, () => liveness === "alive");
    return {
        status: identity.status === "dead_pid" ? "exited" : identity.valid ? "running" : "unproven",
        process_identity_status: identity.status,
    };
}
export function isWithinRunnerIdentityGrace(meta, graceMs) {
    const createdAt = typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : NaN;
    return (Number.isFinite(createdAt) &&
        Date.now() - createdAt >= 0 &&
        Date.now() - createdAt <= graceMs);
}
