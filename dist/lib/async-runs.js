/**
 * Command-template async run lifecycle facade.
 * Owns: launch, state observation, listing, message/control facade methods, and retention while runs-* subdomains own narrower run internals.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { writeJsonAtomic } from "./file-state.js";
import { CURRENT_MODEL_VALUE_KEY, CURRENT_THINKING_VALUE_KEY, describeCurrentPolicyProvenance, } from "./model-context.js";
import * as Paths from "./paths.js";
import * as RunDeliveryLineage from "./run-delivery-lineage.js";
import * as RecipesReferences from "./recipes-references.js";
import * as RecipesUsage from "./recipes-usage.js";
import * as Schema from "./schema.js";
import { resolveArtifactPaths, } from "./runs-artifacts.js";
import { safeRunId } from "./runs-identity.js";
import { buildTerminalProgress, markTerminalHandled, signalOwnedRunProcess, } from "./runs-control.js";
import { claimRunStateDirectory } from "./runs-ownership.js";
import { appendRunRetentionEvidence, archiveTerminalRun, pruneTerminalRun, } from "./runs-retention.js";
import { captureRunProcessIdentity, verifyRunProcessIdentity, } from "./runs-process.js";
import * as RuntimeIdentity from "./runtime-identity.js";
import * as RunsStart from "./runs-start.js";
import { appendRunTraceEvent } from "./runs-trace.js";
import * as RunsIndex from "./runs-index.js";
import * as RunsParentTeardown from "./runs-parent-teardown.js";
import { deliverRunControl, } from "./runs-control-delivery.js";
import { buildRunStatus, tailFile, } from "./runs-status.js";
import { readJsonFileResilient } from "./state-readers.js";
const RUNNER_IDENTITY_GRACE_MS = 5000;
export function normalizeRunTransportContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const normalized = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
        const safeKey = key.trim().slice(0, 64);
        if (!safeKey)
            continue;
        if (typeof item === "string") {
            normalized[safeKey] = item.trim().slice(0, 256);
            continue;
        }
        if (typeof item === "number" && Number.isFinite(item)) {
            normalized[safeKey] = item;
            continue;
        }
        if (typeof item === "boolean")
            normalized[safeKey] = item;
    }
    return Object.keys(normalized).length ? normalized : undefined;
}
const DEFAULT_STATE_ROOT = Paths.getRunStateRoot();
const DEFAULT_RECIPE_ROOT = Paths.getRecipeRoot();
function packageRoot() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    if (basename(moduleDir) === "lib" &&
        basename(dirname(moduleDir)) === "dist") {
        return dirname(dirname(moduleDir));
    }
    return dirname(moduleDir);
}
const PACKAGE_ROOT = packageRoot();
const RUNNER_PATH = join(PACKAGE_ROOT, "scripts", "async-runner.mjs");
function asyncRunnerArgv(stateDir) {
    return existsSync(join(PACKAGE_ROOT, "dist", "lib", "execution.js"))
        ? [RUNNER_PATH, stateDir]
        : ["--experimental-strip-types", RUNNER_PATH, stateDir];
}
export { safeRunId } from "./runs-identity.js";
export { resolveArtifactManifest } from "./runs-artifacts.js";
function resolveRunTemplate(params) {
    if (!params.template)
        throw new Error("spawn requires file or template.");
    const envelope = {};
    for (const key of [
        "args",
        "defaults",
        "parallel",
        "concurrency",
        "min_successful",
        "label",
        "when",
        "timeout",
        "delay",
        "accept_output",
        "output",
        "retry",
        "failure",
        "recover",
        "repeat",
    ]) {
        if (params[key] !== undefined)
            envelope[key] = params[key];
    }
    if (Object.keys(envelope).length === 0)
        return { template: params.template };
    if (typeof params.template === "object" && !Array.isArray(params.template)) {
        return { template: { ...envelope, ...params.template } };
    }
    return { template: { ...envelope, template: params.template } };
}
function resolveStateDir(params, run) {
    return resolve(params.state_dir || join(DEFAULT_STATE_ROOT, run));
}
function assertNoActiveRunState(stateDir) {
    RunsStart.assertNoActiveRunState(stateDir, readJson, RUNNER_PATH);
}
function reuseCompatibleSingletonRun(stateDir, startParams, singletonValues) {
    const existing = RunsStart.readActiveOwnedRunState(stateDir, readJson, RUNNER_PATH);
    if (!existing)
        return undefined;
    const compatible = existing.singleton === true &&
        existing.singleton_recipe_id === startParams.singleton_recipe_id &&
        existing.ownerId === startParams.ownerId &&
        isDeepStrictEqual(existing.singleton_values ?? {}, singletonValues) &&
        isDeepStrictEqual(existing.control ?? [], startParams.control ?? []);
    if (!compatible) {
        throw new Error(`Active singleton Run ${String(existing.run ?? stateDir)} has incompatible Recipe identity, owner, startup values, or Control contract. Stop it before changing singleton configuration.`);
    }
    return {
        ...existing,
        ...(startParams.launch_source
            ? {
                launch_kind: startParams.launch_source,
                launch_source: startParams.launch_source,
            }
            : {}),
        ...(startParams.launch_correlation
            ? { launch_correlation: startParams.launch_correlation }
            : {}),
        reused: true,
    };
}
function resolveRecipeFile(file, cwd, options) {
    const path = RecipesReferences.resolveRecipeReferencePath(file, cwd, options.skillContext);
    if (path)
        return path;
    throw new Error(`Recipe reference not found. Use <skill>/<recipe> or an explicit .json/.md file path: ${file}`);
}
function isMutableUsageRecipeFile(file) {
    const userRoot = resolve(DEFAULT_RECIPE_ROOT);
    const resolved = resolve(file);
    const relation = relative(userRoot, resolved);
    return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}
function readRecipeFile(file, cwd, options) {
    const path = resolveRecipeFile(file, cwd, options);
    const raw = RecipesReferences.readRawRecipeConfig(path);
    const includeActorRecipeContext = raw?.actor_context !== false && raw?.actor_context !== "off";
    const config = RecipesReferences.readResolvedRecipeConfig(path, [], {
        includeActorRecipeContext,
        skillContext: options.skillContext,
    });
    if (!config) {
        throw new Error(`Template recipe must define template: ${path}`);
    }
    if (config.disabled === true) {
        throw new Error(`Template recipe is disabled: ${path}`);
    }
    return {
        ...config,
        file: path,
        ...(includeActorRecipeContext ? {} : { actor_context: false }),
    };
}
function getRunIdFromFile(file) {
    if (!file)
        return undefined;
    const name = basename(file, extname(file));
    return name || undefined;
}
function resolveStartParams(params, cwd, options) {
    if (!params.file)
        return params;
    const fileParams = readRecipeFile(params.file, cwd, options);
    const singleton = fileParams.singleton === true;
    if (singleton && fileParams.async !== true) {
        throw new Error("singleton Recipes must declare async: true");
    }
    if (singleton && (!fileParams.singleton_run_id || !fileParams.singleton_recipe_id)) {
        throw new Error("singleton Recipes must resolve one active Skill-owned singleton identity");
    }
    const singletonRun = singleton ? fileParams.singleton_run_id : undefined;
    if (singletonRun && params.run_id && params.run_id !== singletonRun) {
        throw new Error(`singleton Recipe run identity is run:${singletonRun}; received run:${params.run_id}`);
    }
    return {
        ...fileParams,
        ...params,
        ...(singleton ? { singleton: true } : {}),
        run_id: singletonRun ||
            params.run_id ||
            fileParams.run_id ||
            fileParams.name ||
            getRunIdFromFile(fileParams.file),
        values: {
            ...(fileParams.values ?? {}),
            ...(params.values ?? {}),
            ...(fileParams.recipe_dir
                ? { recipe_dir: fileParams.recipe_dir }
                : {}),
            ...(fileParams.skill_dir ? { skill_dir: fileParams.skill_dir } : {}),
        },
    };
}
function readJson(path) {
    return readJsonFileResilient(path, undefined).value;
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isFalsyValue(value) {
    if (value === undefined || value === null || value === false)
        return true;
    const normalized = String(value).trim().toLowerCase();
    return (normalized === "" ||
        normalized === "0" ||
        normalized === "false" ||
        normalized === "no");
}
function stringReferencesPlaceholder(value, placeholder) {
    return new RegExp(`\\{\\s*${placeholder}\\s*\\}`).test(value);
}
function collectUnresolvedCurrentPlaceholderReferences(value, values, placeholder, valueKey, path = "template", refs = []) {
    if (typeof value === "string") {
        if (stringReferencesPlaceholder(value, placeholder) &&
            isFalsyValue(values[valueKey])) {
            refs.push(path);
        }
        return refs;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectUnresolvedCurrentPlaceholderReferences(item, values, placeholder, valueKey, `${path}[${index}]`, refs));
        return refs;
    }
    if (!isRecord(value))
        return refs;
    for (const [key, child] of Object.entries(value)) {
        if (key === "defaults" && isRecord(child)) {
            for (const [defaultKey, defaultValue] of Object.entries(child)) {
                if (typeof defaultValue === "string" &&
                    stringReferencesPlaceholder(defaultValue, placeholder) &&
                    isFalsyValue(values[defaultKey]) &&
                    isFalsyValue(values[valueKey])) {
                    refs.push(`${path}.defaults.${defaultKey}`);
                }
            }
            continue;
        }
        collectUnresolvedCurrentPlaceholderReferences(child, values, placeholder, valueKey, `${path}.${key}`, refs);
    }
    return refs;
}
function assertCurrentPlaceholderReferencesResolved(template, defaults, values, modelPolicy) {
    const checks = [
        {
            label: "model",
            placeholder: "current_model",
            valueKey: CURRENT_MODEL_VALUE_KEY,
        },
        {
            label: "thinking level",
            placeholder: "current_thinking",
            valueKey: CURRENT_THINKING_VALUE_KEY,
        },
    ];
    for (const check of checks) {
        const refs = collectUnresolvedCurrentPlaceholderReferences(template, values, check.placeholder, check.valueKey);
        if (defaults) {
            collectUnresolvedCurrentPlaceholderReferences({ defaults }, values, check.placeholder, check.valueKey, "recipe", refs);
        }
        if (refs.length === 0)
            continue;
        throw Object.assign(new Error(`Template recipe requires the current Pi ${check.label} for inheritance, but no current ${check.label} was available. Pass explicit values or launch from a Pi session with a selected ${check.label}. unresolved=${refs.slice(0, 4).join(",")}`), { model_policy: modelPolicy });
    }
}
function acquireStateStartLock(stateDir, options = {}) {
    return RunsStart.acquireStateStartLock(stateDir, options);
}
function prepareStateDirForStart(stateDir) {
    RunsStart.prepareStateDirForStart(stateDir, readJson, RUNNER_PATH);
}
export function startRun(params, cwd, options = {}) {
    const startParams = resolveStartParams(params, cwd, options);
    const resolved = resolveRunTemplate(startParams);
    const run = safeRunId(startParams.run_id);
    const stateDir = resolveStateDir(startParams, run);
    const recipeFile = startParams.file
        ? resolveRecipeFile(startParams.file, cwd, options)
        : undefined;
    const argSpec = Schema.parseToolArgDeclarationList(startParams.args ?? []);
    if (argSpec.error)
        throw new Error(argSpec.error);
    const declaredArgs = new Set(argSpec.args);
    for (const key of Object.keys(startParams.defaults ?? {})) {
        if (declaredArgs.size > 0 && !declaredArgs.has(key))
            throw new Error(`Unknown Recipe default argument: ${key}`);
    }
    const values = Schema.normalizeRuntimeValues({
        ...argSpec.defaults,
        ...(startParams.defaults || {}),
        ...(startParams.values || {}),
        run_id: run,
        state_dir: stateDir,
        trace_file: join(stateDir, "trace.jsonl"),
    }, argSpec.argTypes);
    const runtimeTemplate = resolved.template &&
        typeof resolved.template === "object" &&
        !Array.isArray(resolved.template)
        ? {
            ...resolved.template,
            defaults: {
                ...(resolved.template.defaults ?? {}),
                ...values,
            },
        }
        : resolved.template;
    const modelPolicy = describeCurrentPolicyProvenance({
        defaults: startParams.defaults,
        template: resolved.template,
        values: startParams.policy_values ?? startParams.values ?? {},
    });
    assertCurrentPlaceholderReferencesResolved(resolved.template, startParams.defaults, values, modelPolicy);
    const singletonValues = Object.fromEntries([...declaredArgs].map((key) => [key, values[key]]));
    if (startParams.singleton !== true)
        assertNoActiveRunState(stateDir);
    mkdirSync(stateDir, { recursive: true });
    const releaseStartLock = acquireStateStartLock(stateDir, {
        onContention: startParams.lifecycleHooks?.onLockContention,
    });
    try {
        claimRunStateDirectory(stateDir, run);
        if (recipeFile &&
            isMutableUsageRecipeFile(recipeFile) &&
            !RecipesUsage.recordRecipeLaunch(recipeFile, new Date(), startParams.launch_source === "tool" ? "tool" : "spawn")) {
            throw new Error(`Recipe launch rejected because its source changed during activation: ${recipeFile}. Reload recipe tools and retry.`);
        }
        if (startParams.singleton === true) {
            const existing = reuseCompatibleSingletonRun(stateDir, startParams, singletonValues);
            if (existing)
                return existing;
        }
        else
            assertNoActiveRunState(stateDir);
        prepareStateDirForStart(stateDir);
        const stdout = join(stateDir, "stdout.log");
        const stderr = join(stateDir, "stderr.log");
        const recipe = startParams.name || getRunIdFromFile(recipeFile);
        const includeActorRecipeContext = startParams.actor_context !== false &&
            startParams.actor_context !== "off";
        const recipeContextRecords = recipeFile && includeActorRecipeContext
            ? RecipesReferences.buildRecipeContextRecords(recipeFile, options.skillContext).map((record, index) => index === 0 &&
                startParams.launch_source === "tool" &&
                record.source_kind === "explicit_file_recipe"
                ? {
                    ...record,
                    logical_reference: record.name,
                    source_kind: "user_registry_capability",
                }
                : record)
            : undefined;
        const outFd = openSync(stdout, "a");
        const errFd = openSync(stderr, "a");
        const argv = asyncRunnerArgv(stateDir);
        const outputValues = {
            ...(startParams.defaults || {}),
            ...values,
        };
        const transportContext = normalizeRunTransportContext(startParams.transport_context);
        const artifacts = resolveArtifactPaths(startParams.artifacts, outputValues);
        const runInstanceId = randomUUID();
        const deliveryLineage = RunDeliveryLineage.inheritedRunDeliveryLineage(startParams.ownerId);
        const meta = {
            argv: [process.execPath, ...argv],
            createdAt: new Date().toISOString(),
            cwd,
            ...(startParams.launch_source
                ? {
                    launch_kind: startParams.launch_source,
                    launch_source: startParams.launch_source,
                }
                : {}),
            ...(startParams.launch_correlation
                ? { launch_correlation: startParams.launch_correlation } : {}),
            ...(startParams.ownerId ? { ownerId: startParams.ownerId } : {}),
            pid: 0,
            ...(recipe ? { recipe } : {}),
            ...(recipeFile ? { recipe_file: recipeFile } : {}),
            run,
            run_instance_id: runInstanceId,
            state_dir: stateDir,
            state_schema: RuntimeIdentity.RUN_STATE_SCHEMA,
            status: "running",
            ...(startParams.tool ? { tool: startParams.tool } : {}),
            template: runtimeTemplate,
            values,
            model_policy: modelPolicy,
            ...(artifacts ? { artifacts } : {}),
            ...(startParams.control ? { control: startParams.control } : {}),
            ...(startParams.control_endpoint
                ? { control_endpoint: startParams.control_endpoint }
                : {}),
            ...(deliveryLineage ?? {}),
            ...(startParams.notification_policy === "silent"
                ? { notification_policy: "silent" }
                : {}),
            ...(recipeContextRecords && recipeContextRecords.length > 0
                ? { recipe_context_records: recipeContextRecords }
                : {}),
            ...(startParams.retire_when === "children_terminal"
                ? { retire_when: "children_terminal" }
                : {}),
            ...(startParams.singleton === true
                ? {
                    singleton: true,
                    singleton_recipe_id: startParams.singleton_recipe_id,
                    singleton_values: singletonValues,
                }
                : {}),
            ...(transportContext
                ? { transport_context: transportContext } : {}),
        };
        writeJsonAtomic(join(stateDir, "run.json"), meta);
        writeJsonAtomic(join(stateDir, "progress.json"), {
            completed: 0,
            failures: [],
            model_policy: modelPolicy,
            phase: "starting",
            updatedAt: new Date().toISOString(),
        });
        const child = spawn(process.execPath, argv, {
            cwd,
            detached: true,
            ...(deliveryLineage
                ? {
                    env: RunDeliveryLineage.runDeliveryChildEnv(deliveryLineage, {
                        run,
                        run_instance_id: runInstanceId,
                        state_dir: stateDir,
                    }),
                }
                : {}),
            stdio: ["ignore", outFd, errFd],
        });
        closeSync(outFd);
        closeSync(errFd);
        meta.pid = child.pid ?? 0;
        const processIdentity = captureRunProcessIdentity(meta.pid, cwd, stateDir, RUNNER_PATH);
        if (processIdentity)
            meta.process_identity = processIdentity;
        writeJsonAtomic(join(stateDir, "run.json"), meta);
        appendRunTraceEvent(stateDir, {
            kind: "run.start",
            summary: `Run ${run} started`,
            data: {
                pid: meta.pid,
                run_instance_id: meta.run_instance_id,
            },
        });
        child.unref();
        return meta;
    }
    finally {
        releaseStartLock();
    }
}
function resolveRunStateDir(runOrDir) {
    return resolve(/[\\/]/u.test(runOrDir)
        ? runOrDir
        : join(DEFAULT_STATE_ROOT, safeRunId(runOrDir)));
}
export function getRunStatus(runOrDir) {
    const stateDir = resolveRunStateDir(runOrDir);
    const meta = readJson(join(stateDir, "run.json"));
    if (!meta)
        throw new Error(`Run not found: ${runOrDir}`);
    return buildRunStatus(stateDir, runOrDir, meta, readJson, RUNNER_PATH, RUNNER_IDENTITY_GRACE_MS);
}
export function listRunStateDirs(stateRoot = DEFAULT_STATE_ROOT) {
    return RunsIndex.listRunStateDirs(stateRoot);
}
export function rebuildRunStateIndex(stateRoot = DEFAULT_STATE_ROOT) {
    return RunsIndex.rebuildRunStateIndex(stateRoot, getRunStatus);
}
export function readRunStateIndex(stateRoot = DEFAULT_STATE_ROOT) {
    return RunsIndex.readRunStateIndex(stateRoot, readJson);
}
export function listRuns(stateRoot = DEFAULT_STATE_ROOT, statusFilter) {
    return RunsIndex.listRuns(stateRoot, getRunStatus, readJson, statusFilter);
}
export function teardownRunsOwnedByParent(ownerId, stateRoot = DEFAULT_STATE_ROOT, options = {}) {
    const result = RunsParentTeardown.teardownParentRuns(ownerId, {
        getRunStatus,
        killRun,
        listRunStatuses: () => {
            const discovered = RunsIndex.discoverRunStateDirs(stateRoot, Number.POSITIVE_INFINITY);
            const failures = discovered.issues.map((issue) => ({
                path: issue.path,
                reason: issue.reason.replaceAll("_", " "),
            }));
            const statuses = discovered.stateDirs.flatMap((stateDir) => {
                try {
                    return [getRunStatus(stateDir)];
                }
                catch (error) {
                    failures.push({
                        path: stateDir,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                    return [];
                }
            });
            return { failures, statuses };
        },
        recordAttempt: (attempt) => {
            const current = getRunStatus(attempt.stateDir);
            if (!attempt.runInstanceId ||
                current.run_instance_id !== attempt.runInstanceId) {
                throw new Error("run generation changed before teardown evidence");
            }
            appendRunTraceEvent(attempt.stateDir, {
                kind: "run.parent_teardown",
                summary: `Parent teardown ${attempt.outcome}`,
                data: {
                    outcome: attempt.outcome,
                    owner_id: attempt.ownerId,
                    reason: attempt.reason,
                    run: attempt.run,
                    run_instance_id: attempt.runInstanceId,
                    trigger: options.trigger ?? "parent_shutdown",
                },
                ...(attempt.outcome === "failed" ? { level: "error" } : {}),
            });
        },
    });
    const summaryPath = join(stateRoot, "teardown", `${Date.now()}-${randomUUID()}.json`);
    try {
        writeJsonAtomic(summaryPath, RunsParentTeardown.buildBoundedParentTeardownSummary(result, ownerId ?? "unknown", options.trigger ?? "parent_shutdown", new Date().toISOString()));
        return { ...result, summaryPath };
    }
    catch (error) {
        const failure = {
            path: summaryPath,
            reason: `summary: ${error instanceof Error ? error.message : String(error)}`,
        };
        return {
            ...result,
            discoveryFailed: result.discoveryFailed + 1,
            discoveryFailures: [...result.discoveryFailures, failure],
            failed: result.failed + 1,
        };
    }
}
export function tailRun(runOrDir, lines = 40) {
    const status = getRunStatus(runOrDir);
    const stateDir = String(status.state_dir);
    const trace = tailFile(join(stateDir, "trace.jsonl"), lines);
    if (trace)
        return trace;
    return (tailFile(join(stateDir, "stdout.log"), lines) ||
        tailFile(join(stateDir, "stderr.log"), lines));
}
export async function sendRunControl(runOrDir, request, options = {}) {
    const stateDir = resolveRunStateDir(runOrDir);
    const releaseControlLock = RunsStart.acquireStateStartLock(stateDir);
    try {
        const status = getRunStatus(stateDir);
        const run = String(status.run ?? runOrDir);
        if (options.ownerId !== undefined && status.ownerId !== options.ownerId) {
            throw Object.assign(new Error(`Run ownership changed: ${run}`), {
                reason: "owner_mismatch",
            });
        }
        if (status.run_instance_id !== request.run_instance_id) {
            throw Object.assign(new Error(`Run generation changed: ${run}`), {
                reason: "generation_mismatch",
            });
        }
        if (status.status !== "running") {
            throw Object.assign(new Error(`Run is not running: ${run}`), {
                reason: "terminal_state",
            });
        }
        const pid = Number(status.pid || 0);
        const identity = verifyRunProcessIdentity(pid, status.process_identity);
        if (!identity.valid) {
            throw Object.assign(new Error(`Run process identity ${identity.status}: ${run}`), { reason: `process_identity_${identity.status}` });
        }
        return await deliverRunControl(run, stateDir, request, options);
    }
    finally {
        releaseControlLock();
    }
}
export { getRunProcessSignalPlan } from "./runs-control.js";
function markTerminalProgress(stateDir, phase) {
    const existing = readJson(join(stateDir, "progress.json"));
    const progress = existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : undefined;
    writeJsonAtomic(join(stateDir, "progress.json"), buildTerminalProgress(progress, phase));
}
function finalizeInterruptedExecution(stateDir, phase, signal) {
    const executionPath = join(stateDir, "execution.json");
    const manifest = readJson(executionPath);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        return;
    const record = manifest;
    if (!Array.isArray(record.commands))
        return;
    const completedAt = new Date().toISOString();
    const effectiveExitCode = signal === "SIGKILL" ? 137 : 143;
    const commands = record.commands.map((command) => {
        if (!command || typeof command !== "object" || Array.isArray(command)) {
            return command;
        }
        const entry = command;
        if (entry.status !== "running" || typeof entry.id !== "string")
            return entry;
        const captureDir = join(stateDir, "captures", entry.id);
        const attempts = existsSync(captureDir)
            ? readdirSync(captureDir)
                .filter((name) => /^attempt-\d+$/.test(name))
                .sort()
                .map((name, index) => {
                const attemptDir = join(captureDir, name);
                const stdoutFile = join(attemptDir, "stdout.log");
                const stderrFile = join(attemptDir, "stderr.log");
                return {
                    attempt: index + 1,
                    stdout: {
                        path: relative(stateDir, stdoutFile).replaceAll("\\", "/"),
                        bytes: existsSync(stdoutFile) ? statSync(stdoutFile).size : 0,
                    },
                    stderr: {
                        path: relative(stateDir, stderrFile).replaceAll("\\", "/"),
                        bytes: existsSync(stderrFile) ? statSync(stderrFile).size : 0,
                    },
                };
            })
            : [];
        return {
            ...entry,
            status: phase,
            completed_at: completedAt,
            attempts,
            effective_exit_code: effectiveExitCode,
            killed: true,
            ...(entry.semantic_acceptance === "pending"
                ? { semantic_acceptance: "interrupted" }
                : {}),
        };
    });
    writeJsonAtomic(executionPath, {
        ...record,
        status: phase,
        commands,
        updated_at: completedAt,
    });
}
function stopRun(runOrDir, signal, event, expected = {}) {
    const stateDir = resolveRunStateDir(runOrDir);
    const releaseControlLock = RunsStart.acquireStateStartLock(stateDir);
    try {
        expected.onLocked?.();
        const status = getRunStatus(stateDir);
        if (expected.ownerId !== undefined &&
            status.ownerId !== expected.ownerId) {
            return { stopped: false, reason: "ownership changed", status };
        }
        if (expected.runInstanceId !== undefined &&
            status.run_instance_id !== expected.runInstanceId) {
            return { stopped: false, reason: "run generation changed", status };
        }
        const pid = Number(status.pid || 0);
        if (status.status !== "running" && status.status !== "exited") {
            return { stopped: false, reason: "not running", status };
        }
        const identity = verifyRunProcessIdentity(pid, status.process_identity);
        if (status.status === "exited") {
            if (identity.status === "owner_mismatch" ||
                identity.status === "unsupported_proof") {
                return {
                    stopped: false,
                    reason: identity.status.replaceAll("_", " "),
                    process_identity_status: identity.status,
                    status,
                };
            }
            return { stopped: false, reason: "not running", status };
        }
        if (!identity.valid) {
            return {
                stopped: false,
                reason: identity.status.replaceAll("_", " "),
                process_identity_status: identity.status,
                status,
            };
        }
        let signalResult;
        try {
            signalResult = signalOwnedRunProcess(pid, signal, status.process_identity);
        }
        catch (error) {
            throw error;
        }
        appendRunTraceEvent(stateDir, {
            kind: event,
            summary: `${event === "run.kill" ? "Killed" : "Cancelled"} Run process`,
            data: { pid, signal, ...signalResult },
        });
        markTerminalHandled(stateDir, { event, signal });
        if (event === "run.kill") {
            finalizeInterruptedExecution(stateDir, "killed", signal);
            markTerminalProgress(stateDir, "killed");
        }
        if (event === "run.cancel") {
            finalizeInterruptedExecution(stateDir, "cancelled", signal);
            markTerminalProgress(stateDir, "cancelled");
        }
        return {
            stopped: true,
            pid,
            signal,
            ...signalResult,
            state_dir: stateDir,
        };
    }
    finally {
        releaseControlLock();
    }
}
export function markRunTerminalNotificationHandled(stateDir, status, expectedRunInstanceId) {
    const releaseLock = RunsStart.acquireStateStartLock(stateDir);
    try {
        if (!existsSync(join(stateDir, "run.json")))
            return false;
        const current = getRunStatus(stateDir);
        if (current.run_instance_id !== expectedRunInstanceId ||
            current.status !== status)
            return false;
        markTerminalHandled(stateDir, {
            event: "run.notification",
            run_instance_id: expectedRunInstanceId,
            status,
        });
        rmSync(join(stateDir, "terminal-delivery-failure.json"), { force: true });
        return true;
    }
    finally {
        releaseLock();
    }
}
export function markRunSteerPresentationHandled(stateDir, expectedRunInstanceId, eventId, steerId) {
    const releaseLock = RunsStart.acquireStateStartLock(stateDir);
    try {
        if (!existsSync(join(stateDir, "run.json")))
            return false;
        const current = getRunStatus(stateDir);
        if (current.run_instance_id !== expectedRunInstanceId)
            return false;
        appendRunTraceEvent(stateDir, {
            data: {
                event_id: eventId,
                run_instance_id: expectedRunInstanceId,
                steer_id: steerId,
            },
            kind: "delivery.steer_presented",
        });
        return true;
    }
    finally {
        releaseLock();
    }
}
export function cancelRun(runOrDir, expected = {}) {
    const result = stopRun(runOrDir, "SIGTERM", "run.cancel", expected);
    return Object.hasOwn(result, "stopped")
        ? { cancelled: result.stopped, ...result }
        : result;
}
function retainRun(runOrDir, action, expected, options = {}) {
    const stateDir = resolveRunStateDir(runOrDir);
    const releaseControlLock = RunsStart.acquireStateStartLock(stateDir);
    let status;
    let evidenceId;
    try {
        expected.onLocked?.();
        status = getRunStatus(stateDir);
        if (expected.ownerId !== undefined && status.ownerId !== expected.ownerId) {
            return { [`${action}d`]: false, reason: "ownership changed", status };
        }
        if (expected.runInstanceId !== undefined &&
            status.run_instance_id !== expected.runInstanceId) {
            return { [`${action}d`]: false, reason: "run generation changed", status };
        }
        if (status.status === "running") {
            throw new Error("Only terminal runs can be archived or pruned.");
        }
        evidenceId = appendRunRetentionEvidence(status, action, "queued");
        const result = action === "archive"
            ? archiveTerminalRun(status)
            : pruneTerminalRun(status, options);
        appendRunRetentionEvidence(status, action, "handled", {
            id: evidenceId,
            result,
        });
        return { ...result, retention_id: evidenceId };
    }
    catch (error) {
        if (status && evidenceId) {
            appendRunRetentionEvidence(status, action, "failed", {
                error: error instanceof Error ? error.message : String(error),
                id: evidenceId,
            });
        }
        throw error;
    }
    finally {
        releaseControlLock();
    }
}
export function archiveRun(runOrDir, expected = {}) {
    return retainRun(runOrDir, "archive", expected);
}
export function pruneRun(runOrDir, options = {}, expected = {}) {
    return retainRun(runOrDir, "prune", expected, options);
}
export function killRun(runOrDir, expected = {}) {
    const result = stopRun(runOrDir, "SIGKILL", "run.kill", expected);
    return Object.hasOwn(result, "stopped")
        ? { killed: result.stopped, ...result }
        : result;
}
