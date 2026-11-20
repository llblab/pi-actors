/**
 * Command-template async run lifecycle facade.
 * Owns: launch, state observation, listing, message/control facade methods, and retention while runs-* subdomains own narrower run internals.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, types as UtilTypes } from "node:util";
import { acquireFileMutationLock, writeJsonAtomic } from "./file-state.js";
import { CURRENT_MODEL_VALUE_KEY, CURRENT_THINKING_VALUE_KEY, describeCurrentPolicyProvenance, } from "./model-context.js";
import * as Paths from "./paths.js";
import * as RunDeliveryLineage from "./run-delivery-lineage.js";
import * as RecipesReferences from "./recipes-references.js";
import * as RecipesUsage from "./recipes-usage.js";
import * as Schema from "./schema.js";
import { resolveArtifactPaths, shadowsCanonicalRunFile, } from "./runs-artifacts.js";
import { runContextExportPaths } from "./runs-context-index.js";
import { safeRunId } from "./runs-identity.js";
import { recipeStem, rememberRunName, reserveRunName, RUN_NAME_LEDGER_DIR, sessionComponent } from "./runs-naming.js";
import { recordRunDescendantLaunchIntentUnderLock, recordRunDescendantPreparationUnderLock, RUN_DESCENDANT_PREPARED_META_FILE } from "./runs-descendant-launches.js";
import { RUN_OUTCOME_PROTOCOL, RUN_RETAINED_SOURCE_FILES } from "./runs-outcomes.js";
import { buildTerminalProgress, markTerminalHandled, signalOwnedRunProcess, } from "./runs-control.js";
import { assertDistinctRunStateDirectories, assertOwnedRunStateDirectory, claimRunStateDirectory } from "./runs-ownership.js";
import { reportRunProducerCleanupFailure, revalidateRunWorkAdmission, withRunWorkAdmission } from "./runs-results.js";
import { retainRun, } from "./runs-retention.js";
import { captureSpawnedRunProcessIdentity, readProcessLiveness, verifyRunProcessIdentity, } from "./runs-process.js";
import * as RuntimeIdentity from "./runtime-identity.js";
import * as RunsStart from "./runs-start.js";
import { captureRunAdmissionSnapshotReferences } from "./runs-context-exports.js";
import * as RunSupervision from "./run-supervision.js";
import { appendRunTraceEvent } from "./runs-trace.js";
import * as RunsIndex from "./runs-index.js";
import * as RunsParentTeardown from "./runs-parent-teardown.js";
import { deliverRunControl, } from "./runs-control-delivery.js";
import { buildRunStatus, readRunInventoryStatuses, tailFile, } from "./runs-status.js";
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
/**
 * Only a caller-chosen name or a singleton identity is exact; a Recipe name is merely the stem of an
 * allocated `<stem>-<ordinal>` name, so two launches of one Recipe never share a Run address.
 */
function allocateRunName(caller, resolved) {
    if (resolved.state_dir)
        return safeRunId(resolved.run_id);
    const session = sessionComponent(resolved.ownerId);
    const requested = typeof caller.run_id === "string" ? caller.run_id.trim() : "";
    const recipe = [resolved.file, resolved.name, requested, resolved.run_id]
        .find(value => typeof value === "string" && value.trim().length > 0) ?? "run";
    const exact = safeRunId(requested || resolved.run_id);
    const reservation = resolved.singleton === true || (requested.length > 0 && resolved.reenter === true)
        ? rememberRunName(DEFAULT_STATE_ROOT, session, recipe, exact)
        : requested.length > 0
            ? reserveRunName(DEFAULT_STATE_ROOT, session, recipe, { kind: "explicit", name: exact })
            : reserveRunName(DEFAULT_STATE_ROOT, session, recipe, { kind: "auto", stem: recipeStem(recipe) });
    if (reservation.state === "refused") {
        if (reservation.reason === "name_invalid" && (requested.length > 0 || resolved.singleton === true)) {
            throw new Error(`Run name ${exact} is reserved by the runtime or not portable (archived, preserved-artifacts, device aliases and trailing dots are refused); choose another name.`);
        }
        if (reservation.reason !== "run_name_taken")
            throw new Error(`Run name reservation failed: ${reservation.reason}`);
        const earlierDirectory = join(DEFAULT_STATE_ROOT, session, exact);
        let earlier;
        try {
            earlier = readJson(join(earlierDirectory, "run.json")) ? getRunStatus(earlierDirectory) : undefined;
        }
        catch {
            earlier = undefined;
        }
        const facts = earlier
            ? ` The earlier execution is still addressable as run:${exact} (${String(earlier.status ?? "unknown")}, generation ${String(earlier.run_instance_id ?? "unknown")}); inspect it before choosing another name.`
            : "";
        throw new Error(`Run name ${exact} was already used in this session; choose a new name or let the runtime allocate one.${facts}`);
    }
    return reservation.name;
}
function resolveStateDir(params, run) {
    return resolve(params.state_dir || join(DEFAULT_STATE_ROOT, sessionComponent(params.ownerId), run));
}
/** The context-index export namespace is compiler-owned; a declared output may not occupy one of its paths. */
const RUN_PUBLISHED_PATHS = [...runContextExportPaths(), ...RUN_RETAINED_SOURCE_FILES];
function assertNoActiveRunState(stateDir) {
    RunsStart.assertNoActiveRunState(stateDir, readJson, RUNNER_PATH);
}
/**
 * A singleton protects one service, not one directory. Session-scoped Run directories would otherwise let a
 * second session start a duplicate service under the same Recipe, so an active instance elsewhere refuses.
 */
