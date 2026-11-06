/**
 * Producer-bound Run context, primary text and index orchestration.
 * Owns: admitted privacy capture, atomic derived views, producer-backed saved Recipe/Trace/Control/Execution/Result correspondence, immutable primary source publication/readonly admission and index assembly.
 * Excludes: public routing, session/composed/failure primary publication, live clocks and native work/control authority.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { readExecutionCaptureText, RUN_STREAM_SOURCE_MAX_BYTES } from "./execution-files.js";
import { isAbsolute, join, sep } from "node:path";
import { isPromise } from "node:util/types";
import { isDeepStrictEqual } from "node:util";
import { normalizeControlAction, normalizeControlInput } from "./control.js";
import { projectRunControl } from "./control-projection.js";
import { projectRunExecutionManifest } from "./runs-execution-evidence.js";
import { writeTextAtomic } from "./file-state.js";
import { COMPACT_PREVIEW_CHARS, DEFAULT_INSPECT_LINES, RUN_COMPLETION_MODEL_MAX_BYTES, RUN_DELIVERY_JOURNAL_MAX_BYTES, RUN_DELIVERY_MODEL_MAX_BYTES, RUN_CONTROL_JOURNAL_MAX_BYTES, TRACE_JOURNAL_MAX_BYTES } from "./limits.js";
import { createRunRecipeBodyRedactor, createRunRecipeTextRedactor, projectRunRecipe, capturedSecretMask, createContextIdentityPrivacyCheck } from "./recipe-projection.js";
import { computeRunControlCapacity } from "./run-evidence-policy.js";
import { readRunSupervisionClock, createRunSupervisionTimebase } from "./run-supervision.js";
import { classifyRuntimeControl } from "./runtime-triage.js";
import { runContextExportPath, writeRunContextIndexUnderLock, readRunContextIdentity, readRunContextIndex, RUN_CONTEXT_INDEX_FILE, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "./runs-context-index.js";
import { readRunControlJournalFromStateDir, runControlsFile } from "./runs-controls.js";
import { assertOwnedRunStateDirectory, RUN_STATE_OWNERSHIP_FILE } from "./runs-ownership.js";
import { describeRunArtifactReferences, observeRunArtifactReference } from "./runs-artifacts.js";
import { decodeRunPrimaryTextBinding, readRunNaturalOutcomeSnapshot, RUN_OUTCOME_PROTOCOL, RUN_PRIMARY_TEXT_PROTOCOL, RUN_ARTIFACT_INVENTORY_PROTOCOL, decodeRunArtifactInventoryBinding, RUN_RESULT_DIAGNOSTIC_FIELDS as RESULT_DIAGNOSTIC_FIELDS, RUN_RESULT_DIAGNOSTICS_PROTOCOL, decodeRunResultDiagnosticsBinding, RUN_RESULT_DIAGNOSTIC_EXCERPT_CHARS, decodeRunResultDiagnosticExcerpt } from "./runs-outcomes.js";
import { withRunProducerEvidence, readRunProducerCapturedMetadata, readRunProducerCleanupFailure, withRunResultDiagnosticsAdmission } from "./runs-results.js";
import { readRunTraceJournal, runTraceFile, summarizeRunTraceJournal } from "./runs-trace.js";
import { readJsonFileResilient, readJsonlFileResilient } from "./state-readers.js";
import { projectRunTraceJournal } from "./trace-projection.js";
import { redactSessionEvidenceValue } from "./session-evidence.js";
export { readRunSessionContextPreview, writeRunSessionContextExport, writeRunSessionContextIndex, RUN_CONTEXT_SESSIONS_MAX_BYTES } from "./runs-session-exports.js";
export const RUN_CONTEXT_CONTROL_MAX_BYTES = 64 * 1024;
const CONTROL_VIEW_SCHEMA = "run-context-control-v1";
const CONTROL_VIEW_COVERAGE = Object.freeze({ truncated: true, history_complete: false, redacted: true });
export const RUN_CONTEXT_RECIPE_MAX_BYTES = 64 * 1024;
const RECIPE_VIEW_COVERAGE = Object.freeze({ truncated: true, redacted: true });
export const RUN_CONTEXT_TRACE_MAX_BYTES = 64 * 1024;
const TRACE_VIEW_COVERAGE = Object.freeze({ truncated: true, history_complete: false, redacted: true });
export const RUN_CONTEXT_RESULT_MAX_BYTES = 64 * 1024;
export const RUN_RESULT_DIAGNOSTICS_MAX_BYTES = 4 * 1024 * 1024;
const RESULT_DIAGNOSTIC_PREVIEW_CHARS = 4_000;
const RESULT_VIEW_COVERAGE = Object.freeze({ truncated: true, redacted: true });
export const RUN_CONTEXT_ARTIFACT_MAX_BYTES = 64 * 1024;
export const RUN_ARTIFACT_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
const ARTIFACT_VIEW_COVERAGE = Object.freeze({ truncated: false, redacted: true });
export const RUN_CONTEXT_EXECUTION_MAX_BYTES = 64 * 1024;
const EXECUTION_VIEW_COVERAGE = Object.freeze({ truncated: true, history_complete: false, redacted: true });
const VIEW_CONFIG = {
    control: { schema: CONTROL_VIEW_SCHEMA, format: "json", media: "application/json", maxBytes: RUN_CONTEXT_CONTROL_MAX_BYTES, coverage: CONTROL_VIEW_COVERAGE },
    recipe: { schema: "run-context-recipe-v1", format: "json", media: "application/json", maxBytes: RUN_CONTEXT_RECIPE_MAX_BYTES, coverage: RECIPE_VIEW_COVERAGE },
    trace: { schema: "run-context-trace-v1", format: "jsonl", media: "application/x-ndjson", maxBytes: RUN_CONTEXT_TRACE_MAX_BYTES, coverage: TRACE_VIEW_COVERAGE },
    result: { schema: "run-context-result-v1", format: "json", media: "application/json", maxBytes: RUN_CONTEXT_RESULT_MAX_BYTES, coverage: RESULT_VIEW_COVERAGE },
    artifacts: { schema: "run-context-artifacts-v1", format: "json", media: "application/json", maxBytes: RUN_CONTEXT_ARTIFACT_MAX_BYTES, coverage: ARTIFACT_VIEW_COVERAGE },
    execution: { schema: "run-context-execution-v1", format: "json", media: "application/json", maxBytes: RUN_CONTEXT_EXECUTION_MAX_BYTES, coverage: EXECUTION_VIEW_COVERAGE },
};
class ContextExportBindingRefusal extends Error {
}
// Producer-scoped admitted Trace bytes, never a generic registry or saved/hash-reconstructed capability.
const tracePublications = new WeakMap();
// Separate role authority: a successful Trace publication never admits a Control view.
const controlPublications = new WeakMap();
const executionPublications = new WeakMap();
const resultPublications = new WeakMap();
function executionUnavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function artifactUnavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function resultUnavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function traceUnavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function recipeUnavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function unavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function sameObject(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) {
    return right.isFile() && sameObject(left, right) && left.size === right.size &&
        left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function optionalStamp(path) {
    try {
        return lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function captureControl(stateDir, producer, status) {
    const metadata = readContextMetadata(stateDir, producer);
    if (metadata.state === "unavailable")
        return unavailable(metadata.reason === "changed" ? "control_metadata_changed" : "control_metadata_unavailable");
    const unchanged = captureContextMetadataFence(metadata, producer);
    if (!unchanged)
        return unavailable("control_metadata_changed");
    const original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    if (!original)
        return unavailable("control_admission_unavailable");
    const redact = createRunRecipeBodyRedactor(original, Number.MAX_SAFE_INTEGER);
    const identityUnchanged = createContextIdentityPrivacyCheck(original);
    const headerIdentity = { run: producer.run, run_instance_id: producer.runInstanceId };
    if (!identityUnchanged(headerIdentity))
        return unavailable("control_identity_redacted");
    const path = runControlsFile(stateDir);
    const before = optionalStamp(path);
    if (!before)
        return unavailable("control_journal_absent");
    if (!before.isFile() || before.size > BigInt(RUN_CONTROL_JOURNAL_MAX_BYTES))
        return unavailable("control_journal_unavailable");
    const journal = readRunControlJournalFromStateDir(stateDir);
    if (journal.diagnostics.length)
        return unavailable("control_journal_invalid");
    const after = optionalStamp(path);
    if (!after || !sameFile(before, after))
        return unavailable("control_journal_changed");
    const current = [];
    let foreign = 0;
    const now = Date.now();
    const timestampFields = ["queued_at", "delivered_at", "claimed_at", "handled_at", "failed_at"];
    for (const value of journal.records) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return unavailable("control_journal_invalid");
        const record = value;
        if (typeof record.run_instance_id !== "string" || !record.run_instance_id)
            return unavailable("control_journal_invalid");
        if (record.run_instance_id !== producer.runInstanceId) {
            foreign++;
            continue;
        }
        try {
            normalizeControlAction(record.action);
            if (record.input !== undefined)
                normalizeControlInput(record.input);
            if (record.error !== undefined && typeof record.error !== "string")
                return unavailable("control_journal_invalid");
            for (const field of timestampFields) {
                const timestamp = record[field];
                if ((field === "queued_at" || timestamp !== undefined) &&
                    (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))))
                    return unavailable("control_journal_invalid");
            }
            if (classifyRuntimeControl({ run: producer.run, runInstanceId: producer.runInstanceId, status }, value, now).diagnostic) {
                return unavailable("control_journal_invalid");
            }
        }
        catch {
            return unavailable("control_journal_invalid");
        }
        current.push(record);
    }
    const capacity = computeRunControlCapacity(current);
    if (capacity.oldest_pending_at !== undefined && !identityUnchanged({ oldest_pending_at: capacity.oldest_pending_at })) {
        return unavailable("control_metadata_redacted");
    }
    const capturedAt = new Date().toISOString();
    if (!identityUnchanged({ captured_at: capturedAt }))
        return unavailable("control_metadata_redacted");
    // Safe references stay exact, never Inspector previews; privacy-changed references omit the whole row.
    const controls = current.slice(-DEFAULT_INSPECT_LINES).flatMap(control => {
        const identity = { id: control.id, run_instance_id: control.run_instance_id, action: control.action,
            ...Object.fromEntries(timestampFields.flatMap(field => control[field] === undefined ? [] : [[field, control[field]]])) };
        if (!identityUnchanged(identity))
            return [];
        return [{ ...projectRunControl({ ...control,
                    ...(control.input === undefined ? {} : { input: redact(control.input) }),
                    ...(control.error === undefined ? {} : { error: redact(control.error) }) }), ...identity }];
    });
    const encode = () => JSON.stringify({ schema: CONTROL_VIEW_SCHEMA, run: producer.run, run_instance_id: producer.runInstanceId,
        captured_at: capturedAt, run_status: status, coverage: CONTROL_VIEW_COVERAGE,
        capacity, controls,
        controls_omitted: current.length - controls.length, foreign_controls_omitted: foreign }, null, 2) + "\n";
    let content = encode();
    while (controls.length && Buffer.byteLength(content, "utf8") > RUN_CONTEXT_CONTROL_MAX_BYTES) {
        controls.shift();
        content = encode();
    }
    if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_CONTROL_MAX_BYTES)
        return unavailable("control_journal_unavailable");
    // Fence the admitted metadata frame, not journal freshness after this recorded snapshot.
    return unchanged() ? Object.freeze({ status: "captured", captured_at: capturedAt, content, unchanged, original_root: metadata.root }) : unavailable("control_metadata_changed");
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** Source data only; callers must already hold genuine producer evidence admission. */
function readContextMetadata(stateDir, producer) {
    const root = assertOwnedRunStateDirectory(stateDir, producer.run);
    const path = join(root, "run.json");
    const before = optionalStamp(path);
    if (!before?.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
        return { state: "unavailable", reason: "unavailable" };
    const read = readJsonFileResilient(path, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES });
    const after = optionalStamp(path);
    if (!after || !sameFile(before, after))
        return { state: "unavailable", reason: "changed" };
    const meta = record(read.value);
    if (read.diagnostics.length || !meta)
        return { state: "unavailable", reason: "invalid" };
    if (meta.run !== producer.run || meta.run_instance_id !== producer.runInstanceId || meta.ownerId !== producer.ownerId ||
        meta.state_dir !== root)
        return { state: "unavailable", reason: "changed" };
    return { state: "available", root, path, stamp: after, meta };
}
/** Readonly current-frame observation, never producer or body permission; callers already hold evidence admission. */
function captureContextMetadataFence(metadata, producer) {
    const owner = readRunContextIdentity(metadata.root, { run: producer.run, run_instance_id: producer.runInstanceId,
        ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) });
    if (owner.state !== "available" || owner.local_path !== metadata.root)
        return undefined;
    const unchanged = () => {
        try {
            return owner.unchanged() && sameFile(metadata.stamp, lstatSync(metadata.path, { bigint: true }));
        }
        catch {
            return false;
        }
    };
    return unchanged() ? unchanged : undefined;
}
/** Checked fixed-source I/O only. Each caller must already admit its producer, projection policy and derived target. */
function retainContextSource(metadata, path, content, maxBytes, label) {
    const root = lstatSync(metadata.root, { bigint: true });
    const markerPath = join(metadata.root, RUN_STATE_OWNERSHIP_FILE);
    const marker = lstatSync(markerPath, { bigint: true });
    const evidencePath = join(metadata.root, "evidence");
    let evidence = optionalStamp(evidencePath);
    if (evidence && (!evidence.isDirectory() || evidence.isSymbolicLink()))
        throw new ContextExportBindingRefusal(`${label} directory binding is invalid.`);
    if (!evidence) {
        mkdirSync(evidencePath);
        evidence = lstatSync(evidencePath, { bigint: true });
    }
    const frameUnchanged = () => sameObject(root, lstatSync(metadata.root, { bigint: true })) &&
        sameFile(metadata.stamp, lstatSync(metadata.path, { bigint: true })) && sameFile(marker, lstatSync(markerPath, { bigint: true })) &&
        sameObject(evidence, lstatSync(evidencePath, { bigint: true }));
    if (!frameUnchanged())
        throw new ContextExportBindingRefusal(`${label} publication binding changed.`);
    if (optionalStamp(path)) {
        if (readFixedSourceText(path, maxBytes, `${label} source`).text !== content) {
            throw new ContextExportBindingRefusal(`${label} identity already fixes different bytes.`);
        }
    }
    else {
        // Source, view and index remain separate effects; preserve partial/orphan writes on failure.
        writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    }
    const saved = readFixedSourceText(path, maxBytes, `${label} source`);
    if (saved.text !== content || !frameUnchanged())
        throw new ContextExportBindingRefusal(`${label} publication binding changed.`);
    return { unchanged: () => { try {
            return frameUnchanged() && sameFile(saved.stamp, lstatSync(path, { bigint: true }));
        }
        catch {
            return false;
        } } };
}
function projectCapturedRecipe(meta) {
    const contexts = meta.recipe_context_records;
    if (contexts !== undefined && (!Array.isArray(contexts) || contexts.some(value => !record(value))))
        return recipeUnavailable("recipe_metadata_invalid");
    const template = meta.template;
    if (template !== undefined && !(typeof template === "string" && template.length > 0) &&
        !(Array.isArray(template) && template.length > 0) && !record(template))
        return recipeUnavailable("recipe_metadata_invalid");
    const recipe = projectRunRecipe(meta, [], createRunRecipeBodyRedactor(meta));
    if (template === undefined && !recipe.definition)
        return recipeUnavailable("recipe_capture_absent");
    const clock = readRunSupervisionClock(meta);
    if (clock && !createContextIdentityPrivacyCheck(meta)({ started_at: clock.started_at }))
        return recipeUnavailable("recipe_metadata_redacted");
    return { status: "projected", capture: recipe.definition ? "definition_and_launch" : "launch_only", recipe, ...(clock ? { stored_clock: clock } : {}) };
}
function captureRecipe(stateDir, producer) {
    const metadata = readContextMetadata(stateDir, producer);
    if (metadata.state === "unavailable")
        return recipeUnavailable(metadata.reason === "changed" ? "recipe_metadata_changed"
            : metadata.reason === "invalid" ? "recipe_metadata_invalid" : "recipe_metadata_unavailable");
    const unchanged = captureContextMetadataFence(metadata, producer);
    if (!unchanged)
        return recipeUnavailable("recipe_metadata_changed");
    // Live metadata fences the observation; it cannot renew static launch selection or its privacy policy.
    const meta = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    if (!meta)
        return recipeUnavailable("recipe_admission_unavailable");
    const metadataUnredacted = createContextIdentityPrivacyCheck(meta);
    if (!metadataUnredacted({ run: producer.run, run_instance_id: producer.runInstanceId }))
        return recipeUnavailable("recipe_identity_redacted");
    const projected = projectCapturedRecipe(meta);
    if (projected.status === "unavailable")
        return projected;
    const { status: _status, ...fields } = projected;
    const capturedAt = new Date().toISOString();
    if (!metadataUnredacted({ captured_at: capturedAt }))
        return recipeUnavailable("recipe_metadata_redacted");
    const content = JSON.stringify({ schema: VIEW_CONFIG.recipe.schema, run: producer.run, run_instance_id: producer.runInstanceId,
        captured_at: capturedAt, coverage: RECIPE_VIEW_COVERAGE, ...fields }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_RECIPE_MAX_BYTES)
        return recipeUnavailable("recipe_view_too_large");
    return unchanged() ? Object.freeze({ status: "captured", captured_at: capturedAt, content, unchanged }) : recipeUnavailable("recipe_metadata_changed");
}
function recipeReadUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Checked-source observation only; each private caller already owns its original projection/publication admission. */
function readSavedContextViewSource(stateDir, identity, role) {
    const owner = readRunContextIdentity(stateDir, identity);
    if (owner.state !== "available")
        return owner;
    let reason = "index_unavailable";
    try {
        const root = owner.local_path, indexPath = join(root, RUN_CONTEXT_INDEX_FILE), index = optionalStamp(indexPath);
        if (!index?.isFile())
            return { state: "unavailable", reason: "index_unavailable" };
        const admitted = readRunContextIndex(root, owner.identity);
        if (admitted.state !== "available")
            return { state: "unavailable", reason: admitted.reason === "observation_changed" ? "observation_changed" : "index_unavailable" };
        const entry = admitted.index.entries[role], config = VIEW_CONFIG[role];
        if (entry.availability !== "available" || entry.mutable !== true || !isDeepStrictEqual(entry.coverage, config.coverage))
            return { state: "unavailable", reason: "role_unavailable" };
        reason = "view_unavailable";
        const evidencePath = join(root, "evidence"), evidence = lstatSync(evidencePath, { bigint: true });
        if (!evidence.isDirectory() || evidence.isSymbolicLink())
            return { state: "unavailable", reason: "view_unavailable" };
        const path = runContextExportPath(role), viewPath = join(root, path);
        const captured = readFixedSourceText(viewPath, config.maxBytes, "Run " + role + " saved view");
        const unchanged = () => {
            try {
                return owner.unchanged() && sameFile(index, lstatSync(indexPath, { bigint: true })) &&
                    sameObject(evidence, lstatSync(evidencePath, { bigint: true })) && sameFile(captured.stamp, lstatSync(viewPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!unchanged())
            return { state: "unavailable", reason: "observation_changed" };
        if (Number(captured.stamp.size) !== entry.bytes_total)
            return { state: "unavailable", reason: "view_invalid" };
        return { state: "available", identity: owner.identity, path, text: captured.text, bytes_total: Number(captured.stamp.size), unchanged };
    }
    catch {
        return { state: "unavailable", reason };
    }
}
function freezeContextValue(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freezeContextValue);
        Object.freeze(value);
    }
    return value;
}
/** Kernel-local original data correspondence, not file-issuer authentication or work/caller/restart authority. */
export function readRunRecipeContextView(stateDir, producer) {
    let original;
    try {
        original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    }
    catch {
        return recipeReadUnavailable("admission_invalid");
    }
    if (!original)
        return recipeReadUnavailable("admission_unavailable");
    if (typeof stateDir !== "string" || !isAbsolute(stateDir) || stateDir !== original.state_dir || original.run !== producer.run ||
        original.run_instance_id !== producer.runInstanceId || original.ownerId !== producer.ownerId)
        return recipeReadUnavailable("identity_mismatch");
    const identity = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) };
    const metadataUnredacted = createContextIdentityPrivacyCheck(original);
    if (!metadataUnredacted(identity))
        return recipeReadUnavailable("identity_redacted");
    let projected;
    try {
        projected = projectCapturedRecipe(original);
    }
    catch {
        return recipeReadUnavailable("admission_unavailable");
    }
    if (projected.status === "unavailable")
        return recipeReadUnavailable("admission_unavailable");
    const { status: _status, ...expected } = projected;
    const source = readSavedContextViewSource(stateDir, identity, "recipe");
    if (source.state !== "available")
        return recipeReadUnavailable(source.reason === "role_unavailable" ? "recipe_unavailable" : source.reason);
    try {
        const view = record(JSON.parse(source.text));
        if (!view || !contextFields(view, ["schema", "run", "run_instance_id", "captured_at", "coverage", "capture", "recipe", "stored_clock"]) ||
            view.schema !== VIEW_CONFIG.recipe.schema || view.run !== source.identity.run || view.run_instance_id !== source.identity.run_instance_id ||
            !contextCoverage(view.coverage, true) || typeof view.captured_at !== "string" || view.captured_at.length > 32 ||
            !Number.isFinite(Date.parse(view.captured_at)) || new Date(view.captured_at).toISOString() !== view.captured_at)
            return recipeReadUnavailable("view_invalid");
        const { schema: _schema, run: _run, run_instance_id: _generation, captured_at: _capturedAt, coverage: _coverage, ...fields } = view;
        if (!isDeepStrictEqual(fields, expected))
            return recipeReadUnavailable("view_mismatch");
        if (!metadataUnredacted({ captured_at: view.captured_at }))
            return recipeReadUnavailable("view_metadata_redacted");
        const result = Object.freeze({ state: "available", basis: "original_producer_projection_match",
            identity: source.identity, path: source.path, media_type: "application/json", bytes_total: source.bytes_total, mutable: true,
            view: freezeContextValue(view), unchanged: source.unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RUN_CONTEXT_RECIPE_MAX_BYTES)
            return recipeReadUnavailable("response_too_large");
        return source.unchanged() ? result : recipeReadUnavailable("observation_changed");
    }
    catch {
        return recipeReadUnavailable("view_invalid");
    }
}
function controlReadUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Recorded Control data only; neither current readiness/capacity nor authority to admit, dispatch or stop work. */
export function readRunControlContextView(stateDir, producer) {
    let original;
    try {
        original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    }
    catch {
        return controlReadUnavailable("admission_invalid");
    }
    if (!original)
        return controlReadUnavailable("admission_unavailable");
    if (typeof stateDir !== "string" || !isAbsolute(stateDir) || stateDir !== original.state_dir || original.run !== producer.run ||
        original.run_instance_id !== producer.runInstanceId || original.ownerId !== producer.ownerId)
        return controlReadUnavailable("identity_mismatch");
    const identity = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) };
    const metadataUnredacted = createContextIdentityPrivacyCheck(original);
    if (!metadataUnredacted(identity))
        return controlReadUnavailable("identity_redacted");
    const publication = controlPublications.get(producer);
    if (!publication)
        return controlReadUnavailable("publication_unavailable");
    if (publication.root !== stateDir)
        return controlReadUnavailable("identity_mismatch");
    const source = readSavedContextViewSource(stateDir, identity, "control");
    if (source.state !== "available")
        return controlReadUnavailable(source.reason === "role_unavailable" ? "control_unavailable" : source.reason);
    const unchanged = () => controlPublications.get(producer) === publication && source.unchanged();
    if (!unchanged())
        return controlReadUnavailable("observation_changed");
    if (source.text !== publication.content)
        return controlReadUnavailable("view_mismatch");
    try {
        const view = JSON.parse(source.text);
        if (!metadataUnredacted({ captured_at: view.captured_at }))
            return controlReadUnavailable("view_metadata_redacted");
        freezeContextValue(view);
        const result = Object.freeze({ state: "available", basis: "original_control_publication_match",
            identity: source.identity, path: source.path, media_type: "application/json", bytes_total: source.bytes_total, mutable: true, view, unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RUN_CONTEXT_CONTROL_MAX_BYTES)
            return controlReadUnavailable("response_too_large");
        return unchanged() ? result : controlReadUnavailable("observation_changed");
    }
    catch {
        return controlReadUnavailable("view_invalid");
    }
}
function executionReadUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Historical admitted metadata only: recorded references/exits/killed facts grant no body, lifecycle or native authority. */
export function readRunExecutionContextView(stateDir, producer) {
    let original;
    try {
        original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    }
    catch {
        return executionReadUnavailable("admission_invalid");
    }
    if (!original)
        return executionReadUnavailable("admission_unavailable");
    if (typeof stateDir !== "string" || !isAbsolute(stateDir) || stateDir !== original.state_dir || original.run !== producer.run ||
        original.run_instance_id !== producer.runInstanceId || original.ownerId !== producer.ownerId)
        return executionReadUnavailable("identity_mismatch");
    const identity = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) };
    const metadataUnredacted = createContextIdentityPrivacyCheck(original);
    if (!metadataUnredacted(identity))
        return executionReadUnavailable("identity_redacted");
    const publication = executionPublications.get(producer);
    if (!publication)
        return executionReadUnavailable("publication_unavailable");
    if (publication.root !== stateDir)
        return executionReadUnavailable("identity_mismatch");
    const source = readSavedContextViewSource(stateDir, identity, "execution");
    if (source.state !== "available")
        return executionReadUnavailable(source.reason === "role_unavailable" ? "execution_unavailable" : source.reason);
    const unchanged = () => executionPublications.get(producer) === publication && source.unchanged();
    if (!unchanged())
        return executionReadUnavailable("observation_changed");
    if (source.text !== publication.content)
        return executionReadUnavailable("view_mismatch");
    try {
        const view = JSON.parse(source.text);
        if (!metadataUnredacted({ captured_at: view.captured_at }))
            return executionReadUnavailable("view_metadata_redacted");
        freezeContextValue(view);
        const result = Object.freeze({ state: "available", basis: "original_execution_publication_match",
            identity: source.identity, path: source.path, media_type: "application/json", bytes_total: source.bytes_total, mutable: true, view, unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RUN_CONTEXT_EXECUTION_MAX_BYTES)
            return executionReadUnavailable("response_too_large");
        return unchanged() ? result : executionReadUnavailable("observation_changed");
    }
    catch {
        return executionReadUnavailable("view_invalid");
    }
}
function resultReadUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Original successful Result-view data only, never current outcome/source/body, active terminal or cleanup authority. */
export function readRunResultContextView(stateDir, producer) {
    let original;
    try {
        original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    }
    catch {
        return resultReadUnavailable("admission_invalid");
    }
    if (!original)
        return resultReadUnavailable("admission_unavailable");
    if (typeof stateDir !== "string" || !isAbsolute(stateDir) || stateDir !== original.state_dir || original.run !== producer.run ||
        original.run_instance_id !== producer.runInstanceId || original.ownerId !== producer.ownerId)
        return resultReadUnavailable("identity_mismatch");
    const identity = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) };
    const metadataUnredacted = createContextIdentityPrivacyCheck(original);
    if (!metadataUnredacted(identity))
        return resultReadUnavailable("identity_redacted");
    const publication = resultPublications.get(producer);
    if (!publication)
        return resultReadUnavailable("publication_unavailable");
    if (publication.root !== stateDir)
        return resultReadUnavailable("identity_mismatch");
    const source = readSavedContextViewSource(stateDir, identity, "result");
    if (source.state !== "available")
        return resultReadUnavailable(source.reason === "role_unavailable" ? "result_unavailable" : source.reason);
    const unchanged = () => resultPublications.get(producer) === publication && source.unchanged();
    if (!unchanged())
        return resultReadUnavailable("observation_changed");
    if (source.text !== publication.content)
        return resultReadUnavailable("view_mismatch");
    try {
        const view = JSON.parse(source.text);
        if (!metadataUnredacted({ captured_at: view.captured_at }))
            return resultReadUnavailable("view_metadata_redacted");
        freezeContextValue(view);
        const result = Object.freeze({ state: "available", basis: "original_result_publication_match",
            identity: source.identity, path: source.path, media_type: "application/json", bytes_total: source.bytes_total, mutable: true, view, unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RUN_CONTEXT_RESULT_MAX_BYTES)
            return resultReadUnavailable("response_too_large");
        return unchanged() ? result : resultReadUnavailable("observation_changed");
    }
    catch {
        return resultReadUnavailable("view_invalid");
    }
}
function traceReadUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Reads original successful publication data, never a live journal projection or a reconstructed binding. */
export function readRunTraceContextView(stateDir, producer) {
    let original;
    try {
        original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    }
    catch {
        return traceReadUnavailable("admission_invalid");
    }
    if (!original)
        return traceReadUnavailable("admission_unavailable");
    if (typeof stateDir !== "string" || !isAbsolute(stateDir) || stateDir !== original.state_dir || original.run !== producer.run ||
        original.run_instance_id !== producer.runInstanceId || original.ownerId !== producer.ownerId)
        return traceReadUnavailable("identity_mismatch");
    const identity = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) };
    const metadataUnredacted = createContextIdentityPrivacyCheck(original);
    if (!metadataUnredacted(identity))
        return traceReadUnavailable("identity_redacted");
    const publication = tracePublications.get(producer);
    if (!publication)
        return traceReadUnavailable("publication_unavailable");
    if (publication.root !== stateDir)
        return traceReadUnavailable("identity_mismatch");
    const source = readSavedContextViewSource(stateDir, identity, "trace");
    if (source.state !== "available")
        return traceReadUnavailable(source.reason === "role_unavailable" ? "trace_unavailable" : source.reason);
    const unchanged = () => tracePublications.get(producer) === publication && source.unchanged();
    if (!unchanged())
        return traceReadUnavailable("observation_changed");
    if (source.text !== publication.content)
        return traceReadUnavailable("view_mismatch");
    try {
        // Exact canonical JSONL binding precedes parse/freeze. A schema flag grants no authority.
        const [header, ...items] = source.text.trimEnd().split("\n").map(line => JSON.parse(line));
        if (!metadataUnredacted({ captured_at: header.captured_at }))
            return traceReadUnavailable("view_metadata_redacted");
        const view = freezeContextValue({ header, items });
        const result = Object.freeze({ state: "available", basis: "original_trace_publication_match",
            identity: source.identity, path: source.path, media_type: "application/x-ndjson", bytes_total: source.bytes_total, mutable: true, view, unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RUN_CONTEXT_TRACE_MAX_BYTES)
            return traceReadUnavailable("response_too_large");
        return unchanged() ? result : traceReadUnavailable("observation_changed");
    }
    catch {
        return traceReadUnavailable("view_invalid");
    }
}
function captureTrace(stateDir, producer) {
    const root = assertOwnedRunStateDirectory(stateDir, producer.run);
    const path = runTraceFile(root);
    const before = optionalStamp(path);
    if (!before)
        return traceUnavailable("trace_journal_absent");
    if (!before.isFile() || before.size > BigInt(TRACE_JOURNAL_MAX_BYTES))
        return traceUnavailable("trace_journal_unavailable");
    const metadata = readContextMetadata(root, producer);
    if (metadata.state === "unavailable")
        return traceUnavailable(metadata.reason === "changed" ? "trace_metadata_changed" : "trace_metadata_unavailable");
    const metadataUnchanged = captureContextMetadataFence(metadata, producer);
    if (!metadataUnchanged)
        return traceUnavailable("trace_metadata_changed");
    // Journal contents stay current; their Recipe privacy cannot be renewed from live metadata.
    const recipe = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    if (!recipe)
        return traceUnavailable("trace_admission_unavailable");
    const identityUnchanged = createContextIdentityPrivacyCheck(recipe);
    if (!identityUnchanged({ run: producer.run, run_instance_id: producer.runInstanceId }))
        return traceUnavailable("trace_identity_redacted");
    const journal = readRunTraceJournal(root);
    const after = optionalStamp(path);
    const metaAfter = optionalStamp(metadata.path);
    if (!after || !sameFile(before, after))
        return traceUnavailable("trace_journal_changed");
    if (!metaAfter || !sameFile(metadata.stamp, metaAfter) || !metadataUnchanged())
        return traceUnavailable("trace_metadata_changed");
    if (journal.diagnostics.length || journal.omittedPrefixBytes > 0)
        return traceUnavailable("trace_journal_invalid");
    // Source identity/time and routing tokens stay exact; omit unsafe whole items in the existing bounded source window.
    const items = projectRunTraceJournal(journal, { limit: DEFAULT_INSPECT_LINES, recipe, redactEvidence: createRunRecipeBodyRedactor(recipe) })
        .filter(item => identityUnchanged({ id: item.id, ts: item.ts, kind: item.kind }));
    const capturedAt = new Date().toISOString();
    if (!identityUnchanged({ captured_at: capturedAt }))
        return traceUnavailable("trace_metadata_redacted");
    const summary = summarizeRunTraceJournal(journal);
    const encode = () => [JSON.stringify({ schema: VIEW_CONFIG.trace.schema, run: producer.run,
            run_instance_id: producer.runInstanceId, captured_at: capturedAt, source_scope: "canonical_journal", order: "newest_first",
            coverage: TRACE_VIEW_COVERAGE, journal: summary, read_omitted_events: journal.omittedEvents,
            events_total: journal.events.length, events_shown: items.length, events_omitted: journal.events.length - items.length }),
        ...items.map(item => JSON.stringify(item))].join("\n") + "\n";
    let content = encode();
    while (items.length && Buffer.byteLength(content, "utf8") > RUN_CONTEXT_TRACE_MAX_BYTES) {
        items.pop();
        content = encode();
    }
    if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_TRACE_MAX_BYTES)
        return traceUnavailable("trace_journal_unavailable");
    const unchanged = () => {
        try {
            return metadataUnchanged() && sameFile(after, lstatSync(path, { bigint: true }));
        }
        catch {
            return false;
        }
    };
    if (!metadataUnchanged())
        return traceUnavailable("trace_metadata_changed");
    return unchanged() ? Object.freeze({ status: "captured", captured_at: capturedAt, content, unchanged, original_root: metadata.root }) : traceUnavailable("trace_journal_changed");
}
function captureResult(stateDir, producer) {
    const metadata = readContextMetadata(stateDir, producer);
    if (metadata.state === "unavailable")
        return resultUnavailable(metadata.reason === "changed" ? "result_changed" : "result_metadata_unavailable");
    const captured = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    if (!captured)
        return resultUnavailable("result_metadata_unavailable");
    const metadataUnredacted = createContextIdentityPrivacyCheck(captured);
    if (!metadataUnredacted({ run: producer.run, run_instance_id: producer.runInstanceId,
        ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) }))
        return resultUnavailable("result_identity_redacted");
    const path = join(metadata.root, "result.json");
    const before = optionalStamp(path);
    if (!before)
        return resultUnavailable("result_absent");
    if (!before.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
        return resultUnavailable("result_unavailable");
    const snapshot = readRunNaturalOutcomeSnapshot(metadata.root, metadata.meta, resultPath => {
        const read = readJsonFileResilient(resultPath, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES });
        return read.diagnostics.length ? undefined : read.value;
    });
    const after = optionalStamp(path);
    const metaAfter = optionalStamp(metadata.path);
    if (!after || !sameFile(before, after) || !metaAfter || !sameFile(metadata.stamp, metaAfter))
        return resultUnavailable("result_changed");
    if (!snapshot.result || (snapshot.outcome.state !== "accepted" && snapshot.outcome.state !== "captured"))
        return resultUnavailable("result_invalid");
    const result = snapshot.result;
    if (!metadataUnredacted({ recorded_at: result.completedAt }))
        return resultUnavailable("result_metadata_redacted");
    const projected = projectDiagnosticMetadata(producer, result, createRunRecipeTextRedactor(captured));
    if (projected.state === "unavailable")
        return resultUnavailable(projected.reason);
    const { details, sourceContent } = projected;
    const hasDetails = Object.keys(details).length > 0;
    const sourcePath = resultDiagnosticsPath(metadata.root, { run: producer.run, run_instance_id: producer.runInstanceId, ownerId: producer.ownerId });
    const source = hasDetails ? { path: sourcePath, run_instance_id: producer.runInstanceId,
        sha256: createHash("sha256").update(sourceContent).digest("hex") } : undefined;
    if (source && !metadataUnredacted(source))
        return resultUnavailable("result_metadata_redacted");
    const evidence = {};
    const fields = {};
    for (const [key, text] of Object.entries(details)) {
        const { text: preview, ...counts } = diagnosticExcerpt(text);
        evidence[key] = preview;
        fields[key] = counts;
    }
    const diagnostics = hasDetails ? { state: "available", source, bytes_total: Buffer.byteLength(sourceContent, "utf8"), fields }
        : { state: "not_recorded" };
    const flags = { ...(typeof result.killed === "boolean" ? { reported_killed: result.killed } : {}),
        ...(typeof result.truncated === "boolean" ? { reported_truncated: result.truncated } : {}) };
    const capturedAt = new Date().toISOString();
    if (!metadataUnredacted({ captured_at: capturedAt }))
        return resultUnavailable("result_metadata_redacted");
    const content = JSON.stringify({ schema: VIEW_CONFIG.result.schema, run: producer.run, run_instance_id: producer.runInstanceId,
        captured_at: capturedAt, coverage: RESULT_VIEW_COVERAGE, content_scope: "canonical_outcome_metadata", primary_text: "not_included", diagnostics,
        outcome: { acceptance: snapshot.outcome.state === "accepted" ? "natural" : "capture_only",
            ...(snapshot.outcome.state === "accepted" ? { terminal_status: snapshot.outcome.status } : {}),
            code: result.code, recorded_at: result.completedAt, ...evidence,
            ...(Object.keys(flags).length ? { producer_flags: flags } : {}) } }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_RESULT_MAX_BYTES)
        return resultUnavailable("result_view_too_large");
    const resultUnchanged = () => {
        try {
            return sameFile(after, lstatSync(path, { bigint: true })) &&
                sameFile(metadata.stamp, lstatSync(metadata.path, { bigint: true }));
        }
        catch {
            return false;
        }
    };
    if (!resultUnchanged())
        return resultUnavailable("result_changed");
    const retained = hasDetails ? retainContextSource(metadata, sourcePath, sourceContent, RUN_RESULT_DIAGNOSTICS_MAX_BYTES, "Run result diagnostics") : undefined;
    const unchanged = () => resultUnchanged() && (retained?.unchanged() ?? true);
    if (!unchanged())
        throw new ContextExportBindingRefusal("Run result diagnostics publication binding changed.");
    return Object.freeze({ status: "captured", captured_at: capturedAt, content, unchanged, original_root: metadata.root });
}
function projectDiagnosticMetadata(producer, result, redact) {
    const details = Object.fromEntries(RESULT_DIAGNOSTIC_FIELDS.flatMap(key => typeof result[key] === "string" ? [[key, redact(result[key])]] : []));
    if (Object.values(details).some(text => Buffer.from(text, "utf8").toString("utf8") !== text))
        return { state: "unavailable", reason: "result_diagnostics_invalid" };
    const sourceContent = JSON.stringify({ schema: RUN_RESULT_DIAGNOSTICS_PROTOCOL, run: producer.run, run_instance_id: producer.runInstanceId,
        content_scope: "canonical_outcome_diagnostic_strings", privacy_scope: "producer_admission", primary_text: "not_included",
        coverage: { truncated: false, redacted: true }, fields: details }, null, 2) + "\n";
    if (Buffer.byteLength(sourceContent, "utf8") > RUN_RESULT_DIAGNOSTICS_MAX_BYTES)
        return { state: "unavailable", reason: "result_diagnostics_too_large" };
    return { state: "available", details, sourceContent };
}
function diagnosticsUnavailable(reason) {
    return Object.freeze({ result_diagnostics: null, result_diagnostics_unavailable: reason });
}
/** Capture privacy before work. Source I/O occurs only in the genuine synchronous first-result callback, not initialization. */
export function createRunResultDiagnosticsPublisher(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, () => readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES));
    let redact;
    let metadataUnredacted;
    let identityUnchanged = false;
    let attempted = false;
    let failure;
    try {
        if (captured) {
            metadataUnredacted = createContextIdentityPrivacyCheck(captured);
            identityUnchanged = metadataUnredacted({ run: producer.run, run_instance_id: producer.runInstanceId,
                ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) });
            redact = createRunRecipeTextRedactor(captured);
        }
    }
    catch { /* No fixed privacy proof means explicit unavailable metadata. */ }
    return Object.freeze({
        publish: (admission) => {
            try {
                return withRunResultDiagnosticsAdmission(stateDir, producer, admission, (candidate) => {
                    if (attempted)
                        throw new ContextExportBindingRefusal("Run result diagnostics publication was already attempted.");
                    attempted = true;
                    if (!redact || !metadataUnredacted)
                        return diagnosticsUnavailable("privacy_capture_unavailable");
                    if (!identityUnchanged)
                        return diagnosticsUnavailable("identity_redacted");
                    try {
                        const projected = projectDiagnosticMetadata(producer, candidate, redact);
                        if (projected.state === "unavailable")
                            return diagnosticsUnavailable(projected.reason);
                        const fields = RESULT_DIAGNOSTIC_FIELDS.filter(field => Object.hasOwn(projected.details, field));
                        if (!fields.length)
                            return diagnosticsUnavailable("not_recorded");
                        const metadata = readContextMetadata(stateDir, producer);
                        if (metadata.state === "unavailable") {
                            if (metadata.reason === "changed" || metadata.reason === "invalid")
                                throw new ContextExportBindingRefusal("Run result diagnostics publication binding changed.");
                            return diagnosticsUnavailable("capture_unavailable");
                        }
                        const path = resultDiagnosticsPath(metadata.root, { run: producer.run, run_instance_id: producer.runInstanceId, ownerId: producer.ownerId });
                        const source = { path, run_instance_id: producer.runInstanceId, sha256: createHash("sha256").update(projected.sourceContent).digest("hex") };
                        if (!metadataUnredacted(source))
                            return diagnosticsUnavailable("source_reference_redacted");
                        const descriptor = { result_diagnostics: { source, bytes_total: Buffer.byteLength(projected.sourceContent, "utf8"), fields } };
                        if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > RUN_DELIVERY_MODEL_MAX_BYTES)
                            return diagnosticsUnavailable("descriptor_too_large");
                        let binding;
                        try {
                            binding = decodeRunResultDiagnosticsBinding(metadata.root, producer.runInstanceId, descriptor);
                        }
                        catch (error) {
                            throw new ContextExportBindingRefusal("Run result diagnostics descriptor binding is invalid.", { cause: error });
                        }
                        const retained = retainContextSource(metadata, path, projected.sourceContent, RUN_RESULT_DIAGNOSTICS_MAX_BYTES, "Run result diagnostics");
                        if (!retained.unchanged())
                            throw new ContextExportBindingRefusal("Run result diagnostics publication binding changed.");
                        return binding;
                    }
                    catch (error) {
                        if (error instanceof ContextExportBindingRefusal || error instanceof PrimaryTextBindingRefusal)
                            throw error;
                        failure = error;
                        return diagnosticsUnavailable("publication_failed");
                    }
                });
            }
            catch (error) {
                if (failure !== undefined && error !== failure)
                    throw new AggregateError([failure, error], "Run result diagnostics authority changed after publication failure.");
                throw error;
            }
        },
        readFailure: () => failure,
    });
}
function diagnosticsReadUnavailable(reason) {
    return Object.freeze({ state: "unavailable", reason });
}
function resultDiagnosticsPath(root, identity) {
    const key = createHash("sha256").update(JSON.stringify([identity.run, identity.run_instance_id, identity.ownerId ?? null])).digest("hex");
    return join(root, "evidence", `result-diagnostics-${key}.json`);
}
function diagnosticExcerpt(text, range, maxChars = RESULT_DIAGNOSTIC_PREVIEW_CHARS) {
    const bytes = Buffer.from(text, "utf8");
    const preview = range ? bytes.subarray(range.start, range.end).toString("utf8")
        : Array.from(text).slice(0, maxChars).join("");
    const total = primaryChars(text);
    const shown = primaryChars(preview);
    return Object.freeze({ text: preview, bytes_total: bytes.length,
        shown_bytes: Object.freeze(range ? { start: range.start, end: range.end } : { start: 0, end: Buffer.byteLength(preview, "utf8") }),
        chars_total: total, chars_shown: shown, chars_omitted: total - shown, truncated: shown < total });
}
/** Closed saved projection data only; caller owns source/hash/identity admission and exposure policy. */
function diagnosticSourceFields(text, identity) {
    const saved = record(JSON.parse(text));
    const fields = record(saved?.fields);
    if (!saved || !contextFields(saved, ["schema", "run", "run_instance_id", "content_scope", "privacy_scope", "primary_text", "coverage", "fields"]) ||
        saved.schema !== RUN_RESULT_DIAGNOSTICS_PROTOCOL || saved.run !== identity.run || saved.run_instance_id !== identity.run_instance_id ||
        saved.content_scope !== "canonical_outcome_diagnostic_strings" || saved.privacy_scope !== "producer_admission" || saved.primary_text !== "not_included" ||
        !contextCoverage(saved.coverage, false) || !fields || !Object.keys(fields).length || !contextFields(fields, RESULT_DIAGNOSTIC_FIELDS) ||
        Object.values(fields).some(value => typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value))
        return undefined;
    return Object.freeze(fields);
}
/** Eligible completion only: exact natural first-result metadata binding, never a view/index or raw-output fallback. */
export function readRunResultDiagnosticOutcome(stateDir, expected, status) {
    const unavailable = (reason, saved) => Object.freeze({ state: "unavailable", reason,
        ...(saved === undefined ? {} : { result_diagnostics_unavailable: saved }) });
    if (status !== "done" && status !== "failed")
        return unavailable("outcome_mismatch");
    const request = contextReadIdentity(expected);
    if (!request)
        return unavailable("selection_invalid");
    const owner = readRunContextIdentity(stateDir, request);
    if (owner.state !== "available")
        return unavailable(owner.reason);
    let reason = "result_unavailable";
    try {
        const root = owner.local_path;
        const metadata = contextJson(join(root, "run.json"));
        const meta = metadata.value;
        if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL || !Number.isSafeInteger(meta.pid) || Number(meta.pid) <= 0)
            return unavailable("publication_unavailable");
        const resultPath = join(root, "result.json");
        const canonical = contextJson(resultPath);
        const snapshot = readRunNaturalOutcomeSnapshot(root, meta, () => canonical.value);
        const frameUnchanged = () => {
            try {
                return owner.unchanged() && sameFile(metadata.stamp, lstatSync(join(root, "run.json"), { bigint: true })) &&
                    sameFile(canonical.stamp, lstatSync(resultPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!frameUnchanged())
            return unavailable("observation_changed");
        if (snapshot.outcome.state === "captured")
            return unavailable("nonterminal_capture");
        if (!snapshot.result || snapshot.outcome.state !== "accepted")
            return unavailable("result_unavailable");
        if (snapshot.outcome.status !== status)
            return unavailable("outcome_mismatch");
        if (snapshot.result.result_diagnostics_protocol !== RUN_RESULT_DIAGNOSTICS_PROTOCOL)
            return unavailable("publication_unavailable");
        reason = "binding_invalid";
        const binding = decodeRunResultDiagnosticsBinding(root, owner.identity.run_instance_id, snapshot.result);
        const reference = binding.result_diagnostics;
        if (!reference)
            return frameUnchanged() ? unavailable("diagnostics_unavailable", binding.result_diagnostics_unavailable) : unavailable("observation_changed");
        if (reference.source.path !== resultDiagnosticsPath(root, owner.identity) || reference.bytes_total > RUN_RESULT_DIAGNOSTICS_MAX_BYTES)
            return unavailable("binding_invalid");
        reason = "source_unavailable";
        const evidencePath = join(root, "evidence");
        const evidence = lstatSync(evidencePath, { bigint: true });
        if (!evidence.isDirectory() || evidence.isSymbolicLink())
            return unavailable("source_unavailable");
        const retained = readFixedSourceText(reference.source.path, RUN_RESULT_DIAGNOSTICS_MAX_BYTES, "Run result diagnostics source");
        reason = "source_invalid";
        if (Number(retained.stamp.size) !== reference.bytes_total || createHash("sha256").update(retained.text).digest("hex") !== reference.source.sha256)
            return unavailable("source_invalid");
        const fields = diagnosticSourceFields(retained.text, owner.identity);
        if (!fields || JSON.stringify(RESULT_DIAGNOSTIC_FIELDS.filter(key => Object.hasOwn(fields, key))) !== JSON.stringify(reference.fields))
            return unavailable("source_invalid");
        const field = ["error", "failure_reason", "command"].find(key => Object.hasOwn(fields, key));
        const excerpt = decodeRunResultDiagnosticExcerpt(reference, { field, ...diagnosticExcerpt(fields[field], undefined, RUN_RESULT_DIAGNOSTIC_EXCERPT_CHARS) });
        const unchanged = () => {
            try {
                return frameUnchanged() && sameObject(evidence, lstatSync(evidencePath, { bigint: true })) &&
                    sameFile(retained.stamp, lstatSync(reference.source.path, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        return unchanged() ? Object.freeze({ state: "available", identity: owner.identity, binding, excerpt, terminal_status: snapshot.outcome.status, unchanged }) : unavailable("observation_changed");
    }
    catch {
        return unavailable(reason);
    }
}
function diagnosticOutcome(value) {
    const outcome = record(value);
    if (!outcome || !contextFields(outcome, ["acceptance", "terminal_status", "code", "recorded_at", "producer_flags", ...RESULT_DIAGNOSTIC_FIELDS]) ||
        typeof outcome.code !== "number" || !Number.isSafeInteger(outcome.code) || typeof outcome.recorded_at !== "string" ||
        !Number.isFinite(Date.parse(outcome.recorded_at)) || new Date(outcome.recorded_at).toISOString() !== outcome.recorded_at ||
        (outcome.acceptance !== "natural" && outcome.acceptance !== "capture_only") ||
        (outcome.acceptance === "natural" ? outcome.terminal_status !== (outcome.code === 0 ? "done" : "failed") : Object.hasOwn(outcome, "terminal_status")))
        return undefined;
    if (outcome.producer_flags !== undefined) {
        const flags = record(outcome.producer_flags);
        if (!flags || !Object.keys(flags).length || !contextFields(flags, ["reported_killed", "reported_truncated"]) ||
            Object.values(flags).some(flag => typeof flag !== "boolean"))
            return undefined;
    }
    if (RESULT_DIAGNOSTIC_FIELDS.some(field => Object.hasOwn(outcome, field) && typeof outcome[field] !== "string"))
        return undefined;
    return outcome;
}
/** Fixed saved diagnostic metadata only. The query selects one field and optional decoded-field UTF-8 byte range. */
export function readRunResultDiagnosticsSource(stateDir, expected, query) {
    const request = contextReadIdentity(expected);
    const selection = contextReadRequest(query);
    if (!request || !selection || !contextFields(selection, ["field", "start", "end"]) ||
        !RESULT_DIAGNOSTIC_FIELDS.includes(selection.field))
        return diagnosticsReadUnavailable("selection_invalid");
    const field = selection.field;
    let range;
    if (Object.hasOwn(selection, "start") || Object.hasOwn(selection, "end")) {
        if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || Number(selection.start) < 0 ||
            Number(selection.end) < Number(selection.start))
            return diagnosticsReadUnavailable("selection_invalid");
        range = { start: Number(selection.start), end: Number(selection.end) };
        if (range.end - range.start > RUN_CONTEXT_RESULT_MAX_BYTES)
            return diagnosticsReadUnavailable("range_too_large");
    }
    const owner = readRunContextIdentity(stateDir, request);
    if (owner.state !== "available")
        return diagnosticsReadUnavailable(owner.reason);
    let reason = "index_unavailable";
    try {
        const root = owner.local_path;
        const indexPath = join(root, RUN_CONTEXT_INDEX_FILE);
        const index = optionalStamp(indexPath);
        if (!index?.isFile())
            return diagnosticsReadUnavailable("index_unavailable");
        const admitted = readRunContextIndex(root, owner.identity);
        if (admitted.state !== "available")
            return diagnosticsReadUnavailable(admitted.reason === "observation_changed" ? "observation_changed" : "index_unavailable");
        const entry = admitted.index.entries.result;
        if (entry.availability !== "available" || entry.mutable !== true || !contextCoverage(entry.coverage, true))
            return diagnosticsReadUnavailable("publication_unavailable");
        reason = "view_unavailable";
        const evidencePath = join(root, "evidence");
        const evidence = lstatSync(evidencePath, { bigint: true });
        if (!evidence.isDirectory() || evidence.isSymbolicLink())
            return diagnosticsReadUnavailable("view_unavailable");
        const viewPath = join(root, runContextExportPath("result"));
        const captured = readFixedSourceText(viewPath, RUN_CONTEXT_RESULT_MAX_BYTES, "Run result diagnostics view");
        const frameUnchanged = () => {
            try {
                return owner.unchanged() && sameFile(index, lstatSync(indexPath, { bigint: true })) &&
                    sameObject(evidence, lstatSync(evidencePath, { bigint: true })) && sameFile(captured.stamp, lstatSync(viewPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!frameUnchanged())
            return diagnosticsReadUnavailable("observation_changed");
        reason = "view_invalid";
        const view = record(JSON.parse(captured.text));
        if (!view || !contextFields(view, ["schema", "run", "run_instance_id", "captured_at", "coverage", "content_scope", "primary_text", "diagnostics", "outcome"]) ||
            view.schema !== VIEW_CONFIG.result.schema || view.run !== owner.identity.run || view.run_instance_id !== owner.identity.run_instance_id ||
            view.content_scope !== "canonical_outcome_metadata" || view.primary_text !== "not_included" || !contextCoverage(view.coverage, true) ||
            Number(captured.stamp.size) !== entry.bytes_total || typeof view.captured_at !== "string" || !Number.isFinite(Date.parse(view.captured_at)) ||
            new Date(view.captured_at).toISOString() !== view.captured_at)
            return diagnosticsReadUnavailable("view_invalid");
        const outcome = diagnosticOutcome(view.outcome);
        if (!outcome)
            return diagnosticsReadUnavailable("view_invalid");
        if (!Object.hasOwn(view, "diagnostics"))
            return diagnosticsReadUnavailable("publication_unavailable");
        const descriptor = record(view.diagnostics);
        if (!descriptor)
            return diagnosticsReadUnavailable("view_invalid");
        if (descriptor.state === "not_recorded")
            return contextFields(descriptor, ["state"]) &&
                RESULT_DIAGNOSTIC_FIELDS.every(key => !Object.hasOwn(outcome, key)) ? diagnosticsReadUnavailable("diagnostics_unavailable") : diagnosticsReadUnavailable("view_invalid");
        const source = record(descriptor.source);
        const previews = record(descriptor.fields);
        if (!contextFields(descriptor, ["state", "source", "bytes_total", "fields"]) || descriptor.state !== "available" || !source ||
            !contextFields(source, ["path", "run_instance_id", "sha256"]) || source.path !== resultDiagnosticsPath(root, owner.identity) ||
            source.run_instance_id !== owner.identity.run_instance_id || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.sha256) ||
            typeof descriptor.bytes_total !== "number" || !Number.isSafeInteger(descriptor.bytes_total) || descriptor.bytes_total <= 0 || descriptor.bytes_total > RUN_RESULT_DIAGNOSTICS_MAX_BYTES ||
            !previews || !Object.keys(previews).length || !contextFields(previews, RESULT_DIAGNOSTIC_FIELDS))
            return diagnosticsReadUnavailable("view_invalid");
        reason = "source_unavailable";
        const retained = readFixedSourceText(source.path, RUN_RESULT_DIAGNOSTICS_MAX_BYTES, "Run result diagnostics source");
        reason = "source_invalid";
        if (Number(retained.stamp.size) !== descriptor.bytes_total || createHash("sha256").update(retained.text).digest("hex") !== source.sha256)
            return diagnosticsReadUnavailable("source_invalid");
        const fields = diagnosticSourceFields(retained.text, owner.identity);
        if (!fields)
            return diagnosticsReadUnavailable("source_invalid");
        const excerpts = new Map();
        for (const key of RESULT_DIAGNOSTIC_FIELDS) {
            if (!Object.hasOwn(fields, key)) {
                if (Object.hasOwn(previews, key) || Object.hasOwn(outcome, key))
                    return diagnosticsReadUnavailable("source_invalid");
                continue;
            }
            const text = fields[key];
            if (typeof text !== "string" || Buffer.from(text, "utf8").toString("utf8") !== text)
                return diagnosticsReadUnavailable("source_invalid");
            const excerpt = diagnosticExcerpt(text);
            const { text: preview, ...counts } = excerpt;
            const recorded = record(previews[key]);
            const recordedRange = record(recorded?.shown_bytes);
            const { shown_bytes: bytes, ...scalarCounts } = counts;
            if (!recorded || !contextFields(recorded, Object.keys(counts)) || !recordedRange || !contextFields(recordedRange, ["start", "end"]) ||
                recordedRange.start !== bytes.start || recordedRange.end !== bytes.end || Object.entries(scalarCounts).some(([name, value]) => recorded[name] !== value) ||
                outcome[key] !== preview)
                return diagnosticsReadUnavailable("source_invalid");
            excerpts.set(key, excerpt);
        }
        const unchanged = () => { try {
            return frameUnchanged() && sameFile(retained.stamp, lstatSync(source.path, { bigint: true }));
        }
        catch {
            return false;
        } };
        if (!unchanged())
            return diagnosticsReadUnavailable("observation_changed");
        let output = excerpts.get(field);
        if (!output)
            return diagnosticsReadUnavailable("field_unavailable");
        if (range) {
            const bytes = Buffer.from(fields[field], "utf8");
            if (range.end > bytes.length || !primaryBoundary(bytes, range.start) || !primaryBoundary(bytes, range.end))
                return diagnosticsReadUnavailable("range_invalid");
            output = diagnosticExcerpt(fields[field], range);
        }
        const reading = Object.freeze({ state: "available", identity: owner.identity,
            recorded_acceptance: outcome.acceptance, field, content_scope: "canonical_outcome_diagnostic_strings", privacy_scope: "producer_admission",
            primary_text: "not_included", redacted: true, selection: range ? "byte_range" : "recorded_preview",
            diagnostics: Object.freeze({ source: Object.freeze({ path: source.path, run_instance_id: source.run_instance_id, sha256: source.sha256 }), bytes_total: descriptor.bytes_total }),
            output, unchanged });
        if (Buffer.byteLength(JSON.stringify(reading)) > RUN_CONTEXT_RESULT_MAX_BYTES)
            return diagnosticsReadUnavailable("range_too_large");
        return unchanged() ? reading : diagnosticsReadUnavailable("observation_changed");
    }
    catch {
        return diagnosticsReadUnavailable(reason);
    }
}
// Cwd anchoring can amplify bounded input metadata; refuse before constructing/projecting that expansion.
function artifactReferenceBudget(artifacts, cwd) {
    const declarations = record(artifacts);
    if (!declarations)
        return true; // Validation still belongs to the reference owner.
    const baseBytes = typeof cwd === "string" ? Buffer.byteLength(cwd) + (cwd.endsWith(sep) ? 0 : Buffer.byteLength(sep)) : 0;
    let bytes = 0;
    for (const value of Object.values(declarations)) {
        const path = typeof value === "string" ? value : record(value)?.path;
        if (typeof path !== "string")
            continue;
        bytes += Buffer.byteLength(path) + (isAbsolute(path) ? 0 : baseBytes);
        if (bytes > RUN_ARTIFACT_INVENTORY_MAX_BYTES)
            return false;
    }
    return true;
}
function captureArtifacts(stateDir, producer) {
    const metadata = readContextMetadata(stateDir, producer);
    if (metadata.state === "unavailable")
        return artifactUnavailable(metadata.reason === "changed" ? "artifact_metadata_changed" : "artifact_metadata_unavailable");
    if (!artifactReferenceBudget(metadata.meta.artifacts, metadata.meta.cwd))
        return artifactUnavailable("artifact_manifest_too_large");
    const described = describeRunArtifactReferences(metadata.meta.artifacts, metadata.meta.cwd);
    if (described.state === "unavailable")
        return artifactUnavailable(described.reason);
    if (!described.references.length)
        return artifactUnavailable("artifact_declarations_absent");
    const original = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    if (!original)
        return artifactUnavailable("artifact_admission_unavailable");
    if (!createContextIdentityPrivacyCheck(original)({ run: producer.run, run_instance_id: producer.runInstanceId,
        ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) }))
        return artifactUnavailable("artifact_identity_redacted");
    const redact = (value) => redactSessionEvidenceValue(value, Number.MAX_SAFE_INTEGER);
    // Declared output paths are operational references: never turn a redacted path into a promised readable file.
    const prepared = described.references.map(reference => ({ name: redact(reference.name),
        path: redact(reference.path) === reference.path ? reference.path : null,
        ...(reference.kind !== undefined ? { kind: redact(reference.kind) } : {}),
        ...(reference.media_type !== undefined ? { media_type: redact(reference.media_type) } : {}),
        ...(reference.required !== undefined ? { required: reference.required } : {}) }));
    if (Buffer.byteLength(JSON.stringify(prepared), "utf8") > RUN_CONTEXT_ARTIFACT_MAX_BYTES)
        return artifactUnavailable("artifact_manifest_too_large");
    const artifacts = prepared.map((entry, index) => {
        if (entry.path === null)
            return { ...entry, availability: "unavailable", reason: "artifact_reference_redacted", mutable: true };
        const observed = observeRunArtifactReference(described.references[index]);
        return { ...entry, availability: observed.availability, mutable: true,
            ...(observed.bytes_total !== undefined ? { bytes_total: observed.bytes_total } : {}),
            ...(observed.reason ? { reason: observed.reason } : {}) };
    });
    const after = optionalStamp(metadata.path);
    if (!after || !sameFile(metadata.stamp, after))
        return artifactUnavailable("artifact_metadata_changed");
    const summary = { declared: artifacts.length, available: 0, missing: 0, unavailable: 0 };
    for (const artifact of artifacts)
        summary[artifact.availability] += 1;
    const capturedAt = new Date().toISOString();
    const content = JSON.stringify({ schema: VIEW_CONFIG.artifacts.schema, run: producer.run, run_instance_id: producer.runInstanceId,
        captured_at: capturedAt, content_scope: "captured_artifact_references", contents: "not_read", production_provenance: "not_asserted",
        coverage: ARTIFACT_VIEW_COVERAGE, summary, artifacts }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_ARTIFACT_MAX_BYTES)
        return artifactUnavailable("artifact_manifest_too_large");
    return Object.freeze({ status: "captured", captured_at: capturedAt, content });
}
function artifactInventoryPath(root, identity) {
    const key = createHash("sha256").update(JSON.stringify([identity.run, identity.run_instance_id, identity.ownerId ?? null])).digest("hex");
    return join(root, "evidence", `artifact-inventory-${key}.json`);
}
/** Overflow source permission is fixed at genuine producer admission, not refreshed from live declarations. */
function retainArtifactInventoryView(stateDir, producer) {
    return withRunProducerEvidence(stateDir, producer, () => {
        const captured = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
        if (!captured || !createContextIdentityPrivacyCheck(captured)({ run: producer.run, run_instance_id: producer.runInstanceId,
            ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) }))
            return undefined;
        const metadata = readContextMetadata(stateDir, producer);
        if (metadata.state !== "available" ||
            JSON.stringify([captured.artifacts, captured.cwd]) !== JSON.stringify([metadata.meta.artifacts, metadata.meta.cwd]))
            return undefined;
        if (!artifactReferenceBudget(captured.artifacts, captured.cwd))
            return undefined;
        const described = describeRunArtifactReferences(captured.artifacts, captured.cwd);
        if (described.state !== "available" || !described.references.length)
            return undefined;
        const mask = capturedSecretMask(captured), withoutSecrets = capturedSecretMask(captured, "");
        // Operational output references may be beneath Recipe origins; share secret masking, not origin stripping.
        const redact = (text) => mask(redactSessionEvidenceValue(text, Number.MAX_SAFE_INTEGER));
        const artifacts = described.references.map(reference => {
            const withheld = withoutSecrets(reference.path) !== reference.path || redact(reference.path) !== reference.path;
            return { name: redact(reference.name), path: withheld ? null : reference.path,
                ...(reference.kind !== undefined ? { kind: redact(reference.kind) } : {}),
                ...(reference.media_type !== undefined ? { media_type: redact(reference.media_type) } : {}),
                ...(reference.required !== undefined ? { required: reference.required } : {}),
                availability: "not_observed", ...(withheld ? { reason: "artifact_reference_redacted" } : {}) };
        });
        const coverage = Object.freeze({ truncated: false, redacted: true });
        const summary = { declared: artifacts.length, references_disclosed: artifacts.filter(item => item.path !== null).length,
            references_withheld: artifacts.filter(item => item.path === null).length };
        const common = { run: producer.run, run_instance_id: producer.runInstanceId,
            capture_scope: "producer_admission", contents: "not_read", availability: "not_observed", production_provenance: "not_asserted" };
        const content = JSON.stringify({ schema: "run-artifact-inventory-v1", ...common,
            content_scope: "captured_artifact_declarations", inventory_complete: true, coverage, summary, artifacts }, null, 2) + "\n";
        const bytes = Buffer.byteLength(content);
        if (bytes > RUN_ARTIFACT_INVENTORY_MAX_BYTES)
            return undefined;
        const path = artifactInventoryPath(metadata.root, { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) });
        const inventory = { source: { path, run_instance_id: producer.runInstanceId, sha256: createHash("sha256").update(content).digest("hex") },
            bytes_total: bytes, declarations_total: artifacts.length };
        const capturedAt = new Date().toISOString();
        const viewCoverage = Object.freeze({ truncated: true, redacted: true });
        const view = JSON.stringify({ schema: VIEW_CONFIG.artifacts.schema, ...common, captured_at: capturedAt,
            content_scope: "captured_artifact_inventory_reference", coverage: viewCoverage, summary,
            artifacts: [], artifacts_shown: 0, artifacts_omitted: artifacts.length, inventory }, null, 2) + "\n";
        if (Buffer.byteLength(view) > RUN_CONTEXT_ARTIFACT_MAX_BYTES)
            return undefined;
        const retained = retainContextSource(metadata, path, content, RUN_ARTIFACT_INVENTORY_MAX_BYTES, "Run artifact inventory");
        return Object.freeze({ status: "captured", captured_at: capturedAt, content: view, coverage: viewCoverage, unchanged: retained.unchanged });
    });
}
/** Kernel preparation, before work/result publication. This projects declarations only, never artifact targets. */
export function prepareRunArtifactInventoryPublication(stateDir, producer) {
    const metadata = withRunProducerEvidence(stateDir, producer, () => readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES));
    let binding = Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: "not_declared" });
    let unchanged;
    let failure;
    if (!metadata)
        binding = Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: "privacy_capture_unavailable" });
    else if (metadata.artifacts !== undefined && (!record(metadata.artifacts) || Object.keys(metadata.artifacts).length > 0)) {
        if (!createContextIdentityPrivacyCheck(metadata)({ run: producer.run, run_instance_id: producer.runInstanceId,
            ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) }))
            return Object.freeze({
                snapshot: () => Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: "identity_redacted" }), readFailure: () => undefined
            });
        try {
            const captured = retainArtifactInventoryView(stateDir, producer);
            if (!captured)
                binding = Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: "capture_unavailable" });
            else {
                const view = publishContextView(stateDir, producer, "artifacts", captured);
                publishContextIndex(stateDir, producer, "artifacts", view);
                const reading = readRunArtifactInventorySource(stateDir, { run: producer.run, run_instance_id: producer.runInstanceId,
                    ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) }, { start: 0, end: 0 });
                binding = decodeRunArtifactInventoryBinding(stateDir, producer.runInstanceId, reading.state === "available"
                    ? { artifact_inventory: reading.inventory } : { artifact_inventory: null, artifact_inventory_unavailable: reading.reason });
                if (reading.state === "available")
                    unchanged = reading.unchanged;
            }
        }
        catch (error) {
            if (error instanceof ContextExportBindingRefusal || error instanceof PrimaryTextBindingRefusal)
                throw error;
            // Ordinary evidence I/O may be unavailable, but loss of genuine producer authority must still fail closed.
            try {
                withRunProducerEvidence(stateDir, producer, () => { });
            }
            catch (authorityError) {
                throw new AggregateError([error, authorityError], "Run artifact inventory authority changed after publication failure.");
            }
            failure = error;
            binding = Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: "publication_failed" });
        }
    }
    return Object.freeze({ snapshot: () => binding.artifact_inventory && !unchanged?.()
            ? Object.freeze({ artifact_inventory: null, artifact_inventory_unavailable: "observation_changed" }) : binding,
        readFailure: () => failure });
}
/** Exact natural first-result binding plus retained-source admission; call only for eligible packet members, never ambient checks. */
export function readRunResultArtifactInventory(stateDir, expected) {
    const unavailable = (reason, saved) => Object.freeze({ state: "unavailable", reason,
        ...(saved === undefined ? {} : { artifact_inventory_unavailable: saved }) });
    const request = contextReadIdentity(expected);
    if (!request)
        return unavailable("selection_invalid");
    const owner = readRunContextIdentity(stateDir, request);
    if (owner.state !== "available")
        return unavailable(owner.reason);
    let reason = "result_unavailable";
    try {
        const root = owner.local_path;
        const metadata = contextJson(join(root, "run.json"));
        const meta = metadata.value;
        if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL || !Number.isSafeInteger(meta.pid) || Number(meta.pid) <= 0)
            return unavailable("publication_unavailable");
        const resultPath = join(root, "result.json");
        const canonical = contextJson(resultPath);
        const snapshot = readRunNaturalOutcomeSnapshot(root, meta, () => canonical.value);
        const frameUnchanged = () => {
            try {
                return owner.unchanged() && sameFile(metadata.stamp, lstatSync(join(root, "run.json"), { bigint: true })) && sameFile(canonical.stamp, lstatSync(resultPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!frameUnchanged())
            return unavailable("observation_changed");
        if (snapshot.outcome.state === "captured")
            return unavailable("nonterminal_capture");
        if (!snapshot.result || snapshot.outcome.state !== "accepted")
            return unavailable("result_unavailable");
        if (snapshot.result.artifact_inventory_protocol !== RUN_ARTIFACT_INVENTORY_PROTOCOL)
            return unavailable("publication_unavailable");
        reason = "binding_invalid";
        const binding = decodeRunArtifactInventoryBinding(root, owner.identity.run_instance_id, snapshot.result);
        if (!binding.artifact_inventory)
            return frameUnchanged() ? unavailable("inventory_unavailable", binding.artifact_inventory_unavailable) : unavailable("observation_changed");
        if (binding.artifact_inventory.source.path !== artifactInventoryPath(root, owner.identity))
            return unavailable("binding_invalid");
        reason = "source_unavailable";
        const reading = readRunArtifactInventorySource(root, owner.identity, { start: 0, end: 0 });
        if (reading.state !== "available")
            return unavailable(reading.reason);
        const expectedSource = binding.artifact_inventory;
        const actual = reading.inventory;
        if (expectedSource.source.path !== actual.source.path || expectedSource.source.run_instance_id !== actual.source.run_instance_id ||
            expectedSource.source.sha256 !== actual.source.sha256 || expectedSource.bytes_total !== actual.bytes_total || expectedSource.declarations_total !== actual.declarations_total)
            return unavailable("binding_invalid");
        const unchanged = () => frameUnchanged() && reading.unchanged();
        return unchanged() ? Object.freeze({ state: "available", identity: owner.identity, binding, terminal_status: snapshot.outcome.status, unchanged }) : unavailable("observation_changed");
    }
    catch {
        return unavailable(reason);
    }
}
function artifactReadUnavailable(reason) {
    return Object.freeze({ state: "unavailable", reason });
}
function contextFields(value, fields) {
    return Object.keys(value).every(key => fields.includes(key));
}
function artifactSummary(value, total) {
    const source = record(value);
    if (!source || !contextFields(source, ["declared", "references_disclosed", "references_withheld"]) || source.declared !== total ||
        typeof source.references_disclosed !== "number" || !Number.isSafeInteger(source.references_disclosed) || source.references_disclosed < 0 ||
        typeof source.references_withheld !== "number" || !Number.isSafeInteger(source.references_withheld) || source.references_withheld < 0 ||
        source.references_disclosed + source.references_withheld !== total)
        return undefined;
    return Object.freeze({ declared: total, references_disclosed: source.references_disclosed, references_withheld: source.references_withheld });
}
function artifactDeclaration(value) {
    const source = record(value);
    if (!source || !contextFields(source, ["name", "path", "kind", "media_type", "required", "availability", "reason"]) ||
        typeof source.name !== "string" || !source.name.trim() || /[\u0000-\u001f\u007f]/u.test(source.name) || source.availability !== "not_observed" ||
        (source.kind !== undefined && typeof source.kind !== "string") || (source.media_type !== undefined && typeof source.media_type !== "string") ||
        (source.required !== undefined && typeof source.required !== "boolean"))
        return undefined;
    if (source.path === null ? source.reason !== "artifact_reference_redacted" : typeof source.path !== "string" || !isAbsolute(source.path) ||
        /[\u0000-\u001f\u007f]/u.test(source.path) || source.reason !== undefined)
        return undefined;
    return Object.freeze({ name: source.name, path: source.path, availability: "not_observed",
        ...(source.kind === undefined ? {} : { kind: source.kind }), ...(source.media_type === undefined ? {} : { media_type: source.media_type }),
        ...(source.required === undefined ? {} : { required: source.required }), ...(source.path === null ? { reason: "artifact_reference_redacted" } : {}) });
}
function artifactHeader(value, identity) {
    return value.run === identity.run && value.run_instance_id === identity.run_instance_id && value.capture_scope === "producer_admission" &&
        value.contents === "not_read" && value.availability === "not_observed" && value.production_provenance === "not_asserted";
}
function contextCoverage(value, truncated) {
    const coverage = record(value);
    return !!coverage && contextFields(coverage, ["truncated", "redacted"]) && coverage.truncated === truncated && coverage.redacted === true;
}
/** Fixed retained-projection policy, not permission inferred from a path/flag. Query is a half-open declaration range, not bytes. */
export function readRunArtifactInventorySource(stateDir, expected, query) {
    const request = contextReadIdentity(expected);
    if (!request)
        return artifactReadUnavailable("selection_invalid");
    let range;
    if (query !== undefined) {
        const value = contextReadRequest(query);
        if (!value || !contextFields(value, ["start", "end"]) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) ||
            Number(value.start) < 0 || Number(value.end) < Number(value.start))
            return artifactReadUnavailable("selection_invalid");
        range = { start: Number(value.start), end: Number(value.end) };
        if (range.end - range.start > RUN_CONTEXT_ARTIFACT_MAX_BYTES)
            return artifactReadUnavailable("range_too_large");
    }
    const owner = readRunContextIdentity(stateDir, request);
    if (owner.state !== "available")
        return artifactReadUnavailable(owner.reason);
    let reason = "index_unavailable";
    try {
        const root = owner.local_path;
        const indexPath = join(root, RUN_CONTEXT_INDEX_FILE);
        const index = optionalStamp(indexPath);
        if (!index?.isFile())
            return artifactReadUnavailable("index_unavailable");
        const admitted = readRunContextIndex(root, owner.identity);
        if (admitted.state !== "available")
            return artifactReadUnavailable(admitted.reason === "observation_changed" ? "observation_changed" : "index_unavailable");
        const entry = admitted.index.entries.artifacts;
        if (entry.availability !== "available" || entry.mutable !== true || !contextCoverage(entry.coverage, true))
            return artifactReadUnavailable("publication_unavailable");
        const evidencePath = join(root, "evidence");
        const evidence = lstatSync(evidencePath, { bigint: true });
        if (!evidence.isDirectory() || evidence.isSymbolicLink())
            return artifactReadUnavailable("view_unavailable");
        reason = "view_unavailable";
        const viewPath = join(root, runContextExportPath("artifacts"));
        const captured = readFixedSourceText(viewPath, RUN_CONTEXT_ARTIFACT_MAX_BYTES, "Run artifact inventory view");
        const frameUnchanged = () => {
            try {
                return owner.unchanged() && sameFile(index, lstatSync(indexPath, { bigint: true })) &&
                    sameObject(evidence, lstatSync(evidencePath, { bigint: true })) && sameFile(captured.stamp, lstatSync(viewPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!frameUnchanged())
            return artifactReadUnavailable("observation_changed");
        reason = "view_invalid";
        const view = record(JSON.parse(captured.text));
        if (!view || Number(captured.stamp.size) !== entry.bytes_total || !contextFields(view, ["schema", "run", "run_instance_id", "capture_scope", "contents", "availability", "production_provenance",
            "captured_at", "content_scope", "coverage", "summary", "artifacts", "artifacts_shown", "artifacts_omitted", "inventory"]) ||
            view.schema !== VIEW_CONFIG.artifacts.schema || !artifactHeader(view, owner.identity) || view.content_scope !== "captured_artifact_inventory_reference" ||
            !contextCoverage(view.coverage, true) || !Array.isArray(view.artifacts) || view.artifacts.length !== 0 || view.artifacts_shown !== 0 ||
            typeof view.captured_at !== "string" || !Number.isFinite(Date.parse(view.captured_at)) || new Date(view.captured_at).toISOString() !== view.captured_at)
            return artifactReadUnavailable("view_invalid");
        const descriptor = record(view.inventory);
        const source = record(descriptor?.source);
        const total = descriptor?.declarations_total;
        if (!descriptor || !contextFields(descriptor, ["source", "bytes_total", "declarations_total"]) || !source || !contextFields(source, ["path", "run_instance_id", "sha256"]) ||
            source.path !== artifactInventoryPath(root, owner.identity) || source.run_instance_id !== owner.identity.run_instance_id ||
            typeof source.sha256 !== "string" || source.sha256.length !== 64 || !/^[a-f0-9]{64}$/u.test(source.sha256) ||
            typeof descriptor.bytes_total !== "number" || !Number.isSafeInteger(descriptor.bytes_total) || descriptor.bytes_total <= 0 || descriptor.bytes_total > RUN_ARTIFACT_INVENTORY_MAX_BYTES ||
            typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0 || view.artifacts_omitted !== total)
            return artifactReadUnavailable("view_invalid");
        const summary = artifactSummary(view.summary, total);
        if (!summary)
            return artifactReadUnavailable("view_invalid");
        const selection = range ?? { start: 0, end: Math.min(total, DEFAULT_INSPECT_LINES) };
        if (selection.end > total)
            return artifactReadUnavailable("range_invalid");
        reason = "source_unavailable";
        const retained = readFixedSourceText(source.path, RUN_ARTIFACT_INVENTORY_MAX_BYTES, "Run artifact inventory source");
        reason = "source_invalid";
        if (Number(retained.stamp.size) !== descriptor.bytes_total || createHash("sha256").update(retained.text).digest("hex") !== source.sha256)
            return artifactReadUnavailable("source_invalid");
        const inventory = record(JSON.parse(retained.text));
        if (!inventory || !contextFields(inventory, ["schema", "run", "run_instance_id", "capture_scope", "contents", "availability", "production_provenance", "content_scope", "inventory_complete", "coverage", "summary", "artifacts"]) ||
            inventory.schema !== "run-artifact-inventory-v1" || !artifactHeader(inventory, owner.identity) || inventory.content_scope !== "captured_artifact_declarations" ||
            inventory.inventory_complete !== true || !contextCoverage(inventory.coverage, false) || !Array.isArray(inventory.artifacts) || inventory.artifacts.length !== total)
            return artifactReadUnavailable("source_invalid");
        const sourceSummary = artifactSummary(inventory.summary, total);
        if (!sourceSummary || sourceSummary.references_disclosed !== summary.references_disclosed || sourceSummary.references_withheld !== summary.references_withheld)
            return artifactReadUnavailable("source_invalid");
        const declarations = [];
        let withheld = 0;
        for (const raw of inventory.artifacts) {
            const item = artifactDeclaration(raw);
            if (!item)
                return artifactReadUnavailable("source_invalid");
            declarations.push(item);
            if (item.path === null)
                withheld++;
        }
        if (withheld !== summary.references_withheld)
            return artifactReadUnavailable("source_invalid");
        const unchanged = () => { try {
            return frameUnchanged() && sameFile(retained.stamp, lstatSync(source.path, { bigint: true }));
        }
        catch {
            return false;
        } };
        if (!unchanged())
            return artifactReadUnavailable("observation_changed");
        const result = Object.freeze({ state: "available", identity: owner.identity,
            inventory: Object.freeze({ source: Object.freeze({ path: source.path, run_instance_id: source.run_instance_id, sha256: source.sha256 }), bytes_total: descriptor.bytes_total, declarations_total: total }),
            capture_scope: "producer_admission", contents: "not_read", availability: "not_observed", production_provenance: "not_asserted", summary,
            selection: Object.freeze(selection), artifacts: Object.freeze(declarations.slice(selection.start, selection.end)), artifacts_omitted: total - (selection.end - selection.start),
            coverage: Object.freeze({ truncated: selection.start > 0 || selection.end < total, redacted: true }), unchanged });
        if (Buffer.byteLength(JSON.stringify(result)) > RUN_CONTEXT_ARTIFACT_MAX_BYTES)
            return artifactReadUnavailable("range_too_large");
        return unchanged() ? result : artifactReadUnavailable("observation_changed");
    }
    catch {
        return artifactReadUnavailable(reason);
    }
}
function captureExecution(stateDir, producer) {
    const metadata = readContextMetadata(stateDir, producer);
    if (metadata.state === "unavailable")
        return executionUnavailable(metadata.reason === "changed" ? "execution_changed" : "execution_metadata_unavailable");
    const path = join(metadata.root, "execution.json");
    const before = optionalStamp(path);
    if (!before)
        return executionUnavailable("execution_absent");
    if (!before.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
        return executionUnavailable("execution_unavailable");
    const metadataUnchanged = captureContextMetadataFence(metadata, producer);
    if (!metadataUnchanged)
        return executionUnavailable("execution_changed");
    // Execution facts stay current; their Recipe privacy is fixed before reading the manifest body.
    const recipe = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    if (!recipe)
        return executionUnavailable("execution_admission_unavailable");
    const metadataUnredacted = createContextIdentityPrivacyCheck(recipe);
    if (!metadataUnredacted({ run: producer.run, run_instance_id: producer.runInstanceId }))
        return executionUnavailable("execution_identity_redacted");
    const read = readJsonFileResilient(path, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
    const after = optionalStamp(path);
    const metaAfter = optionalStamp(metadata.path);
    if (!after || !sameFile(before, after) || !metaAfter || !sameFile(metadata.stamp, metaAfter) || !metadataUnchanged())
        return executionUnavailable("execution_changed");
    if (read.diagnostics.length)
        return executionUnavailable("execution_invalid");
    const projected = projectRunExecutionManifest({ run: producer.run, run_instance_id: producer.runInstanceId }, read.value, recipe, createRunRecipeBodyRedactor(recipe));
    if (projected.state === "unavailable")
        return executionUnavailable("execution_invalid");
    // Source facts and report/reference tokens stay exact; privacy refuses this view, not the actual root outcome.
    if (!metadataUnredacted({ updated_at: projected.view.updated_at }) || projected.view.commands.some(command => !metadataUnredacted({ id: command.id, ...(command.started_at === undefined ? {} : { started_at: command.started_at }),
        ...(command.completed_at === undefined ? {} : { completed_at: command.completed_at }) }) ||
        command.attempts.some(attempt => attempt.native_signal !== undefined && !metadataUnredacted({ native_signal: attempt.native_signal })))) {
        return executionUnavailable("execution_metadata_redacted");
    }
    const capturedAt = new Date().toISOString();
    if (!metadataUnredacted({ captured_at: capturedAt }))
        return executionUnavailable("execution_metadata_redacted");
    const content = JSON.stringify({ schema: VIEW_CONFIG.execution.schema, run: producer.run, run_instance_id: producer.runInstanceId,
        captured_at: capturedAt, coverage: EXECUTION_VIEW_COVERAGE, source_scope: "execution_manifest",
        capture_references: "not_exported", capture_bodies: "not_read", session_bodies: "not_read", scope_closure: "not_asserted", execution: projected.view }, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_EXECUTION_MAX_BYTES)
        return executionUnavailable("execution_view_too_large");
    const unchanged = () => {
        try {
            return metadataUnchanged() && sameFile(after, lstatSync(path, { bigint: true }));
        }
        catch {
            return false;
        }
    };
    return unchanged() ? Object.freeze({ status: "captured", captured_at: capturedAt, content, unchanged, original_root: metadata.root }) : executionUnavailable("execution_changed");
}
/** The original runtime producer is required twice: permission to read/project is not permission to publish after replacement. */
export function writeRunControlContextExport(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, context => {
        try {
            return captureControl(stateDir, producer, context.status);
        }
        catch {
            return unavailable("control_journal_unavailable");
        }
    });
    if (captured.status === "unavailable")
        return captured;
    const written = publishContextView(stateDir, producer, "control", captured);
    // Post-success only, including lifecycle release; later index errors remain a separate effect.
    if (!readRunProducerCleanupFailure(producer))
        controlPublications.set(producer, Object.freeze({ root: captured.original_root, content: captured.content }));
    return written;
}
export function writeRunRecipeContextExport(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, () => {
        try {
            return captureRecipe(stateDir, producer);
        }
        catch {
            return recipeUnavailable("recipe_metadata_invalid");
        }
    });
    return captured.status === "unavailable" ? captured : publishContextView(stateDir, producer, "recipe", captured);
}
export function writeRunTraceContextExport(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, () => {
        try {
            return captureTrace(stateDir, producer);
        }
        catch {
            return traceUnavailable("trace_journal_unavailable");
        }
    });
    if (captured.status === "unavailable")
        return captured;
    const written = publishContextView(stateDir, producer, "trace", captured);
    // A returned commit can retain cleanup failure separately; neither a throw nor that report mints admission.
    if (!readRunProducerCleanupFailure(producer))
        tracePublications.set(producer, Object.freeze({ root: captured.original_root, content: captured.content }));
    return written;
}
export function writeRunResultContextExport(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, () => captureResult(stateDir, producer));
    if (captured.status === "unavailable")
        return captured;
    const written = publishContextView(stateDir, producer, "result", captured);
    if (!readRunProducerCleanupFailure(producer))
        resultPublications.set(producer, Object.freeze({ root: captured.original_root, content: captured.content }));
    return written;
}
export function writeRunArtifactContextExport(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, () => {
        try {
            return captureArtifacts(stateDir, producer);
        }
        catch {
            return artifactUnavailable("artifact_observation_unavailable");
        }
    });
    if (captured.status !== "unavailable")
        return publishContextView(stateDir, producer, "artifacts", captured);
    if (captured.reason !== "artifact_manifest_too_large")
        return captured;
    const inventoryView = retainArtifactInventoryView(stateDir, producer);
    return inventoryView ? publishContextView(stateDir, producer, "artifacts", inventoryView) : captured;
}
export function writeRunExecutionContextExport(stateDir, producer) {
    const captured = withRunProducerEvidence(stateDir, producer, () => {
        try {
            return captureExecution(stateDir, producer);
        }
        catch {
            return executionUnavailable("execution_unavailable");
        }
    });
    if (captured.status === "unavailable")
        return captured;
    const written = publishContextView(stateDir, producer, "execution", captured);
    if (!readRunProducerCleanupFailure(producer))
        executionPublications.set(producer, Object.freeze({ root: captured.original_root, content: captured.content }));
    return written;
}
function readViewBinding(path, role) {
    const config = VIEW_CONFIG[role];
    if (config.format === "jsonl") {
        const read = readJsonlFileResilient(path, { maxBytes: config.maxBytes });
        return read.diagnostics.length ? undefined : record(read.records[0]);
    }
    const read = readJsonFileResilient(path, undefined, { maxBytes: config.maxBytes });
    return read.diagnostics.length ? undefined : record(read.value);
}
function publishContextView(stateDir, producer, role, captured) {
    const config = VIEW_CONFIG[role];
    return withRunProducerEvidence(stateDir, producer, () => {
        if (captured.unchanged && !captured.unchanged())
            throw new ContextExportBindingRefusal("Run context captured source binding changed.");
        const root = assertOwnedRunStateDirectory(stateDir, producer.run);
        const directory = lstatSync(root, { bigint: true });
        const metaPath = join(root, "run.json");
        const markerPath = join(root, RUN_STATE_OWNERSHIP_FILE);
        const meta = lstatSync(metaPath, { bigint: true });
        const marker = lstatSync(markerPath, { bigint: true });
        const evidencePath = join(root, "evidence");
        let evidence = optionalStamp(evidencePath);
        if (evidence && (!evidence.isDirectory() || evidence.isSymbolicLink()))
            throw new ContextExportBindingRefusal("Run context export directory is unavailable or invalid.");
        if (!evidence) {
            mkdirSync(evidencePath);
            evidence = lstatSync(evidencePath, { bigint: true });
        }
        const path = join(root, runContextExportPath(role));
        const target = optionalStamp(path);
        if (target) {
            if (!target.isFile())
                throw new ContextExportBindingRefusal("Run context export binding is unavailable or invalid.");
            const value = readViewBinding(path, role);
            const after = optionalStamp(path);
            if (!value || value.schema !== config.schema || value.run !== producer.run ||
                value.run_instance_id !== producer.runInstanceId || !after || !sameFile(target, after)) {
                throw new ContextExportBindingRefusal("Run context export binding changed or is unavailable.");
            }
        }
        writeTextAtomic(path, captured.content, { onBeforeReplace() {
                const currentDirectory = lstatSync(root, { bigint: true });
                const currentEvidence = lstatSync(evidencePath, { bigint: true });
                const currentTarget = optionalStamp(path);
                if ((captured.unchanged && !captured.unchanged()) || !currentDirectory.isDirectory() || !sameObject(directory, currentDirectory) ||
                    !currentEvidence.isDirectory() || !sameObject(evidence, currentEvidence) ||
                    !sameFile(meta, lstatSync(metaPath, { bigint: true })) || !sameFile(marker, lstatSync(markerPath, { bigint: true })) ||
                    (target ? !currentTarget || !sameFile(target, currentTarget) : currentTarget !== undefined)) {
                    throw new ContextExportBindingRefusal("Run context export binding changed or is unavailable.");
                }
            } });
        const entry = Object.freeze({ availability: "available", path: runContextExportPath(role),
            media_type: config.media, bytes_total: Buffer.byteLength(captured.content, "utf8"), mutable: true,
            coverage: captured.coverage ?? config.coverage });
        return Object.freeze({ status: "written", captured_at: captured.captured_at, entry });
    });
}
/** A separate admitted index commit preserves partial view effects; unavailable sources create metadata, never empty views. */
export function writeRunControlContextIndex(stateDir, producer) {
    return publishContextIndex(stateDir, producer, "control", writeRunControlContextExport(stateDir, producer));
}
export function writeRunRecipeContextIndex(stateDir, producer) {
    return publishContextIndex(stateDir, producer, "recipe", writeRunRecipeContextExport(stateDir, producer));
}
export function writeRunTraceContextIndex(stateDir, producer) {
    return publishContextIndex(stateDir, producer, "trace", writeRunTraceContextExport(stateDir, producer));
}
export function writeRunResultContextIndex(stateDir, producer) {
    return publishContextIndex(stateDir, producer, "result", writeRunResultContextExport(stateDir, producer));
}
export function writeRunArtifactContextIndex(stateDir, producer) {
    return publishContextIndex(stateDir, producer, "artifacts", writeRunArtifactContextExport(stateDir, producer));
}
export function writeRunExecutionContextIndex(stateDir, producer) {
    return publishContextIndex(stateDir, producer, "execution", writeRunExecutionContextExport(stateDir, producer));
}
function publishContextIndex(stateDir, producer, role, view) {
    const entry = view.status === "written" ? view.entry
        : view.reason === "artifact_declarations_absent" ? { availability: "not_applicable", path: null }
            : view.reason === "control_journal_absent" || view.reason === "trace_journal_absent" || view.reason === "result_absent" || view.reason === "execution_absent" ? { availability: "pending", path: null }
                : { availability: "unavailable", path: null, reason: view.reason };
    return withRunProducerEvidence(stateDir, producer, () => {
        const expected = { run: producer.run, run_instance_id: producer.runInstanceId,
            ...(producer.ownerId !== undefined ? { ownerId: producer.ownerId } : {}) };
        const publication = writeRunContextIndexUnderLock(stateDir, expected, { [role]: entry });
        return Object.freeze({ status: "published", ...publication });
    });
}
function primarySourcePath(stateDir, identity) {
    const key = createHash("sha256").update(JSON.stringify([identity.run, identity.run_instance_id, identity.ownerId ?? null])).digest("hex");
    return join(stateDir, "evidence", `primary-${key}.txt`);
}
class PrimaryTextBindingRefusal extends Error {
}
function primaryUnavailable(reason) { return Object.freeze({ output: null, output_unavailable: reason }); }
function readFixedSourceText(path, maxBytes = RUN_STREAM_SOURCE_MAX_BYTES, label = "Run primary source") {
    const stamp = lstatSync(path, { bigint: true });
    if (!stamp.isFile() || stamp.size > BigInt(maxBytes))
        throw new PrimaryTextBindingRefusal(`${label} is not a bounded regular file.`);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        if (!sameFile(stamp, fstatSync(fd, { bigint: true })))
            throw new PrimaryTextBindingRefusal(`${label} changed.`);
        const bytes = Buffer.alloc(Number(stamp.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count)
                throw new PrimaryTextBindingRefusal(`${label} ended before its bounded read completed.`);
            offset += count;
        }
        let text;
        try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        }
        catch (error) {
            throw new PrimaryTextBindingRefusal(`${label} is not valid UTF-8.`, { cause: error });
        }
        if (!sameFile(stamp, fstatSync(fd, { bigint: true })) || !sameFile(stamp, lstatSync(path, { bigint: true })))
            throw new PrimaryTextBindingRefusal(`${label} changed.`);
        return { text, stamp };
    }
    finally {
        closeSync(fd);
    }
}
const snapshotReferenceIssuer = Symbol("Run snapshot reference issuer");
class SnapshotReferenceReader {
    #root;
    #identity;
    #frameUnchanged;
    read;
    constructor(issuer, root, identity, frameUnchanged, read) {
        if (issuer !== snapshotReferenceIssuer)
            throw new Error("Run snapshot reference reader requires its private issuer.");
        this.#root = root;
        this.#identity = identity;
        this.#frameUnchanged = frameUnchanged;
        this.read = read;
        Object.freeze(this);
    }
    static admit(value, stateDir, expected) {
        if (isPromise(value)) {
            void Promise.prototype.then.call(value, undefined, () => undefined);
            return undefined;
        }
        if (!value || typeof value !== "object" || !(#root in value))
            return undefined;
        const identity = contextReadIdentity(expected);
        return identity && value.#root === stateDir && identity.run === value.#identity.run && identity.run_instance_id === value.#identity.run_instance_id &&
            identity.ownerId === value.#identity.ownerId && value.#frameUnchanged() ? value : undefined;
    }
}
/** Original same-module reader only; schemas, copied objects/prototypes and flags are not permission. */
export function admitRunSnapshotReferenceReader(stateDir, expected, value) {
    return SnapshotReferenceReader.admit(value, stateDir, expected);
}
function snapshotReferenceFrame(root) {
    const directory = lstatSync(root, { bigint: true });
    const markerPath = join(root, RUN_STATE_OWNERSHIP_FILE);
    const marker = lstatSync(markerPath, { bigint: true });
    return () => { try {
        const current = lstatSync(root, { bigint: true });
        return current.isDirectory() && sameObject(directory, current) && sameFile(marker, lstatSync(markerPath, { bigint: true }));
    }
    catch {
        return false;
    } };
}
/** Snapshot only own JSON data, without invoking serialization hooks/getters; refuse the complete privacy capture on loss. */
function launchPrivacyMetadata(value) {
    try {
        let bytes = 0;
        const seen = new Set();
        const account = (count) => { bytes += count; if (bytes > RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES)
            throw new Error("Run launch privacy capture exceeds its budget."); };
        const copy = (item) => {
            if (item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
                account(Buffer.byteLength(JSON.stringify(item)));
                return item;
            }
            if (!item || typeof item !== "object" || seen.has(item))
                throw new Error("Run launch privacy capture is not JSON data.");
            const array = Array.isArray(item);
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
                throw new Error("Run launch privacy capture has a custom prototype.");
            const fields = Object.getOwnPropertyDescriptors(item);
            if (fields.toJSON && (!Object.hasOwn(fields.toJSON, "value") || typeof fields.toJSON.value === "function"))
                throw new Error("Run launch privacy capture has a serialization hook.");
            seen.add(item);
            account(2);
            const result = array ? [] : Object.create(null);
            Object.setPrototypeOf(result, null);
            if (array) {
                const length = item.length;
                if (length > RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES)
                    throw new Error("Run launch privacy array exceeds its budget.");
                for (let i = 0; i < length; i++) {
                    const field = fields[String(i)];
                    if (field && !Object.hasOwn(field, "value"))
                        throw new Error("Run launch privacy capture has an accessor.");
                    if (i)
                        account(1);
                    result[i] = copy(field?.value === undefined ? null : field.value);
                }
            }
            else {
                let count = 0;
                for (const [key, field] of Object.entries(fields)) {
                    if (!field.enumerable)
                        continue;
                    if (!Object.hasOwn(field, "value"))
                        throw new Error("Run launch privacy capture has an accessor.");
                    if (field.value === undefined)
                        continue;
                    account(Buffer.byteLength(JSON.stringify(key)) + 1 + (count++ ? 1 : 0));
                    result[key] = copy(field.value);
                }
            }
            seen.delete(item);
            return result;
        };
        const copied = copy(value);
        return record(copied) ? JSON.parse(JSON.stringify(copied)) : undefined;
    }
    catch {
        return undefined;
    }
}
/** Trusted fresh-launch kernel entry, under its already-held lifecycle lock after full metadata assembly, before publication/work.
 * The caller's actual admission is authority, NOT metadata shape, marker or clock origin as a privacy certificate; not an arbitrary-JS sandbox.
 * No actor/configuration or saved-data route may invoke this issuer. The original runtime-local reader, never its DTO, crosses the handoff.
 */
export function captureRunAdmissionSnapshotReferences(stateDir, metadata, origin) {
    const data = contextReadRequest(metadata);
    const identity = contextReadIdentity(metadata);
    if (!data || !identity || data.pid !== 0 || data.outcome_protocol !== RUN_OUTCOME_PROTOCOL)
        throw new ContextExportBindingRefusal("Run launch reference admission is invalid.");
    const root = assertOwnedRunStateDirectory(stateDir, identity.run);
    if (data.state_dir !== root || readRunContextIdentity(root, identity).state === "available")
        throw new ContextExportBindingRefusal("Run launch reference admission must be unpublished and root-bound.");
    const policy = contextReadRequest(data.supervision);
    let clock;
    try {
        clock = policy && readRunSupervisionClock({ started_at: data.started_at, createdAt: data.createdAt, supervision: policy });
    }
    catch { /* Fail closed below. */ }
    if (!clock || createRunSupervisionTimebase(clock, origin).state !== "available")
        throw new ContextExportBindingRefusal("Run launch reference admission requires its original clock origin.");
    return capturedSnapshotReferenceReader({ root, metadata: launchPrivacyMetadata(metadata), frameUnchanged: snapshotReferenceFrame(root) }, identity);
}
function snapshotReference(value, redact, withoutSecrets) {
    if (typeof value !== "string" || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString("utf8") !== value)
        return "invalid";
    return withoutSecrets(value) === value && redact(value) === value ? "available" : "redacted";
}
/** Private runtime-local reference permission from genuine admission; not lifecycle/timing/body authority or durable transport. */
export function createRunSnapshotReferenceReader(stateDir, producer) {
    const capture = withRunProducerEvidence(stateDir, producer, () => {
        const root = assertOwnedRunStateDirectory(stateDir, producer.run);
        const metadata = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
        if (metadata && (metadata.state_dir !== root || metadata.run !== producer.run || metadata.run_instance_id !== producer.runInstanceId || metadata.ownerId !== producer.ownerId)) {
            throw new ContextExportBindingRefusal("Run snapshot reference capture binding changed.");
        }
        return { root, metadata, frameUnchanged: snapshotReferenceFrame(root) };
    });
    const identity = Object.freeze({ run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) });
    return capturedSnapshotReferenceReader(capture, identity);
}
function capturedSnapshotReferenceReader(capture, identity) {
    const indexPath = join(capture.root, RUN_CONTEXT_INDEX_FILE);
    let cwd = null;
    let cwdUnavailable;
    let indexUnavailable;
    let policyAvailable = false;
    try {
        if (capture.metadata) {
            const redact = createRunRecipeTextRedactor(capture.metadata), withoutSecrets = capturedSecretMask(capture.metadata, "");
            const cwdState = snapshotReference(capture.metadata.cwd, redact, withoutSecrets);
            if (cwdState === "available")
                cwd = capture.metadata.cwd;
            else
                cwdUnavailable = cwdState === "redacted" ? "cwd_reference_redacted" : "cwd_reference_invalid";
            const indexState = snapshotReference(indexPath, redact, withoutSecrets);
            if (indexState !== "available")
                indexUnavailable = indexState === "redacted" ? "index_reference_redacted" : "index_reference_invalid";
            policyAvailable = true;
        }
    }
    catch { /* Failed full admission privacy cannot disclose a reference or fall back to live metadata. */ }
    return new SnapshotReferenceReader(snapshotReferenceIssuer, capture.root, identity, capture.frameUnchanged, () => {
        const unavailable = (reason) => Object.freeze({ state: "unavailable", reason });
        if (!policyAvailable)
            return unavailable("privacy_capture_unavailable");
        if (!capture.frameUnchanged())
            return unavailable("observation_changed");
        const owner = readRunContextIdentity(capture.root, identity);
        if (owner.state !== "available")
            return unavailable(owner.reason);
        try {
            const maximum = { state: "available", identity, references: { cwd, ...(cwdUnavailable ? { cwd_unavailable: cwdUnavailable } : {}),
                    context_index: indexUnavailable ? null : { identity, path: indexPath }, ...(indexUnavailable ? { context_index_unavailable: indexUnavailable } : {}) } };
            if (Buffer.byteLength(JSON.stringify(maximum)) > RUN_DELIVERY_MODEL_MAX_BYTES)
                return unavailable("references_too_large");
            const before = indexUnavailable ? undefined : optionalStamp(indexPath);
            const context = indexUnavailable ? undefined : readRunContextIndex(capture.root, identity);
            const unchanged = () => {
                try {
                    const after = indexUnavailable ? undefined : optionalStamp(indexPath);
                    return capture.frameUnchanged() && owner.unchanged() && (indexUnavailable !== undefined ||
                        (before === undefined ? after === undefined : after !== undefined && sameObject(before, after) && before.mode === after.mode && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs));
                }
                catch {
                    return false;
                }
            };
            if (!unchanged())
                return unavailable("observation_changed");
            const references = Object.freeze({ cwd, ...(cwdUnavailable ? { cwd_unavailable: cwdUnavailable } : {}),
                context_index: context?.state === "available" ? Object.freeze({ identity: context.identity, path: context.local_path }) : null,
                ...(context?.state === "available" ? {} : { context_index_unavailable: indexUnavailable ?? "index_unavailable" }) });
            return Object.freeze({ state: "available", identity, references, unchanged });
        }
        catch {
            return unavailable("observation_unavailable");
        }
    });
}
/** Kernel-owned invocation context. Only explicit executor selection publishes command text or its final response. */
export function createRunPrimaryTextPublisher(stateDir, producer) {
    const metadata = withRunProducerEvidence(stateDir, producer, () => readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES));
    let redact;
    try {
        if (metadata)
            redact = createRunRecipeTextRedactor(metadata);
    }
    catch { /* No privacy proof means no source publication. */ }
    const identityUnchanged = metadata ? createContextIdentityPrivacyCheck(metadata)({ run: producer.run, run_instance_id: producer.runInstanceId,
        ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) }) : undefined;
    let observed;
    let count = 0;
    let binding = primaryUnavailable("not_selected");
    let failure;
    let cleanupFailure;
    let sourceUnchanged;
    let responseSelected = false;
    const capture = (original, inputUnchanged, response) => {
        if (!redact) {
            binding = primaryUnavailable("privacy_capture_unavailable");
            return;
        }
        if (!identityUnchanged) {
            binding = primaryUnavailable("identity_redacted");
            return;
        }
        let projected;
        try {
            projected = redact(original);
        }
        catch (error) {
            failure = error;
            binding = primaryUnavailable("projection_unavailable");
            return;
        }
        if (typeof projected !== "string" || (response !== undefined && Buffer.from(projected).toString("utf8") !== projected) || Buffer.byteLength(projected) > RUN_STREAM_SOURCE_MAX_BYTES) {
            binding = primaryUnavailable("projection_unavailable");
            return;
        }
        const text = projected;
        let chars = 0;
        let preview = "";
        let shown = 0;
        for (const point of text) {
            chars++;
            if (shown < COMPACT_PREVIEW_CHARS) {
                preview += point;
                shown++;
            }
        }
        const path = primarySourcePath(stateDir, { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId === undefined ? {} : { ownerId: producer.ownerId }) });
        const output = Object.freeze({ source: Object.freeze({ path, run_instance_id: producer.runInstanceId, sha256: createHash("sha256").update(text).digest("hex") }),
            bytes_total: Buffer.byteLength(text), shown_bytes: Object.freeze({ start: 0, end: Buffer.byteLength(preview) }),
            chars_total: chars, chars_shown: shown, chars_omitted: chars - shown, preview, truncated: shown < chars, redacted: text !== original, ...response });
        if (Buffer.byteLength(JSON.stringify({ output })) > RUN_DELIVERY_MODEL_MAX_BYTES) {
            binding = primaryUnavailable("descriptor_too_large");
            return;
        }
        binding = withRunProducerEvidence(stateDir, producer, () => {
            if (!inputUnchanged())
                throw new PrimaryTextBindingRefusal("Run primary selected capture binding changed.");
            const root = assertOwnedRunStateDirectory(stateDir, producer.run);
            const directory = lstatSync(root, { bigint: true });
            const metaPath = join(root, "run.json");
            const markerPath = join(root, RUN_STATE_OWNERSHIP_FILE);
            const meta = lstatSync(metaPath, { bigint: true });
            const marker = lstatSync(markerPath, { bigint: true });
            const evidencePath = join(root, "evidence");
            let evidence;
            const rootUnchanged = () => {
                try {
                    return sameObject(directory, lstatSync(root, { bigint: true })) && sameFile(meta, lstatSync(metaPath, { bigint: true })) && sameFile(marker, lstatSync(markerPath, { bigint: true }));
                }
                catch {
                    return false;
                }
            };
            const frameUnchanged = () => {
                try {
                    return rootUnchanged() && !!evidence && sameObject(evidence, lstatSync(evidencePath, { bigint: true }));
                }
                catch {
                    return false;
                }
            };
            try {
                evidence = optionalStamp(evidencePath);
                if (evidence && (!evidence.isDirectory() || evidence.isSymbolicLink()))
                    throw new PrimaryTextBindingRefusal("Run primary export directory binding is invalid.");
                if (!evidence) {
                    mkdirSync(evidencePath);
                    evidence = lstatSync(evidencePath, { bigint: true });
                }
                const existing = optionalStamp(path);
                if (existing) {
                    if (readFixedSourceText(path).text !== text)
                        throw new PrimaryTextBindingRefusal("Run primary source identity already fixes different bytes.");
                }
                else {
                    const temporary = join(evidencePath, `.primary-${randomUUID()}.tmp`);
                    let written = false;
                    let failed = false;
                    try {
                        writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
                        written = true;
                        if (!frameUnchanged() || !inputUnchanged())
                            throw new PrimaryTextBindingRefusal("Run primary publication binding changed.");
                        try {
                            linkSync(temporary, path);
                        }
                        catch (error) {
                            if (error.code === "EEXIST")
                                throw new PrimaryTextBindingRefusal("Run primary source target appeared during publication.", { cause: error });
                            throw error;
                        }
                    }
                    catch (error) {
                        failed = true;
                        throw error;
                    }
                    finally {
                        if (written) {
                            try {
                                unlinkSync(temporary);
                            }
                            catch (error) {
                                cleanupFailure ??= error;
                                if (!failed)
                                    throw error;
                            }
                        }
                    }
                }
                const saved = readFixedSourceText(path);
                if (saved.text !== text)
                    throw new PrimaryTextBindingRefusal("Run primary source identity already fixes different bytes.");
                sourceUnchanged = () => { try {
                    return frameUnchanged() && sameFile(saved.stamp, lstatSync(path, { bigint: true }));
                }
                catch {
                    return false;
                } };
            }
            catch (error) {
                if (error instanceof PrimaryTextBindingRefusal)
                    throw error;
                failure = error;
                if (!rootUnchanged() || (evidence && !frameUnchanged()) || !inputUnchanged())
                    throw new PrimaryTextBindingRefusal("Run primary publication binding changed during export failure.");
                return primaryUnavailable("export_failed");
            }
            if (!frameUnchanged() || !inputUnchanged())
                throw new PrimaryTextBindingRefusal("Run primary publication binding changed.");
            return Object.freeze({ output });
        });
    };
    return Object.freeze({
        observe(result, observation) {
            count++;
            observed = { result, observation: { commandId: observation.commandId, attempts: [...observation.attempts], session: observation.session } };
        },
        select(result) {
            if (!observed || result !== observed.result)
                throw new PrimaryTextBindingRefusal("Run primary selection requires its exact observed invocation result.");
            withRunProducerEvidence(stateDir, producer, () => { });
            const { commandId, attempts, session } = observed.observation;
            const receipt = attempts[0];
            const selected = result;
            const raw = receipt?.result;
            if (count !== 1 || session || !/^command-[0-9]{3,}$/.test(commandId) || attempts.length !== 1 || receipt?.attempt !== 1 ||
                selected.code !== 0 || selected.killed || raw?.code !== 0 || raw.killed) {
                binding = primaryUnavailable("selection_not_supported");
                return;
            }
            if (!redact) {
                binding = primaryUnavailable("privacy_capture_unavailable");
                return;
            }
            if (!identityUnchanged) {
                binding = primaryUnavailable("identity_redacted");
                return;
            }
            const relative = `captures/${commandId}/attempt-001/stdout.log`;
            if ((raw.stdoutFile !== undefined && raw.stdoutFile !== join(stateDir, relative)) || selected.stdout !== raw.stdout) {
                throw new PrimaryTextBindingRefusal("Run primary selected capture binding changed.");
            }
            const observedBytes = raw.stdoutBytes;
            const memoryBytes = Buffer.byteLength(raw.stdout);
            const tail = raw.stdoutTruncated === true;
            if (!raw.stdoutFile || raw.stdoutCaptureIncomplete ||
                (raw.stdoutFileBytes !== undefined && raw.stdoutFileBytes !== observedBytes) ||
                typeof observedBytes !== "number" || !Number.isSafeInteger(observedBytes) || observedBytes < memoryBytes ||
                (tail ? observedBytes <= memoryBytes || typeof receipt.stdoutSha256 !== "string" || receipt.stdoutSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(receipt.stdoutSha256)
                    : observedBytes !== memoryBytes)) {
                binding = primaryUnavailable("complete_capture_unavailable");
                return;
            }
            const input = readExecutionCaptureText(stateDir, relative);
            if (input.availability !== "available") {
                binding = primaryUnavailable("capture_unavailable");
                return;
            }
            // A matching tail/size cannot bind an unseen prefix; compare the privately retained observed-stream digest.
            if (input.reference.bytes_total !== observedBytes || (tail
                ? !input.text.endsWith(raw.stdout) || createHash("sha256").update(input.text).digest("hex") !== receipt.stdoutSha256
                : input.text !== raw.stdout))
                throw new PrimaryTextBindingRefusal("Run primary selected capture binding changed.");
            if (!input.text) {
                binding = primaryUnavailable("no_primary_text");
                return;
            }
            capture(input.text, () => input.reference.unchanged());
        },
        selectResponse(text, upstreamTruncated) {
            withRunProducerEvidence(stateDir, producer, () => { });
            if (responseSelected)
                throw new PrimaryTextBindingRefusal("Run final response is already selected.");
            // Never replace a complete source or heal failed privacy/capture/publication through another selection.
            if (binding.output || !["not_selected", "selection_not_supported"].includes(binding.output_unavailable))
                return;
            responseSelected = true;
            if (typeof text !== "string" || typeof upstreamTruncated !== "boolean")
                throw new PrimaryTextBindingRefusal("Run final response selection is invalid.");
            if (!text) {
                binding = primaryUnavailable("no_primary_text");
                return;
            }
            if (Buffer.byteLength(text) > RUN_STREAM_SOURCE_MAX_BYTES) {
                binding = primaryUnavailable("response_too_large");
                return;
            }
            // The executor supplies an immutable call-local response, not a session log or a reconstructed capture.
            capture(text, () => true, { text_basis: "actor_response", upstream_truncated: upstreamTruncated });
        },
        snapshot: () => {
            if (binding.output && !sourceUnchanged?.())
                throw new PrimaryTextBindingRefusal("Run primary retained source binding changed.");
            return binding;
        },
        readFailure: () => failure === undefined && cleanupFailure === undefined ? undefined : Object.freeze({ error: failure, cleanup_error: cleanupFailure }),
    });
}
function primaryReadUnavailable(reason, output_unavailable) {
    return Object.freeze({ state: "unavailable", reason, ...(output_unavailable === undefined ? {} : { output_unavailable }) });
}
function contextReadRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const fields = Object.getOwnPropertyDescriptors(value);
    return Object.values(fields).every(field => Object.hasOwn(field, "value"))
        ? Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])) : undefined;
}
function contextReadIdentity(expected) {
    const value = contextReadRequest(expected);
    if (!value || typeof value.run !== "string" || !value.run || /[^A-Za-z0-9_.-]/u.test(value.run) ||
        typeof value.run_instance_id !== "string" || !value.run_instance_id ||
        (value.ownerId !== undefined && (typeof value.ownerId !== "string" || !value.ownerId)))
        return undefined;
    return Object.freeze({ run: value.run, run_instance_id: value.run_instance_id, ...(value.ownerId === undefined ? {} : { ownerId: value.ownerId }) });
}
function contextJson(path) {
    const source = readFixedSourceText(path, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
    const value = record(JSON.parse(source.text.startsWith("\uFEFF") ? source.text.slice(1) : source.text));
    if (!value)
        throw new Error("Run primary metadata is not an object.");
    return { value, stamp: source.stamp };
}
function primaryChars(text) { let count = 0; for (const _point of text)
    count++; return count; }
function primaryBoundary(bytes, offset) {
    return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}
/** Saved canonical facts authorize only this published source. No producer, index, raw discovery, refresh, work or ACK. */
export function readRunPrimaryTextSource(stateDir, expected, query) {
    return readPrimaryTextSource(stateDir, expected, query, false);
}
/** Fresh completion admission only: select bounded text from the same verified source observation, not another source read. */
export function readRunCompletionTextSource(stateDir, expected) {
    return readPrimaryTextSource(stateDir, expected, undefined, true);
}
function readPrimaryTextSource(stateDir, expected, query, completion) {
    const request = contextReadIdentity(expected);
    if (!request)
        return primaryReadUnavailable("selection_invalid");
    let range;
    if (query !== undefined) {
        const value = contextReadRequest(query);
        if (!value || Object.keys(value).some(key => key !== "start" && key !== "end") ||
            !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || Number(value.start) < 0 || Number(value.end) < Number(value.start)) {
            return primaryReadUnavailable("selection_invalid");
        }
        range = { start: Number(value.start), end: Number(value.end) };
        if (range.end - range.start > RUN_CONTEXT_RESULT_MAX_BYTES)
            return primaryReadUnavailable("range_too_large");
    }
    const owner = readRunContextIdentity(stateDir, request);
    if (owner.state === "unavailable")
        return primaryReadUnavailable(owner.reason);
    let reason = "result_unavailable";
    try {
        const root = owner.local_path;
        const metadata = contextJson(join(root, "run.json"));
        const meta = metadata.value;
        if (meta.outcome_protocol !== RUN_OUTCOME_PROTOCOL || !Number.isSafeInteger(meta.pid) || Number(meta.pid) <= 0)
            return primaryReadUnavailable("publication_unavailable");
        const resultPath = join(root, "result.json");
        const canonical = contextJson(resultPath);
        const snapshot = readRunNaturalOutcomeSnapshot(root, meta, () => canonical.value);
        const frameUnchanged = () => owner.unchanged() && sameFile(metadata.stamp, lstatSync(join(root, "run.json"), { bigint: true })) &&
            sameFile(canonical.stamp, lstatSync(resultPath, { bigint: true }));
        if (!frameUnchanged())
            return primaryReadUnavailable("observation_changed");
        if (!snapshot.result || (snapshot.outcome.state !== "accepted" && snapshot.outcome.state !== "captured"))
            return primaryReadUnavailable("result_unavailable");
        if (snapshot.result.primary_text_protocol !== RUN_PRIMARY_TEXT_PROTOCOL)
            return primaryReadUnavailable("publication_unavailable");
        let binding;
        try {
            binding = decodeRunPrimaryTextBinding(root, owner.identity.run_instance_id, snapshot.result);
        }
        catch {
            return primaryReadUnavailable("binding_invalid");
        }
        if (!binding.output)
            return primaryReadUnavailable("output_unavailable", binding.output_unavailable);
        const output = binding.output;
        if (snapshot.result.code !== 0 || (snapshot.result.killed === true && output.text_basis !== "actor_response") || output.bytes_total === 0 ||
            output.source.path !== primarySourcePath(root, owner.identity))
            return primaryReadUnavailable("binding_invalid");
        reason = "source_unavailable";
        const evidencePath = join(root, "evidence");
        const evidence = lstatSync(evidencePath, { bigint: true });
        if (!evidence.isDirectory() || evidence.isSymbolicLink())
            return primaryReadUnavailable("source_unavailable");
        const source = readFixedSourceText(output.source.path);
        const bytes = Buffer.from(source.text);
        const excerpt = output.shown_bytes;
        if (bytes.length !== output.bytes_total || primaryChars(source.text) !== output.chars_total ||
            createHash("sha256").update(bytes).digest("hex") !== output.source.sha256 ||
            !primaryBoundary(bytes, excerpt.start) || !primaryBoundary(bytes, excerpt.end) ||
            bytes.subarray(excerpt.start, excerpt.end).toString("utf8") !== output.preview)
            return primaryReadUnavailable("source_invalid");
        const unchanged = () => {
            try {
                const current = lstatSync(evidencePath, { bigint: true });
                return frameUnchanged() && current.isDirectory() && sameObject(evidence, current) &&
                    sameFile(source.stamp, lstatSync(output.source.path, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!unchanged())
            return primaryReadUnavailable("observation_changed");
        let selected = output;
        if (completion) {
            let end = Math.min(bytes.length, RUN_COMPLETION_MODEL_MAX_BYTES);
            while (!primaryBoundary(bytes, end))
                end--;
            if (end < bytes.length && bytes[end - 1] === 13 && bytes[end] === 10)
                end--;
            range = { start: 0, end };
        }
        if (range) {
            if (range.end > bytes.length || !primaryBoundary(bytes, range.start) || !primaryBoundary(bytes, range.end))
                return primaryReadUnavailable("range_invalid");
            const preview = bytes.subarray(range.start, range.end).toString("utf8");
            const shown = primaryChars(preview);
            selected = Object.freeze({ ...output, shown_bytes: Object.freeze(range), preview, chars_shown: shown, chars_omitted: output.chars_total - shown, truncated: shown < output.chars_total });
        }
        const result = Object.freeze({ state: "available", identity: owner.identity, result_acceptance: snapshot.outcome.state === "accepted" ? "natural" : "capture_only",
            selection: range ? "byte_range" : "recorded_preview", output: selected,
            ...(completion ? { original_output: output } : {}), unchanged });
        // Completion text is private admission data, not a public64KiB encoded tool view.
        // Its48KiB prefix can need sixfold JSON escaping; the existing journal bound still limits this DTO.
        const encodedLimit = completion ? RUN_DELIVERY_JOURNAL_MAX_BYTES : RUN_CONTEXT_RESULT_MAX_BYTES;
        if (Buffer.byteLength(JSON.stringify(result)) > encodedLimit)
            return primaryReadUnavailable("range_too_large");
        return unchanged() ? result : primaryReadUnavailable("observation_changed");
    }
    catch {
        return primaryReadUnavailable(reason);
    }
}
