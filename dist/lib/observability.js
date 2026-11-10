/**
 * Async run observability helpers
 * Zones: async runtime, ambient UI, diagnostics
 * Owns ambient summaries, terminal events, and Trace-attention delivery for detached Runs
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, watch, } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, } from "node:path";
import * as AsyncRuns from "./async-runs.js";
import * as Paths from "./paths.js";
import * as Limits from "./limits.js";
import * as RunsTrace from "./runs-trace.js";
import { readRunCompletionTextSource, readRunResultArtifactInventory, readRunResultDiagnosticOutcome } from "./runs-context-exports.js";
import { readJsonlFileResilient } from "./state-readers.js";
import { Document } from "yaml";
import { formatYamlNotice } from "./tools-response.js";
export function createRunUiObservationState() {
    return {
        attentionEventIds: new Map(),
        legacyEventLines: new Map(),
        frame: 0,
        observed: new Map(),
    };
}
export function primeRunAttentionState(state, ownerId, stateRoot) {
    detectRunAttentionEvents(state.legacyEventLines, summarizeRuns(stateRoot, ownerId), state.attentionEventIds, true);
}
export function readRunUiSnapshot(state, ownerId, options = {}) {
    return projectRunUiSnapshot(state, summarizeRuns(options.stateRoot, ownerId), options.includeAttention);
}
function projectRunUiSnapshot(state, summary, includeAttention) {
    const status = renderRunStatus(summary, state.frame++);
    return {
        attentionEvents: includeAttention === false
            ? []
            : detectRunAttentionEvents(state.legacyEventLines, summary, state.attentionEventIds),
        status,
        summary,
        transitions: detectRunTransitions(state.observed, summary),
    };
}
/** Observe every Run generation routed to one root coordinator. */
export function readRunDeliverySnapshot(state, deliveryOwnerId, stateRoot) {
    return projectRunDeliverySnapshot(state, summarizeRuns(stateRoot, undefined, deliveryOwnerId));
}
function projectRunDeliverySnapshot(state, summary) {
    return {
        attentionEvents: [],
        status: undefined,
        summary,
        transitions: detectRunTransitions(state.observed, summary),
    };
}
/** Same-pass display/candidate projections only. No frame escapes or native fact is reused by flush/publication/control. */
export function readRunUiAndDeliverySnapshots(uiState, deliveryState, ownerId, stateRoot = Paths.getRunStateRoot()) {
    const runs = readRunObservations(stateRoot);
    return {
        ui: projectRunUiSnapshot(uiState, summarizeRunObservations(runs, stateRoot, ownerId)),
        delivery: projectRunDeliverySnapshot(deliveryState, summarizeRunObservations(runs, stateRoot, undefined, ownerId)),
    };
}
export function pruneRunUiObservationState(state, snapshot) {
    pruneRunObservationState(state.observed, state.legacyEventLines, snapshot.summary, snapshot.transitions.map((transition) => transition.stateDir ?? transition.run), state.attentionEventIds);
}
export function deliverRunAttentionNotifications(events, sink) {
    for (const event of events) {
        if (!shouldNotifyRunAttentionEvent(event))
            continue;
        const text = formatRunAttentionMessage(event);
        sink.notify(text, getRunAttentionNotificationType(event));
        if (!shouldSendRunAttentionFollowUp(event))
            continue;
        sink.sendFollowUp({
            customType: "pi-actors-run-trace",
            content: text,
            display: false,
            details: event,
        });
    }
}
const RUN_WATCHER_DIAGNOSTIC_LIMIT = 32;
export function createRunStateWatcher(input) {
    const stateRoot = input.stateRoot ?? Paths.getRunStateRoot();
    const pathExists = input.exists ?? existsSync;
    const listDirectories = input.listDirectories ??
        ((path) => readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(path, entry.name)));
    const watchPath = input.watchPath ?? ((path, onChange) => watch(path, onChange));
    let diagnosticId = 0;
    let rootDegraded = false;
    let stateRootWatcher;
    const degradedRunDirs = new Set();
    const diagnostics = [];
    const lastDiagnosticSignatures = new Map();
    const runDirWatchers = new Map();
    const record = (code, scope, path, error) => {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        const signature = `${code}${detail}`;
        const signatureKey = `${scope}:${path}`;
        if (lastDiagnosticSignatures.get(signatureKey) === signature)
            return;
        lastDiagnosticSignatures.set(signatureKey, signature);
        const recovery = code === "rearmed"
            ? "; terminal watch acceleration restored"
            : "; terminal reconciliation remains active and watcher rearm will retry";
        // Captured detail/recovery strings are reused as-is; only the projection becomes bare block YAML.
        diagnostics.push({
            code,
            id: ++diagnosticId,
            message: formatYamlNotice({ watcher: code, scope, path,
                ...(detail ? { diagnostic: detail.slice(2) } : {}), recovery: recovery.slice(2) }),
            path,
            scope,
            ts: new Date().toISOString(),
        });
        if (diagnostics.length > RUN_WATCHER_DIAGNOSTIC_LIMIT)
            diagnostics.shift();
    };
    const removeRunWatcher = (stateDir, watcher, options = {}) => {
        if (runDirWatchers.get(stateDir) !== watcher)
            return;
        watcher.close();
        runDirWatchers.delete(stateDir);
        if (options.degraded === false) {
            degradedRunDirs.delete(stateDir);
            lastDiagnosticSignatures.delete(`run:${stateDir}`);
            return;
        }
        degradedRunDirs.add(stateDir);
        if (options.error)
            record("error", "run", stateDir, options.error);
        record("removed", "run", stateDir);
    };
    const close = () => {
        stateRootWatcher?.close();
        stateRootWatcher = undefined;
        for (const watcher of runDirWatchers.values())
            watcher.close();
        runDirWatchers.clear();
    };
    const watchRunDir = (stateDir) => {
        if (runDirWatchers.has(stateDir) || !pathExists(stateDir))
            return;
        try {
            const watcher = watchPath(stateDir, input.onChange);
            watcher.on("error", (error) => removeRunWatcher(stateDir, watcher, { error }));
            runDirWatchers.set(stateDir, watcher);
            if (degradedRunDirs.delete(stateDir))
                record("rearmed", "run", stateDir);
        }
        catch (error) {
            degradedRunDirs.add(stateDir);
            record("attach_failed", "run", stateDir, error);
        }
    };
    function refresh() {
        if (!pathExists(stateRoot))
            return;
        if (!stateRootWatcher) {
            try {
                const watcher = watchPath(stateRoot, input.onChange);
                stateRootWatcher = watcher;
                watcher.on("error", (error) => {
                    if (stateRootWatcher !== watcher)
                        return;
                    watcher.close();
                    stateRootWatcher = undefined;
                    rootDegraded = true;
                    record("error", "root", stateRoot, error);
                    record("removed", "root", stateRoot);
                });
                if (rootDegraded) {
                    rootDegraded = false;
                    record("rearmed", "root", stateRoot);
                }
            }
            catch (error) {
                rootDegraded = true;
                record("attach_failed", "root", stateRoot, error);
            }
        }
        let stateDirs;
        try {
            stateDirs = listDirectories(stateRoot);
        }
        catch (error) {
            record("attach_failed", "root", stateRoot, error);
            return;
        }
        const present = new Set(stateDirs);
        for (const [stateDir, watcher] of runDirWatchers) {
            if (present.has(stateDir) && pathExists(stateDir))
                continue;
            removeRunWatcher(stateDir, watcher, { degraded: false });
        }
        for (const stateDir of stateDirs)
            watchRunDir(stateDir);
    }
    return {
        close,
        getDiagnostics: () => [...diagnostics],
        refresh,
    };
}
export function createRunTerminalReconciliationLoop(input) {
    const intervalMs = input.intervalMs ?? 10_000;
    let interval;
    const reconcileNow = () => {
        try {
            input.refreshWatcher();
            input.reconcile();
        }
        catch (error) {
            try {
                input.onError?.(error);
            }
            catch {
                /* reconciliation callbacks must never escape into the host event loop */
            }
        }
    };
    const close = () => {
        if (interval)
            clearInterval(interval);
        interval = undefined;
    };
    const start = () => {
        close();
        interval = setInterval(reconcileNow, intervalMs);
        interval.unref?.();
    };
    return { close, reconcileNow, start };
}
const TERMINAL = new Set([
    "done",
    "failed",
    "exited",
    "cancelled",
    "killed",
]);
const PROC_DESCENDANT_SCAN_TTL_MS = 1000;
const RUN_STATE_DISCOVERY_MAX_DEPTH = 8;
const procDescendantScanCache = new Map();
function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
function getProgress(status) {
    const progress = status.progress;
    return progress && typeof progress === "object"
        ? progress
        : {};
}
function getUpdatedAt(status) {
    const progress = getProgress(status);
    const result = status.result &&
        typeof status.result === "object" &&
        !Array.isArray(status.result)
        ? status.result
        : {};
    return typeof result.completed_at === "string"
        ? result.completed_at
        : typeof progress.updatedAt === "string"
            ? progress.updatedAt
            : typeof status.createdAt === "string"
                ? status.createdAt
                : undefined;
}
function scanRunStateDirs(stateRoot, depth = 0, seen = new Set()) {
    if (!existsSync(stateRoot) || seen.has(stateRoot))
        return [];
    seen.add(stateRoot);
    let entries;
    try {
        entries = readdirSync(stateRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const child = join(stateRoot, entry.name);
        if (existsSync(join(child, "run.json")))
            result.push(child);
        if (depth + 1 < RUN_STATE_DISCOVERY_MAX_DEPTH)
            result.push(...scanRunStateDirs(child, depth + 1, seen));
    }
    return result;
}
const TERMINAL_RESULT_BYTES = 8 * 1024;
const TERMINAL_RESULT_CHARS = 4_000;
function readBoundedStart(path) {
    if (!existsSync(path))
        return "";
    const fd = openSync(path, "r");
    try {
        const size = Math.min(fstatSync(fd).size, TERMINAL_RESULT_BYTES);
        const buffer = Buffer.alloc(size);
        const bytes = readSync(fd, buffer, 0, size, 0);
        const text = buffer.subarray(0, bytes).toString("utf8").trim();
        return text.length > TERMINAL_RESULT_CHARS
            ? `${text.slice(0, TERMINAL_RESULT_CHARS - 1)}…`
            : text;
    }
    finally {
        closeSync(fd);
    }
}
function semanticBodyFromStdout(stateDir) {
    const text = readBoundedStart(join(stateDir, "stdout.log"));
    if (!text)
        return undefined;
    const withoutMarker = text.replace(/^ACTOR_REVIEW_RESULT\s*(?:\r?\n)?/, "").trim();
    return withoutMarker || undefined;
}
function terminalSemanticResult(status, stateDir, observedStatus) {
    const correlation = status.launch_correlation &&
        typeof status.launch_correlation === "object" &&
        !Array.isArray(status.launch_correlation)
        ? status.launch_correlation
        : {};
    const correlationId = typeof correlation.correlation_id === "string"
        ? correlation.correlation_id
        : typeof correlation.tool_call_id === "string"
            ? correlation.tool_call_id
            : undefined;
    const reviewCompleted = false;
    const result = status.result &&
        typeof status.result === "object" &&
        !Array.isArray(status.result)
        ? status.result
        : {};
    const type = reviewCompleted
        ? "review.completed"
        : observedStatus === "done" ? "run.done" : "run.failed";
    const hasPrimary = Object.hasOwn(result, "primary_text_protocol");
    const hasDiagnostics = Object.hasOwn(result, "result_diagnostics_protocol");
    const stdoutBody = !hasPrimary && !hasDiagnostics && observedStatus === "done" ? semanticBodyFromStdout(stateDir) : undefined;
    return {
        ...(hasPrimary ? { hasPrimaryText: true } : {}),
        ...(Object.hasOwn(result, "artifact_inventory_protocol") ? { hasArtifactInventory: true } : {}),
        ...(hasDiagnostics ? { hasResultDiagnostics: true } : {}),
        ...(!hasDiagnostics && (stdoutBody || typeof result.error === "string") ? { body: stdoutBody ?? result.error } : {}),
        ...(correlationId ? { correlationId } : {}),
        metadata: {
            ...(status.transport_context &&
                typeof status.transport_context === "object" &&
                !Array.isArray(status.transport_context)
                ? {
                    transport_context: status.transport_context,
                } : {}),
            run: String(status.run ?? ""), status: observedStatus,
        },
        summary: reviewCompleted ? "Review completed." :
            observedStatus === "done" ? "Run completed." : `Run ${observedStatus}.`,
        synthesized: true,
        type,
    };
}
function observeRun(stateDir, observed) {
    try {
        const status = observed ?? AsyncRuns.getRunStatus(stateDir);
        const progress = getProgress(status);
        const run = typeof status.run === "string" ? status.run : undefined;
        if (!run)
            return undefined;
        const observedStatus = status.status;
        return {
            activeSubagents: toNumber(progress.activeSubagents),
            completed: toNumber(progress.completed),
            ...(status.launch_correlation &&
                typeof status.launch_correlation === "object" &&
                !Array.isArray(status.launch_correlation)
                ? { launchCorrelation: status.launch_correlation }
                : {}),
            failures: Array.isArray(progress.failures)
                ? progress.failures.length
                : undefined,
            ...(typeof status.delivery_owner_id === "string"
                ? { deliveryOwnerId: status.delivery_owner_id }
                : {}),
            ...(status.delivery_parent &&
                typeof status.delivery_parent === "object" &&
                !Array.isArray(status.delivery_parent) &&
                typeof status.delivery_parent.run === "string" &&
                typeof status.delivery_parent.run_instance_id === "string" &&
                typeof status.delivery_parent.state_dir === "string"
                ? {
                    deliveryParent: status.delivery_parent,
                }
                : {}),
            ...(typeof status.ownerId === "string"
                ? { ownerId: status.ownerId }
                : {}),
            ...(status.artifacts &&
                typeof status.artifacts === "object" &&
                !Array.isArray(status.artifacts)
                ? { artifacts: status.artifacts }
                : {}),
            ...(status.launch_source === "spawn" || status.launch_source === "tool"
                ? { launchSource: status.launch_source }
                : {}),
            ...(status.model_policy &&
                typeof status.model_policy === "object" &&
                !Array.isArray(status.model_policy)
                ? { modelPolicy: status.model_policy }
                : {}),
            ...(status.notification_policy === "silent"
                ? { notificationPolicy: "silent" }
                : {}),
            ...(typeof status.recipe_file === "string"
                ? { recipeFile: status.recipe_file }
                : {}),
            ...(typeof status.run_instance_id === "string"
                ? { runInstanceId: status.run_instance_id }
                : {}),
            ...(status.terminal_handled ? { terminalHandled: true } : {}),
            ...(typeof status.retire_when === "string"
                ? { retireWhen: status.retire_when }
                : {}),
            ...(TERMINAL.has(observedStatus)
                ? { semanticResult: terminalSemanticResult(status, stateDir, observedStatus) }
                : {}),
            run,
            stateDir,
            status: observedStatus,
            ...(typeof status.tool === "string" ? { tool: status.tool } : {}),
            updatedAt: getUpdatedAt(status),
        };
    }
    catch {
        return undefined;
    }
}
function readRunObservations(stateRoot) {
    if (!existsSync(stateRoot))
        return undefined;
    const directories = AsyncRuns.readRunStateIndex(stateRoot)?.map((entry) => entry.state_dir) ?? scanRunStateDirs(stateRoot);
    return AsyncRuns.getRunInventoryStatuses(directories)
        .map((status, index) => status ? observeRun(directories[index], status) : undefined)
        .filter((run) => Boolean(run));
}
export function summarizeRuns(stateRoot = Paths.getRunStateRoot(), ownerId, deliveryOwnerId) {
    return summarizeRunObservations(readRunObservations(stateRoot), stateRoot, ownerId, deliveryOwnerId);
}
function summarizeRunObservations(observations, stateRoot, ownerId, deliveryOwnerId) {
    if (observations === undefined) {
        return {
            cancelled: 0,
            done: 0,
            exited: 0,
            failed: 0,
            killed: 0,
            running: 0,
            runningSubagents: 0,
            runs: [],
            total: 0,
        };
    }
    const runs = observations
        .filter((run) => deliveryOwnerId !== undefined
        ? run.deliveryOwnerId === deliveryOwnerId ||
            (run.deliveryOwnerId === undefined && run.ownerId === deliveryOwnerId)
        : ownerId === undefined || run.ownerId === ownerId)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const processSubagentsByRun = countRunningSubagentsByRun(stateRoot, ownerId);
    const runsWithDescendants = runs.map((run) => {
        const descendantSubagents = processSubagentsByRun.get(run.run) ?? 0;
        return descendantSubagents > 0 ? { ...run, descendantSubagents } : run;
    });
    const runningRuns = runsWithDescendants.filter((run) => run.status === "running");
    const running = runningRuns.length;
    const done = runsWithDescendants.filter((run) => run.status === "done").length;
    const exited = runsWithDescendants.filter((run) => run.status === "exited").length;
    const failed = runsWithDescendants.filter((run) => run.status === "failed").length;
    const cancelled = runsWithDescendants.filter((run) => run.status === "cancelled").length;
    const killed = runsWithDescendants.filter((run) => run.status === "killed").length;
    const progressSubagents = runningRuns.reduce((sum, run) => sum + Math.max(1, Math.floor(run.activeSubagents ?? 0)), 0);
    const processSubagents = [...processSubagentsByRun.values()].reduce((sum, count) => sum + count, 0);
    const runningSubagents = Math.max(progressSubagents, running + processSubagents);
    return {
        cancelled,
        done,
        exited,
        failed,
        killed,
        running,
        runningSubagents,
        runs: runsWithDescendants,
        total: runsWithDescendants.length,
    };
}
function readProcFile(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return undefined;
    }
}
function getProcPpid(pid) {
    const stat = readProcFile(`/proc/${pid}/stat`);
    if (!stat)
        return undefined;
    const close = stat.lastIndexOf(")");
    if (close === -1)
        return undefined;
    return stat.slice(close + 2).split(" ")[1];
}
function getProcCommand(pid) {
    return (readProcFile(`/proc/${pid}/cmdline`) ?? "").replaceAll("\0", " ");
}
function getRunningRunPidMap(stateRoot, ownerId) {
    const pids = new Map();
    for (const run of summarizeRunsWithoutSubagents(stateRoot, ownerId).runs) {
        if (run.status !== "running")
            continue;
        const status = AsyncRuns.getRunStatus(run.stateDir ?? join(stateRoot, run.run));
        const pid = Number(status.pid || 0);
        if (pid > 0)
            pids.set(String(pid), run.run);
    }
    return pids;
}
function summarizeRunsWithoutSubagents(stateRoot, ownerId) {
    if (!existsSync(stateRoot))
        return {
            cancelled: 0,
            done: 0,
            exited: 0,
            failed: 0,
            killed: 0,
            running: 0,
            runs: [],
            total: 0,
        };
    const runs = (AsyncRuns.readRunStateIndex(stateRoot)?.map((entry) => entry.state_dir) ??
        scanRunStateDirs(stateRoot))
        .map((stateDir) => observeRun(stateDir))
        .filter((run) => Boolean(run))
        .filter((run) => ownerId === undefined || run.ownerId === ownerId)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const running = runs.filter((run) => run.status === "running").length;
    const done = runs.filter((run) => run.status === "done").length;
    const exited = runs.filter((run) => run.status === "exited").length;
    const failed = runs.filter((run) => run.status === "failed").length;
    const cancelled = runs.filter((run) => run.status === "cancelled").length;
    const killed = runs.filter((run) => run.status === "killed").length;
    return {
        cancelled,
        done,
        exited,
        failed,
        killed,
        running,
        runs,
        total: runs.length,
    };
}
export function countRunningSubagentsByRun(stateRoot = Paths.getRunStateRoot(), ownerId) {
    // This backend cannot contribute without procfs; do not pay for native Run
    // identity probes (notably synchronous Windows/macOS probes) just to discard them.
    if (!existsSync("/proc"))
        return new Map();
    const runPidMap = getRunningRunPidMap(stateRoot, ownerId);
    if (runPidMap.size === 0)
        return new Map();
    const signature = [...runPidMap.keys()].sort().join(",");
    const cacheKey = `${stateRoot}\0${ownerId ?? ""}`;
    const cached = procDescendantScanCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.signature === signature && cached.expiresAt > now) {
        return new Map(cached.counts);
    }
    const parentByPid = new Map();
    const commandByPid = new Map();
    let procEntries;
    try {
        procEntries = readdirSync("/proc", { withFileTypes: true });
    }
    catch {
        return new Map();
    }
    for (const entry of procEntries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name))
            continue;
        const ppid = getProcPpid(entry.name);
        if (!ppid)
            continue;
        parentByPid.set(entry.name, ppid);
        commandByPid.set(entry.name, getProcCommand(entry.name));
    }
    const runForDescendant = (pid) => {
        let current = parentByPid.get(pid);
        const seen = new Set();
        while (current && !seen.has(current)) {
            const run = runPidMap.get(current);
            if (run)
                return run;
            seen.add(current);
            current = parentByPid.get(current);
        }
        return undefined;
    };
    const counts = new Map();
    for (const [pid, command] of commandByPid.entries()) {
        if (!command.includes("pi -p") && !command.includes("pi\0-p"))
            continue;
        const run = runForDescendant(pid);
        if (run)
            counts.set(run, (counts.get(run) ?? 0) + 1);
    }
    procDescendantScanCache.set(cacheKey, {
        counts,
        expiresAt: now + PROC_DESCENDANT_SCAN_TTL_MS,
        signature,
    });
    return new Map(counts);
}
export function countRunningSubagents(stateRoot = Paths.getRunStateRoot(), ownerId) {
    return [...countRunningSubagentsByRun(stateRoot, ownerId).values()].reduce((sum, count) => sum + count, 0);
}
export function renderSubagentStatus(count, frame = 0) {
    if (count <= 0)
        return undefined;
    if (count === 1)
        return frame % 2 === 0 ? "▶" : "▷";
    const active = frame % count;
    return Array.from({ length: count }, (_value, index) => index === active ? "▶" : "▷").join(" ");
}
export function renderRunStatus(summary, frame = 0) {
    return renderSubagentStatus(summary.runningSubagents, frame);
}
function isNestedStateDir(parent, child) {
    const path = relative(parent, child);
    return Boolean(path) && !path.startsWith("..") && !isAbsolute(path);
}
export function findRunRetirementCandidates(summary) {
    return summary.runs
        .map((run) => {
        const activeSubagents = Math.max(0, Math.floor(run.activeSubagents ?? 0));
        const descendantSubagents = Math.max(0, Math.floor(run.descendantSubagents ?? 0));
        const childRuns = run.stateDir
            ? summary.runs.filter((child) => child.stateDir !== undefined &&
                child.stateDir !== run.stateDir &&
                isNestedStateDir(run.stateDir, child.stateDir))
            : [];
        const runningChildRuns = childRuns.filter((child) => child.status === "running").length;
        return {
            activeSubagents,
            childRuns: childRuns.length,
            descendantSubagents,
            ready: run.status === "running" &&
                run.retireWhen === "children_terminal" &&
                run.stateDir !== undefined &&
                !run.terminalHandled &&
                activeSubagents + descendantSubagents + runningChildRuns <= 0,
            run,
            terminalChildRuns: childRuns.filter((child) => TERMINAL.has(child.status)).length,
        };
    })
        .filter((item) => item.ready)
        .map((item) => ({
        activeSubagents: item.activeSubagents,
        childRuns: item.childRuns,
        descendantSubagents: item.descendantSubagents,
        run: item.run.run,
        stateDir: item.run.stateDir,
        terminalChildRuns: item.terminalChildRuns,
    }));
}
function formatRunRetirementNotice(run, action, message = "") {
    return formatYamlNotice({ run: run.startsWith("run:") ? run.slice(4) : run, retirement: action,
        ...(action === "stop" ? { result: "request returned", reason: "child runs reached terminal state" }
            : action === "cancel" ? { result: "cancellation reported", reason: "stop path failed" }
                : { result: action === "skip" ? "skipped" : "failed", diagnostic: message }),
        closure: "unconfirmed" });
}
export async function executeRunRetirements(summary, options) {
    const results = [];
    for (const candidate of findRunRetirementCandidates(summary)) {
        if (options.attempted?.has(candidate.stateDir)) {
            results.push({
                action: "skip",
                run: candidate.run,
                stateDir: candidate.stateDir,
            });
            continue;
        }
        options.attempted?.add(candidate.stateDir);
        try {
            await options.sendStop(candidate);
            options.notify?.(formatRunRetirementNotice(candidate.run, "stop"), "info");
            results.push({
                action: "stop",
                run: candidate.run,
                stateDir: candidate.stateDir,
            });
            continue;
        }
        catch (error) {
            try {
                const cancelResult = options.cancelRun(candidate);
                const cancelled = Boolean(cancelResult.cancelled);
                options.notify?.(cancelled
                    ? formatRunRetirementNotice(candidate.run, "cancel")
                    : formatRunRetirementNotice(candidate.run, "skip", `${error instanceof Error ? error.message : String(error)}`), cancelled ? "warning" : "error");
                results.push({
                    action: cancelled ? "cancel" : "skip",
                    ...(cancelled
                        ? {}
                        : {
                            error: error instanceof Error ? error.message : String(error),
                        }),
                    run: candidate.run,
                    stateDir: candidate.stateDir,
                });
            }
            catch (cancelError) {
                const message = cancelError instanceof Error
                    ? cancelError.message
                    : String(cancelError);
                options.notify?.(formatRunRetirementNotice(candidate.run, "failed", `${message}`), "error");
                results.push({
                    action: "failed",
                    error: message,
                    run: candidate.run,
                    stateDir: candidate.stateDir,
                });
            }
        }
    }
    return results;
}
function runObservationKey(run) {
    return run.stateDir ?? run.run;
}
export function detectRunTransitions(previous, summary) {
    const transitions = [];
    for (const run of summary.runs) {
        const key = runObservationKey(run);
        const old = previous.get(key);
        if (run.notificationPolicy !== "silent" &&
            !run.terminalHandled &&
            TERMINAL.has(run.status)) {
            transitions.push({
                from: old ?? "running",
                run: run.run,
                ...(run.ownerId === undefined ? {} : { ownerId: run.ownerId }),
                ...(run.deliveryParent ? { deliveryParent: run.deliveryParent } : {}),
                ...(run.stateDir ? { stateDir: run.stateDir } : {}),
                ...(run.artifacts ? { artifacts: run.artifacts } : {}),
                ...(run.launchCorrelation ? { launchCorrelation: run.launchCorrelation } : {}),
                ...(run.launchSource ? { launchSource: run.launchSource } : {}),
                ...(run.modelPolicy ? { modelPolicy: run.modelPolicy } : {}),
                ...(run.recipeFile ? { recipeFile: run.recipeFile } : {}),
                ...(run.runInstanceId ? { runInstanceId: run.runInstanceId } : {}),
                ...(run.semanticResult ? { semanticResult: run.semanticResult } : {}),
                ...(run.terminalHandled ? { terminalHandled: true } : {}),
                ...(run.updatedAt ? { terminalAt: run.updatedAt } : {}),
                to: run.status,
                ...(run.tool ? { tool: run.tool } : {}),
            });
        }
        previous.set(key, run.status);
    }
    return transitions;
}
function normalizeTraceAttention(value) {
    return value === "notify" || value === "followup" ? value : "log";
}
function normalizeTraceLevel(value) {
    return value === "warning" || value === "error" ? value : "info";
}
function parseAttentionRecord(raw, run, index) {
    if (!run.stateDir)
        return undefined;
    const event = typeof raw.kind === "string" && raw.kind.trim()
        ? raw.kind.trim()
        : typeof raw.event === "string" && raw.event.trim()
            ? raw.event.trim()
            : "run.event";
    const summary = typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.trim()
        : event;
    const ts = typeof raw.ts === "string" && raw.ts.trim()
        ? raw.ts.trim()
        : new Date(0).toISOString();
    const id = typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `${run.run}:${index}`;
    return {
        ...(raw.body !== undefined ? { body: raw.body } : {}),
        ...(raw.data !== undefined ? { data: raw.data } : {}),
        attention: raw.attention === "notify" ||
            raw.attention === "followup" ||
            raw.attention === "steer"
            ? raw.attention
            : normalizeTraceAttention(raw.delivery),
        id,
        kind: event,
        level: normalizeTraceLevel(raw.level),
        ...(raw.metadata &&
            typeof raw.metadata === "object" &&
            !Array.isArray(raw.metadata)
            ? { metadata: raw.metadata }
            : {}),
        run: run.run,
        ...(run.runInstanceId ? { runInstanceId: run.runInstanceId } : {}),
        stateDir: run.stateDir,
        summary,
        ts,
    };
}
function readTraceAttentionRecords(run) {
    if (!run.stateDir)
        return { canonical: true, records: [] };
    if (existsSync(join(run.stateDir, "trace.jsonl")))
        return {
            canonical: true,
            records: RunsTrace.readRunTraceJournal(run.stateDir).events.map(({ event }) => event),
        };
    return { canonical: false, records: readJsonlFileResilient(join(run.stateDir, "outbox.jsonl")).records };
}
export function pruneRunObservationState(previousStatuses, previousLineCounts, summary, terminalRuns = [], seenEventIds = new Map()) {
    const activeRuns = new Set(summary.runs.map((run) => runObservationKey(run)));
    const terminalRunSet = new Set(terminalRuns);
    const activeLineKeys = new Set(summary.runs.map((run) => run.stateDir ?? run.run));
    for (const run of terminalRunSet)
        previousStatuses.delete(run);
    for (const run of previousStatuses.keys())
        if (!activeRuns.has(run))
            previousStatuses.delete(run);
    for (const key of previousLineCounts.keys())
        if (!activeLineKeys.has(key))
            previousLineCounts.delete(key);
    for (const key of seenEventIds.keys())
        if (!activeLineKeys.has(key))
            seenEventIds.delete(key);
}
export function detectRunAttentionEvents(legacyLineCounts, summary, seenEventIds = new Map(), prime = false) {
    const events = [];
    for (const run of summary.runs) {
        const key = run.stateDir ?? run.run;
        const read = readTraceAttentionRecords(run);
        const retained = new Set();
        const seen = seenEventIds.get(key) ?? new Set();
        const presentedSteerIds = new Set(read.records.flatMap((record) => {
            if (record.kind !== "delivery.steer_presented" ||
                !record.data ||
                typeof record.data !== "object" ||
                Array.isArray(record.data))
                return [];
            const eventId = record.data.event_id;
            return typeof eventId === "string" && eventId ? [eventId] : [];
        }));
        const start = read.canonical ? 0
            : Math.min(legacyLineCounts.get(key) ?? 0, read.records.length);
        for (const [index, record] of read.records.entries()) {
            const event = parseAttentionRecord(record, run, index);
            if (!event || !shouldNotifyRunAttentionEvent(event) ||
                event.kind === "runtime.trace_compacted")
                continue;
            retained.add(event.id);
            if (isRunSteerAttentionEvent(event) && presentedSteerIds.has(event.id)) {
                seen.add(event.id);
                continue;
            }
            if (run.notificationPolicy === "silent")
                seen.add(event.id);
            else if (prime) {
                if (!isRunSteerAttentionEvent(event))
                    seen.add(event.id);
            }
            else if (index >= start && !seen.has(event.id)) {
                events.push(event);
                seen.add(event.id);
            }
        }
        seenEventIds.set(key, new Set([...retained].filter((id) => seen.has(id))));
        if (read.canonical)
            legacyLineCounts.delete(key);
        else
            legacyLineCounts.set(key, read.records.length);
    }
    return events;
}
export function getRunAttentionNotificationType(event) {
    return event.level;
}
export function shouldNotifyRunAttentionEvent(event) {
    if (event.kind === "command.done")
        return false;
    return event.attention === "notify" ||
        event.attention === "followup" ||
        event.attention === "steer";
}
export function isRunSteerAttentionEvent(event) {
    return event.kind !== "command.done" && event.attention === "steer";
}
export function retryRunAttentionEvent(state, event) {
    state.attentionEventIds.get(event.stateDir)?.delete(event.id);
}
export function shouldSendRunAttentionFollowUp(event) {
    return event.attention === "followup";
}
function commonDirectory(paths) {
    if (paths.length === 0)
        return undefined;
    const split = (path) => dirname(path).split("/").filter(Boolean);
    const first = split(paths[0]);
    let length = first.length;
    for (const path of paths.slice(1)) {
        const parts = split(path);
        length = Math.min(length, parts.length);
        for (let index = 0; index < length; index += 1) {
            if (first[index] !== parts[index]) {
                length = index;
                break;
            }
        }
    }
    if (length === 0)
        return paths[0].startsWith("/") ? "/" : undefined;
    return `${paths[0].startsWith("/") ? "/" : ""}${first.slice(0, length).join("/")}`;
}
function relativeName(base, path) {
    if (!base)
        return basename(path) || path;
    const name = relative(base, path);
    return name && !name.startsWith("..") ? name : basename(path) || path;
}
function getAttentionDataField(event, key) {
    return event.data &&
        typeof event.data === "object" &&
        !Array.isArray(event.data)
        ? event.data[key]
        : undefined;
}
/** Only selected shallow compiler fields enter YAML; the selected body stays opaque and unindented. */
function renderAttention({ metadata, body }) {
    const header = new Document(metadata).toString({ lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).slice(0, -1);
    return body === undefined ? header : `---\n${header}\n---\n${body}`;
}
/** Ordinary selection has no urgent-steer or compact-output byte/depth allowance. */
export function formatRunAttentionMessage(event) {
    const checkpoint = formatAXAttentionCheckpoint(event);
    if (event.kind === "command.done")
        return renderAttention(checkpoint);
    for (const section of attentionPathSections(event)) {
        checkpoint.metadata[section.key] = formatAXAttentionPaths(section.paths.slice(0, 8).filter(path => Buffer.from(path).toString("utf8") === path), section.paths.length);
    }
    return renderAttention(checkpoint);
}
function formatAXAttentionCheckpoint(event) {
    const run = event.run.startsWith("run:") ? event.run.slice(4) : event.run;
    const metadata = { run, checkpoint: event.summary };
    const checkpoint = { metadata };
    if (event.kind === "command.done" || event.body === undefined)
        return checkpoint;
    const rendered = typeof event.body === "string" ? event.body : JSON.stringify(event.body);
    if (!rendered.trim())
        return checkpoint;
    let end = Math.min(rendered.length, 500);
    const last = rendered.charCodeAt(end - 1), next = rendered.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        end--;
    const preview = rendered.slice(0, end), clipped = end < rendered.length;
    if (Buffer.from(preview).toString("utf8") !== preview) {
        metadata.body = "unavailable";
        metadata.body_reason = "malformed_legacy_preview";
        metadata.body_omission = "[omitted: unknown]";
    }
    else {
        // Retain the old final body observation and structured-preview ellipsis placement, not its compiler fence.
        checkpoint.body = typeof event.body === "string" ? preview + (clipped ? "…" : "") : preview + (clipped ? "\n…" : "");
        if (clipped)
            metadata.body_omission = "[omitted: unknown]";
    }
    metadata.body_basis = "Legacy record; original completeness/privacy unproven.";
    metadata.body_upstream = "[omitted: unknown]";
    return checkpoint;
}
function attentionPathSections(event) {
    const artifacts = getAttentionDataField(event, "artifacts"), files = getAttentionDataField(event, "run_files");
    if (event.kind === "command.done")
        return [];
    return [
        { key: "artifacts", values: artifacts && typeof artifacts === "object" && !Array.isArray(artifacts) ? Object.values(artifacts) : [] },
        { key: "run_files", values: Array.isArray(files) ? files : [] },
    ].map(({ key, values }) => ({ key,
        paths: [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))],
    })).filter(section => section.paths.length > 0);
}
function formatAXAttentionPaths(paths, total) {
    return { shown: paths.length, omitted: total - paths.length, total, ...(paths.length ? { paths } : {}) };
}
/** Saved envelope.content is replayed before this formatter; only fresh complete candidates are fitted. */
export function formatRunSteerMessage(event) {
    const limit = Limits.RUN_DELIVERY_STEER_MAX_BYTES;
    const checkpoint = formatAXAttentionCheckpoint(event);
    // YAML can escape malformed UTF-16: validate essential source values before serialization or reference reads.
    if ([checkpoint.metadata.run, checkpoint.metadata.checkpoint].some(value => Buffer.from(value).toString("utf8") !== value)
        || Buffer.byteLength(renderAttention(checkpoint)) > limit) {
        throw new Error("Urgent steer checkpoint text exceeds its Unicode/byte delivery limits");
    }
    const sections = attentionPathSections(event);
    if (event.kind === "command.done")
        return renderAttention(checkpoint);
    const selected = { ...checkpoint.metadata };
    for (const [index, section] of sections.entries()) {
        const reserve = {};
        for (const next of sections.slice(index + 1))
            reserve[next.key] = formatAXAttentionPaths([], next.paths.length);
        const candidates = section.paths.slice(0, 8).filter(path => Buffer.from(path).toString("utf8") === path);
        let fitted = false;
        for (let shown = candidates.length; shown >= 0; shown -= 1) {
            const group = formatAXAttentionPaths(candidates.slice(0, shown), section.paths.length);
            const candidate = { ...selected, [section.key]: group, ...reserve };
            if (Buffer.byteLength(renderAttention({ ...checkpoint, metadata: candidate })) <= limit) {
                selected[section.key] = group;
                fitted = true;
                break;
            }
        }
        if (!fitted)
            throw new Error("Urgent steer checkpoint and reference coverage exceed the delivery byte limit");
    }
    return renderAttention({ ...checkpoint, metadata: selected });
}
export function getRunTransitionNotificationType(transition) {
    if (transition.to === "done" || transition.to === "cancelled")
        return "info";
    if (transition.to === "killed" || transition.to === "exited")
        return "warning";
    return "error";
}
export function shouldNotifyRunTransition(transition) {
    if (transition.terminalHandled)
        return false;
    return (transition.to === "done" ||
        transition.to === "failed" ||
        transition.to === "killed" ||
        transition.to === "exited");
}
function deliveryGenerationIdentity(input) {
    return input.stateDir && input.runInstanceId
        ? `${input.stateDir}\0${input.runInstanceId}`
        : undefined;
}
function deliveryTreePosition(input, runsByIdentity) {
    const ownIdentity = deliveryGenerationIdentity(input);
    if (!ownIdentity)
        return undefined;
    let parent = input.deliveryParent;
    let depth = 0;
    let rootIdentity = ownIdentity;
    const visited = new Set([ownIdentity]);
    while (parent) {
        const identity = `${parent.state_dir}\0${parent.run_instance_id}`;
        if (visited.has(identity))
            return undefined;
        visited.add(identity);
        const ancestor = runsByIdentity.get(identity);
        if (!ancestor || ancestor.notificationPolicy === "silent")
            return undefined;
        depth += 1;
        rootIdentity = identity;
        parent = ancestor.deliveryParent;
    }
    return { depth, rootIdentity };
}
/** Eligibility is metadata-only; ambient candidate checks must not read full primary bodies. */
function readyRunCompletions(transitions, deliveryRuns) {
    const runsByIdentity = new Map(deliveryRuns.flatMap(run => {
        const identity = deliveryGenerationIdentity(run);
        return identity ? [[identity, run]] : [];
    }));
    const incompleteRoots = new Set(deliveryRuns.flatMap(run => {
        if (TERMINAL.has(run.status))
            return [];
        const position = deliveryTreePosition(run, runsByIdentity);
        return position ? [position.rootIdentity] : [];
    }));
    return transitions.flatMap(transition => {
        if (!shouldNotifyRunTransition(transition) || !transition.stateDir || !transition.runInstanceId ||
            !transition.terminalAt || Number.isNaN(Date.parse(transition.terminalAt)))
            return [];
        const position = deliveryTreePosition(transition, runsByIdentity);
        if (!position || incompleteRoots.has(position.rootIdentity))
            return [];
        return [{ transition: { ...transition, stateDir: transition.stateDir, runInstanceId: transition.runInstanceId,
                    terminalAt: transition.terminalAt }, depth: position.depth }];
    });
}
export function hasRunCompletionBatchMembers(transitions, deliveryRuns = []) {
    return readyRunCompletions(transitions, deliveryRuns).length > 0;
}
/** Freeze primary/artifact source observations only for eligible members entering packet admission. */
export function collectRunCompletionBatchMembers(transitions, deliveryRuns = []) {
    const admitted = readyRunCompletions(transitions, deliveryRuns).map(({ transition, depth }) => {
        const hasPrimary = transition.semanticResult?.hasPrimaryText === true;
        const hasDiagnostics = transition.semanticResult?.hasResultDiagnostics === true;
        const diagnosticReading = hasDiagnostics ? readRunResultDiagnosticOutcome(transition.stateDir, { run: transition.run,
            run_instance_id: transition.runInstanceId, ...(transition.ownerId === undefined ? {} : { ownerId: transition.ownerId }) }, transition.to) : undefined;
        const diagnostics = diagnosticReading?.state === "available" && diagnosticReading.terminal_status === transition.to && diagnosticReading.unchanged()
            ? { ...diagnosticReading.binding, diagnostic_excerpt: diagnosticReading.excerpt } : diagnosticReading
            ? { result_diagnostics: null, result_diagnostics_unavailable: diagnosticReading.state === "unavailable"
                    ? diagnosticReading.result_diagnostics_unavailable ?? diagnosticReading.reason : diagnosticReading.terminal_status !== transition.to ? "outcome_mismatch" : "observation_changed" } : undefined;
        const reading = hasPrimary ? readRunCompletionTextSource(transition.stateDir, { run: transition.run,
            run_instance_id: transition.runInstanceId, ...(transition.ownerId === undefined ? {} : { ownerId: transition.ownerId }) }) : undefined;
        const primary = !reading ? undefined
            : reading.state === "available" && reading.result_acceptance === "natural" && transition.to === "done" && reading.unchanged()
                ? Object.freeze({ output: reading.original_output ?? reading.output })
                : Object.freeze({ output: null, output_unavailable: reading.state === "unavailable"
                        ? reading.output_unavailable ?? reading.reason : reading.result_acceptance !== "natural" ? "nonterminal_capture" : "observation_changed" });
        // Existing unsupported session/composition/failure displays stay diagnostics, never substitute for a lost source.
        const legacyDisplay = !hasPrimary || (reading?.state === "unavailable" && reading.reason === "output_unavailable" &&
            ["not_selected", "selection_not_supported", "primary_not_selected_for_failure"].includes(reading.output_unavailable ?? ""));
        const body = !hasDiagnostics && legacyDisplay ? transition.semanticResult?.body ??
            (hasPrimary && transition.to === "done" ? semanticBodyFromStdout(transition.stateDir) : undefined) : undefined;
        const hasInventory = transition.semanticResult?.hasArtifactInventory === true;
        const inventoryReading = hasInventory ? readRunResultArtifactInventory(transition.stateDir, { run: transition.run,
            run_instance_id: transition.runInstanceId, ...(transition.ownerId === undefined ? {} : { ownerId: transition.ownerId }) }) : undefined;
        const inventory = inventoryReading?.state === "available" && inventoryReading.terminal_status === transition.to && inventoryReading.unchanged() ? inventoryReading.binding : inventoryReading
            ? { artifact_inventory: null, artifact_inventory_unavailable: inventoryReading.state === "unavailable"
                    ? inventoryReading.artifact_inventory_unavailable ?? inventoryReading.reason : inventoryReading.terminal_status !== transition.to ? "outcome_mismatch" : "observation_changed" } : undefined;
        const artifactEntries = hasInventory ? [] : Object.entries(transition.artifacts ?? {})
            .filter((entry) => typeof entry[1] === "string" && Boolean(entry[1])).slice(0, 4);
        const rawSummary = transition.semanticResult?.summary.trim() || `Run ${transition.to}.`;
        return {
            ...(artifactEntries.length > 0 ? { artifacts: Object.fromEntries(artifactEntries) } : {}),
            ...(primary ? { primary_text: primary } : {}),
            ...(primary?.output && reading?.state === "available" ? { completion_text: Object.freeze({ text: reading.output.preview,
                    shown_bytes: reading.output.shown_bytes }) } : {}),
            ...inventory,
            ...diagnostics,
            ...(body?.trim() ? { output: body.trim().length > 4_000 ? `${body.trim().slice(0, 3_999)}…` : body.trim() } : {}),
            ...(transition.deliveryParent ? { parent_run: transition.deliveryParent.run,
                parent_run_instance_id: transition.deliveryParent.run_instance_id, parent_state_dir: transition.deliveryParent.state_dir } : {}),
            run: transition.run, run_instance_id: transition.runInstanceId, state_dir: transition.stateDir,
            status: transition.to,
            summary: rawSummary.length > 1_000 ? `${rawSummary.slice(0, 999)}…` : rawSummary,
            terminal_at: transition.terminalAt, tree_depth: depth,
        };
    });
    return admitted.sort((left, right) => left.tree_depth - right.tree_depth ||
        left.terminal_at.localeCompare(right.terminal_at) || left.run.localeCompare(right.run) ||
        left.run_instance_id.localeCompare(right.run_instance_id) || left.state_dir.localeCompare(right.state_dir)).map(({ tree_depth: _depth, ...member }) => member);
}
const TERMINAL_FOLLOW_UP_ARTIFACT_LIMIT = 4;
const TERMINAL_FOLLOW_UP_IDENTIFIER_CHARS = 120;
const TERMINAL_FOLLOW_UP_PATH_CHARS = 320;
function compactTerminalText(value, limit) {
    const compact = value.replaceAll(/\s+/g, " ").trim();
    return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
function formatTerminalPath(path) {
    return `\`${compactTerminalText(path, TERMINAL_FOLLOW_UP_PATH_CHARS)}\``;
}
function formatTerminalResultLocations(transition) {
    const artifactPaths = [...new Set(Object.values(transition.artifacts ?? {}).filter((path) => typeof path === "string" && path.length > 0))];
    if (artifactPaths.length === 0)
        return transition.stateDir ? `\nBase: ${formatTerminalPath(transition.stateDir)}` : "";
    const base = commonDirectory(artifactPaths);
    const artifactPreview = artifactPaths
        .slice(0, TERMINAL_FOLLOW_UP_ARTIFACT_LIMIT)
        .map((path) => formatTerminalPath(base ? relativeName(base, path) : path));
    const omitted = artifactPaths.length - artifactPreview.length;
    const artifacts = `${artifactPreview.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
    return `${base ? `\nBase: ${formatTerminalPath(base)}` : ""}\nArtifacts: ${artifacts}`;
}
export function formatRunTransitionMessage(transition) {
    const run = compactTerminalText(transition.run, TERMINAL_FOLLOW_UP_IDENTIFIER_CHARS);
    return `Run: \`${run}\`\nStatus: \`${transition.to}\`${formatTerminalResultLocations(transition)}`;
}