function assertSingletonNotOwnedByAnotherSession(startParams, stateDir) {
    const recipeId = startParams.singleton_recipe_id;
    if (!recipeId)
        return;
    const canonical = resolve(stateDir);
    for (const directory of RunsIndex.listRunStateDirs(DEFAULT_STATE_ROOT)) {
        if (resolve(directory) === canonical)
            continue;
        const meta = readJson(join(directory, "run.json"));
        if (!meta || meta.singleton !== true || meta.singleton_recipe_id !== recipeId)
            continue;
        if (meta.ownerId === startParams.ownerId)
            continue;
        const progress = readJson(join(directory, "progress.json"));
        if (String(meta.status ?? progress?.phase ?? "") !== "running")
            continue;
        // A recorded "running" phase whose runner is provably gone is stale evidence, not a live service; unknown stays refused.
        if (readProcessLiveness(Number(meta.pid)) === "dead")
            continue;
        throw new Error(`Singleton Recipe ${recipeId} is already running for another logical session: ${String(meta.run ?? directory)}. `
            + "Control it from its owning session or stop it before starting a second service.");
    }
}
/**
 * Cross-session admission for one singleton Recipe. Session directories no longer share a start lock, so this
 * service-scoped lock spans the other-session check and publication; it is always taken before the directory lock.
 */
function acquireSingletonAdmissionLock(startParams) {
    const recipeId = startParams.singleton === true ? startParams.singleton_recipe_id : undefined;
    if (!recipeId)
        return undefined;
    return acquireFileMutationLock(join(DEFAULT_STATE_ROOT, RUN_NAME_LEDGER_DIR, ".singleton", encodeURIComponent(recipeId)));
}
function reuseCompatibleSingletonRun(stateDir, startParams, singletonValues, supervisionPolicy) {
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
    const clock = RunSupervision.readRunSupervisionClock(existing);
    const existingPolicy = clock?.supervision ?? RunSupervision.resolveRunSupervisionPolicy();
    if (!RunSupervision.sameRunSupervisionPolicy(existingPolicy, supervisionPolicy)) {
        throw new Error(`Active singleton Run ${String(existing.run ?? stateDir)} has incompatible supervision policy. Stop it before changing singleton configuration.`);
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
    const meta = startRunInternal(params, cwd, options);
    // Internal return includes lifecycle release. Catalog failure must not retry or undo the accepted launch/attachment.
    delete meta.catalog_registration;
    delete meta.catalog_registration_error;
    try {
        RunsIndex.registerRunStateDirectory(DEFAULT_STATE_ROOT, meta.state_dir, meta);
    }
    catch (error) {
        meta.catalog_registration = Object.freeze({ state: "unavailable", reason: "catalog_registration_failed" });
        Object.defineProperty(meta, "catalog_registration_error", { value: error, enumerable: false });
    }
    return meta;
}
/** Kernel-only prepare path: real generation creation, but no native process, workload, launch receipt, or membership authority. */
export function prepareDescendantRunGeneration(parentStateDir, producer, params, cwd, options = {}) {
    return withRunWorkAdmission(parentStateDir, producer, () => {
        const parent = Object.freeze({ run: producer.run, run_instance_id: producer.runInstanceId,
            ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }),
            state_dir: assertOwnedRunStateDirectory(parentStateDir, producer.run) });
        return startRunInternal(params, cwd, options, {
            parent, producer,
            observe: (meta, preparation) => {
                revalidateRunWorkAdmission(parentStateDir, producer);
                return recordRunDescendantLaunchIntentUnderLock(parent.state_dir, producer, {
                    run: meta.run, runInstanceId: meta.run_instance_id, ownerId: meta.ownerId, stateDir: meta.state_dir,
                }, preparation);
            },
            onCleanupFailure: (error) => reportRunProducerCleanupFailure(producer, error),
        });
    });
}
function startRunInternal(params, cwd, options, prepared) {
    const resolvedParams = resolveStartParams(params, cwd, options);
    const startParams = { ...resolvedParams, run_id: allocateRunName(params, resolvedParams) };
    // Policy ingress stays closed until runtime enforcement is implemented.
    const supervisionPolicy = RunSupervision.resolveRunSupervisionPolicy();
    const resolved = resolveRunTemplate(startParams);
    const run = safeRunId(startParams.run_id);
    const stateDir = resolveStateDir(startParams, run);
    if (prepared)
        assertDistinctRunStateDirectories(prepared.parent.state_dir, stateDir);
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
    if (startParams.singleton !== true || prepared)
        assertNoActiveRunState(stateDir);
    if (prepared)
        RunsStart.assertFreshRunPreparationState(stateDir);
    const declaredArtifacts = resolveArtifactPaths(startParams.artifacts, { ...(startParams.defaults || {}), ...values });
    for (const declaration of Object.values(declaredArtifacts ?? {})) {
        const path = typeof declaration === "string" ? declaration : declaration.path;
        if (shadowsCanonicalRunFile(path, stateDir, cwd, RUN_PUBLISHED_PATHS)) {
            throw new Error(`Run artifact declaration shadows a canonical Run file: ${path}`);
        }
    }
    mkdirSync(stateDir, { recursive: true });
    const releaseSingletonLock = acquireSingletonAdmissionLock(startParams);
    let releaseStartLock;
    try {
        releaseStartLock = acquireStateStartLock(stateDir, {
            onContention: startParams.lifecycleHooks?.onLockContention,
        });
    }
    catch (error) {
        releaseSingletonLock?.();
        throw error;
    }
    try {
        claimRunStateDirectory(stateDir, run);
        if (prepared)
            RunsStart.assertFreshRunPreparationState(stateDir);
        if (!prepared && recipeFile &&
            isMutableUsageRecipeFile(recipeFile) &&
            !RecipesUsage.recordRecipeLaunch(recipeFile, new Date(), startParams.launch_source === "tool" ? "tool" : "spawn")) {
            throw new Error(`Recipe launch rejected because its source changed during activation: ${recipeFile}. Reload recipe tools and retry.`);
        }
        if (startParams.singleton === true) {
            const existing = reuseCompatibleSingletonRun(stateDir, startParams, singletonValues, supervisionPolicy);
            if (existing) {
                if (prepared)
                    throw new Error("Run descendant preparation requires a new generation, not singleton attachment.");
                return existing;
            }
            assertSingletonNotOwnedByAnotherSession(startParams, stateDir);
        }
        else
            assertNoActiveRunState(stateDir);
        const clockObserver = prepared ? undefined : options.onSupervisionClockCaptured;
        const timeOrigin = clockObserver ? RunSupervision.captureRunSupervisionTimeOrigin() : undefined;
        const capturedGeneration = timeOrigin ? randomUUID() : undefined;
        const clock = RunSupervision.createRunSupervisionClock(supervisionPolicy, timeOrigin?.wall_ms ?? Date.now());
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
        const argv = asyncRunnerArgv(stateDir);
        const outputValues = {
            ...(startParams.defaults || {}),
            ...values,
        };
        const transportContext = normalizeRunTransportContext(startParams.transport_context);
        const artifacts = declaredArtifacts;
        const runInstanceId = capturedGeneration ?? randomUUID();
        const deliveryLineage = RunDeliveryLineage.inheritedRunDeliveryLineage(startParams.ownerId);
        const meta = {
            argv: [process.execPath, ...argv],
            createdAt: clock.started_at,
            ...clock,
            supervision_provenance: supervisionPolicy.provenance,
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
            outcome_protocol: RUN_OUTCOME_PROTOCOL,
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
        // Finish fallible metadata assembly before handing off admission, clearing retained evidence or opening captures.
        if (clockObserver && timeOrigin && capturedGeneration) {
            const observation = Object.freeze({ kind: "run_clock_origin_captured", visibility: "kernel_only",
                publication: "unpublished", work_started: false, state_dir: stateDir,
                identity: Object.freeze({ run, run_instance_id: capturedGeneration, ...(startParams.ownerId ? { ownerId: startParams.ownerId } : {}) }),
                clock: Object.freeze({ started_at: clock.started_at, supervision: Object.freeze({ ...clock.supervision }) }), origin: timeOrigin,
                snapshot_references: captureRunAdmissionSnapshotReferences(stateDir, meta, timeOrigin) });
            const returned = clockObserver.call(options, observation);
            if (UtilTypes.isPromise(returned)) {
                // Unsupported async retention may already have started; settle rejection without awaiting it under the lock.
                void Promise.prototype.then.call(returned, undefined, () => undefined);
                throw new Error("Run supervision admission observer must complete synchronously.");
            }
            if (returned && (typeof returned === "object" || typeof returned === "function") && "then" in returned) {
                throw new Error("Run supervision admission observer must complete synchronously.");
            }
        }
        if (!prepared)
            prepareStateDirForStart(stateDir);
        const captureFds = prepared ? undefined : [openSync(stdout, "a"), openSync(stderr, "a")];
        writeJsonAtomic(join(stateDir, prepared ? RUN_DESCENDANT_PREPARED_META_FILE : "run.json"), meta);
        if (prepared) {
            const target = Object.freeze({ run: meta.run, run_instance_id: meta.run_instance_id,
                ...(meta.ownerId === undefined ? {} : { ownerId: meta.ownerId }), state_dir: meta.state_dir });
            const preparation = recordRunDescendantPreparationUnderLock(stateDir, target, prepared.parent, prepared.producer);
            return prepared.observe(meta, preparation);
        }
        writeJsonAtomic(join(stateDir, "progress.json"), {
            completed: 0,
            failures: [],
            model_policy: modelPolicy,
            phase: "starting",
            updatedAt: new Date().toISOString(),
        });
        const [outFd, errFd] = captureFds;
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
        const processIdentity = captureSpawnedRunProcessIdentity(child, cwd, stateDir, RUNNER_PATH);
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
        try {
            if (prepared) {
                try {
                    releaseStartLock();
                }
                catch (error) {
                    prepared.onCleanupFailure(error);
                }
            }
            else
                releaseStartLock();
        }
        finally {
            releaseSingletonLock?.();
        }
    }
}
/** A bare name is meaningful only inside one logical session; a caller without one must pass an absolute path. */
function resolveRunStateDir(runOrDir, session) {
    if (/[\\/]/u.test(runOrDir))
        return resolve(runOrDir);
    const name = safeRunId(runOrDir);
    const observed = typeof session === "function" ? session() : session;
    if (observed === undefined) {
        throw Object.assign(new Error(`Run name requires its owning session: ${name}`), { reason: "session_unavailable" });
    }
    return resolve(join(DEFAULT_STATE_ROOT, sessionComponent(observed), name));
}
export function getRunStatus(runOrDir, session) {
    const stateDir = resolveRunStateDir(runOrDir, session);
    const meta = readJson(join(stateDir, "run.json"));
    if (!meta)
        throw new Error(`Run not found: ${runOrDir}`);
    return buildRunStatus(stateDir, runOrDir, meta, readJson, RUNNER_PATH, RUNNER_IDENTITY_GRACE_MS);
}
/** Internal inventory acquisition; direct status and lifecycle readers remain independently scalar. */
export function getRunInventoryStatuses(stateDirs) {
    return readRunInventoryStatuses(stateDirs, readJson, getRunStatus);
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
export function tailRun(runOrDir, lines = 40, session) {
    const status = getRunStatus(runOrDir, session);
    const stateDir = String(status.state_dir);
    const trace = tailFile(join(stateDir, "trace.jsonl"), lines);
    if (trace)
        return trace;
    return (tailFile(join(stateDir, "stdout.log"), lines) ||
        tailFile(join(stateDir, "stderr.log"), lines));
}
export async function sendRunControl(runOrDir, request, options = {}) {
    const stateDir = resolveRunStateDir(runOrDir, () => options.ownerId);
    const releaseControlLock = RunsStart.acquireStateStartLock(stateDir);
    let requestFailed = false, requestFailure;
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
    catch (error) {
        requestFailed = true;
        requestFailure = error;
        throw error;
    }
    finally {
        try {
            releaseControlLock();
        }
        catch (releaseError) {
            if (requestFailed)
                throw new AggregateError([requestFailure, releaseError], "Run Control request and lifecycle release failed; effects may already exist.", { cause: requestFailure });
            throw releaseError;
        }
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
    const stateDir = resolveRunStateDir(runOrDir, () => expected.ownerId);
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
export function archiveRun(runOrDir, expected = {}) {
    return retainRun(resolveRunStateDir(runOrDir, () => expected.ownerId), "archive", expected, getRunStatus);
}
export function pruneRun(runOrDir, options = {}, expected = {}) {
    return retainRun(resolveRunStateDir(runOrDir, () => expected.ownerId), "prune", expected, getRunStatus, options);
}
export function killRun(runOrDir, expected = {}) {
    const result = stopRun(runOrDir, "SIGKILL", "run.kill", expected);
    return Object.hasOwn(result, "stopped")
        ? { killed: result.stopped, ...result }
        : result;
}
