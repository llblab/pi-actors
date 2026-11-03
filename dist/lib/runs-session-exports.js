/**
 * Run session context: fixed privacy previews and generation-bound publication/selection.
 * Owns: assistant-only projection, recorded-session preview admission, producer-bound preview/catalog/index commits and selected published reads.
 * Excludes: private-role exposure, raw session export/discovery, primary-source completeness, native authority and multi-file transactions.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeTextAtomic } from "./file-state.js";
import { DEFAULT_INSPECT_LINES, SESSION_EVIDENCE_TEXT_CHARS } from "./limits.js";
import { createRunRecipeEvidenceRedactor, createRunRecipeBodyRedactor, createContextIdentityPrivacyCheck } from "./recipe-projection.js";
import { readRunContextIdentity, readRunContextIndex, runContextExportPath, writeRunContextIndexUnderLock, RUN_CONTEXT_INDEX_FILE, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES } from "./runs-context-index.js";
import { readRunExecutionReference } from "./runs-execution-evidence.js";
import { readExecutionSessionText } from "./execution-files.js";
import { readRunProducerCapturedMetadata, withRunProducerEvidence } from "./runs-results.js";
import { selectLastRecordedSessionBranch } from "./session-evidence.js";
import { readJsonFileResilient } from "./state-readers.js";
// --- Fixed privacy projection ---
export const SESSION_ASSISTANT_PREVIEW_MAX_BYTES = 64 * 1024;
/** Preview clipping happens after origin/secret projection, never by slicing raw/private session fields. */
export function projectSessionAssistantPreview(source, recipe = {}, redactEvidence) {
    const invalid = () => Object.freeze({ state: "unavailable", reason: "session_invalid" });
    let rows;
    try {
        const parsed = source.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
        if (!parsed.length || parsed.some(value => !record(value)))
            return invalid();
        rows = parsed;
    }
    catch {
        return invalid();
    }
    const header = rows[0];
    if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !header.id)
        return invalid();
    const ids = new Set();
    for (const row of rows.slice(1)) {
        if (row.type === "session" || typeof row.type !== "string" || !row.type || typeof row.id !== "string" || !row.id || ids.has(row.id) ||
            !(row.parentId === null || typeof row.parentId === "string"))
            return invalid();
        ids.add(row.id);
    }
    const diagnostics = [];
    const branch = selectLastRecordedSessionBranch(rows, "session", diagnostics);
    if (diagnostics.length)
        return invalid();
    const redact = redactEvidence ?? createRunRecipeEvidenceRedactor(recipe, Number.MAX_SAFE_INTEGER);
    const messages = [];
    let total = 0;
    for (const entry of branch) {
        if (entry.type !== "message")
            continue;
        const message = record(entry.message);
        if (!message || message.role !== "assistant")
            continue;
        if (!Array.isArray(message.content))
            return invalid();
        const texts = [];
        for (const value of message.content) {
            const block = record(value);
            if (block?.type !== "text")
                continue;
            if (typeof block.text !== "string")
                return invalid();
            texts.push(block.text);
        }
        if (!texts.length || !texts.join("\n"))
            continue;
        const authorized = redact(texts.join("\n"));
        const points = Array.from(authorized);
        const shown = points.slice(0, SESSION_EVIDENCE_TEXT_CHARS);
        total++;
        messages.push(Object.freeze({ ordinal: total, assistant_text: shown.join(""), text_chars_observed: points.length,
            text_chars_shown: shown.length, text_chars_omitted: points.length - shown.length, preview_clipped: shown.length < points.length }));
        if (messages.length > DEFAULT_INSPECT_LINES)
            messages.shift();
    }
    const encode = () => Object.freeze({ content_scope: "assistant_visible_text_preview", source_scope: "last_recorded_branch",
        primary_text: "not_exported", order: "oldest_first", coverage: Object.freeze({ truncated: true, redacted: true, history_complete: false }),
        text_limit_chars: SESSION_EVIDENCE_TEXT_CHARS, messages_total: total, messages_shown: messages.length, messages_omitted: total - messages.length,
        messages: Object.freeze([...messages]) });
    let preview = encode();
    while (messages.length && Buffer.byteLength(JSON.stringify(preview), "utf8") > SESSION_ASSISTANT_PREVIEW_MAX_BYTES) {
        messages.shift();
        preview = encode();
    }
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") > SESSION_ASSISTANT_PREVIEW_MAX_BYTES)
        return Object.freeze({ state: "unavailable", reason: "preview_too_large" });
    return Object.freeze({ state: "available", preview });
}
function previewUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** This policy is fixed in the kernel; serialized reference DTOs or actor visibility flags cannot widen it. */
export function readRunSessionPreview(stateDir, expected, query) {
    return readSelectedSessionPreview(stateDir, expected, query);
}
/** Internal projection data, not a new input capability: only the admitted writer supplies original Recipe privacy. */
function readSelectedSessionPreview(stateDir, expected, query, recipePrivacy) {
    const request = record(query);
    if (!request || Object.getOwnPropertyDescriptor(request, "kind")?.value !== "session")
        return previewUnavailable("request_invalid");
    const admitted = readRunExecutionReference(stateDir, expected, query);
    if (admitted.state === "unavailable")
        return admitted;
    try {
        const metaPath = join(stateDir, "run.json");
        const before = lstatSync(metaPath, { bigint: true });
        if (!before.isFile() || before.size > BigInt(RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES))
            return previewUnavailable("session_metadata_unavailable");
        const reading = readJsonFileResilient(metaPath, undefined, { maxBytes: RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES, strictUtf8: true });
        const meta = record(reading.value);
        if (!admitted.unchanged() || !sameFile(before, lstatSync(metaPath, { bigint: true })))
            return previewUnavailable("observation_changed");
        if (reading.diagnostics.length || !meta || meta.run !== admitted.identity.run || meta.run_instance_id !== admitted.identity.run_instance_id ||
            meta.ownerId !== admitted.identity.ownerId || meta.state_dir !== resolve(stateDir))
            return previewUnavailable("session_metadata_unavailable");
        if (recipePrivacy && !createContextIdentityPrivacyCheck(recipePrivacy)({ source_updated_at: admitted.source_updated_at })) {
            return previewUnavailable("session_metadata_redacted");
        }
        const source = readExecutionSessionText(stateDir, admitted.reference.path);
        if (!admitted.unchanged())
            return previewUnavailable("observation_changed");
        if (source.availability === "unavailable")
            return previewUnavailable(source.reason === "reference_too_large" ? "session_too_large"
                : source.reason === "reference_invalid_text" ? "session_invalid" : "session_unavailable");
        const unchanged = () => {
            try {
                return admitted.unchanged() && source.reference.unchanged() && sameFile(before, lstatSync(metaPath, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!unchanged())
            return previewUnavailable("observation_changed");
        const projected = recipePrivacy ? projectSessionAssistantPreview(source.text, recipePrivacy, createRunRecipeBodyRedactor(recipePrivacy, Number.MAX_SAFE_INTEGER))
            : projectSessionAssistantPreview(source.text, meta);
        if (projected.state === "unavailable")
            return projected;
        if (!unchanged())
            return previewUnavailable("observation_changed");
        const result = Object.freeze({ state: "available", identity: admitted.identity, command_id: admitted.reference.command_id,
            source_updated_at: admitted.source_updated_at, preview: projected.preview, unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > SESSION_ASSISTANT_PREVIEW_MAX_BYTES)
            return previewUnavailable("preview_too_large");
        return result;
    }
    catch {
        return previewUnavailable("session_unavailable");
    }
}
// --- Publication and selected exported previews ---
export const RUN_CONTEXT_SESSIONS_MAX_BYTES = 64 * 1024;
const PREVIEW_SCHEMA = "run-context-session-preview-v1";
const CATALOG_SCHEMA = "run-context-sessions-v1";
const COVERAGE = Object.freeze({ truncated: true, redacted: true, history_complete: false });
function previewMetadata(entry) {
    return { export_id: entry.export_id, command_id: entry.command_id, captured_at: entry.captured_at,
        ...(typeof entry.path === "string" ? { path: entry.path } : {}) };
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
function known(value, keys) { return Object.keys(value).every(key => keys.includes(key)); }
function count(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function command(value) { return typeof value === "string" && /^command-[0-9]{3,}$/u.test(value) && Number.isSafeInteger(Number(value.slice(8))) && Number(value.slice(8)) > 0; }
function timestamp(value) { const time = typeof value === "string" ? Date.parse(value) : NaN; return Number.isSafeInteger(time) && new Date(time).toISOString() === value; }
function coverage(value) { const item = record(value); return !!item && known(item, ["truncated", "redacted", "history_complete"]) && item.truncated === true && item.redacted === true && item.history_complete === false; }
function sameObject(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a, b) { return b.isFile() && sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function stamp(path) { try {
    return lstatSync(path, { bigint: true });
}
catch (error) {
    if (error.code === "ENOENT")
        return undefined;
    throw error;
} }
function previewPath(id) { return `evidence/sessions/session-${id}.json`; }
function selection(value) {
    const source = record(value);
    if (!source || !known(source, ["kind", "command_id", "path"]))
        return undefined;
    const own = (key) => Object.getOwnPropertyDescriptor(source, key)?.value;
    const id = own("command_id");
    const path = own("path");
    return own("kind") === "session" && command(id) && typeof path === "string" && !!path ? Object.freeze({ kind: "session", command_id: id, path }) : undefined;
}
function bound(value, schema, binding) {
    return value.schema === schema && value.run === binding.run && value.run_instance_id === binding.runInstanceId;
}
function readBounded(path) {
    const before = stamp(path);
    if (!before?.isFile() || before.size > BigInt(RUN_CONTEXT_SESSIONS_MAX_BYTES))
        return undefined;
    const read = readJsonFileResilient(path, undefined, { maxBytes: RUN_CONTEXT_SESSIONS_MAX_BYTES, strictUtf8: true });
    const value = record(read.value);
    const after = stamp(path);
    return !read.diagnostics.length && value && after && sameFile(before, after) ? { value, stamp: after } : undefined;
}
function validPreview(value) {
    const view = record(value);
    if (!view || !known(view, ["content_scope", "source_scope", "primary_text", "order", "coverage", "text_limit_chars", "messages_total", "messages_shown", "messages_omitted", "messages"]) ||
        view.content_scope !== "assistant_visible_text_preview" || view.source_scope !== "last_recorded_branch" || view.primary_text !== "not_exported" || view.order !== "oldest_first" ||
        !coverage(view.coverage) || view.text_limit_chars !== SESSION_EVIDENCE_TEXT_CHARS || !count(view.messages_total) || !count(view.messages_shown) || !count(view.messages_omitted) ||
        !Array.isArray(view.messages) || view.messages.length > DEFAULT_INSPECT_LINES || view.messages.length !== view.messages_shown || view.messages_shown + view.messages_omitted !== view.messages_total)
        return false;
    let ordinal = 0;
    for (const value of view.messages) {
        const row = record(value);
        if (!row || !known(row, ["ordinal", "assistant_text", "text_chars_observed", "text_chars_shown", "text_chars_omitted", "preview_clipped"]) ||
            !count(row.ordinal) || row.ordinal <= ordinal || row.ordinal > view.messages_total || typeof row.assistant_text !== "string" || !count(row.text_chars_observed) ||
            !count(row.text_chars_shown) || !count(row.text_chars_omitted) || row.text_chars_shown > SESSION_EVIDENCE_TEXT_CHARS || Array.from(row.assistant_text).length !== row.text_chars_shown ||
            row.text_chars_shown + row.text_chars_omitted !== row.text_chars_observed || row.preview_clipped !== (row.text_chars_omitted > 0))
            return false;
        ordinal = row.ordinal;
    }
    return true;
}
function inspectPreview(root, base, binding) {
    try {
        for (const directory of [join(root, "evidence"), join(root, "evidence", "sessions")]) {
            const current = stamp(directory);
            if (!current?.isDirectory() || current.isSymbolicLink())
                return undefined;
        }
        const relative = previewPath(base.export_id);
        const path = join(root, relative);
        const read = readBounded(path);
        if (!read)
            return undefined;
        const view = read.value;
        if (!bound(view, PREVIEW_SCHEMA, binding) || !known(view, ["schema", "run", "run_instance_id", "command_id", "export_id", "captured_at", "source_updated_at", "coverage", "preview"]) ||
            view.command_id !== base.command_id || view.export_id !== base.export_id || !timestamp(view.captured_at) || !timestamp(view.source_updated_at) || !coverage(view.coverage) || !validPreview(view.preview))
            return undefined;
        const parsed = view.preview;
        const preview = Object.freeze({ ...parsed, coverage: COVERAGE, messages: Object.freeze(parsed.messages.map(message => Object.freeze({ ...message }))) });
        return { path, stamp: read.stamp, preview, entry: Object.freeze({ export_id: base.export_id, command_id: base.command_id, captured_at: view.captured_at,
                availability: "available", path: relative, media_type: "application/json", bytes_total: Number(read.stamp.size), mutable: true, coverage: COVERAGE }) };
    }
    catch {
        return undefined;
    }
}
function readCatalog(root, binding) {
    const evidence = stamp(join(root, "evidence"));
    if (evidence && (!evidence.isDirectory() || evidence.isSymbolicLink()))
        throw new Error("Run session catalog directory is unavailable or invalid.");
    const path = join(root, runContextExportPath("sessions"));
    const existing = stamp(path);
    if (!existing)
        return { entries: [] };
    const read = readBounded(path);
    const value = read?.value;
    const invalid = () => new Error("Run session catalog is unavailable, invalid or belongs to another generation.");
    if (!read || !value || !bound(value, CATALOG_SCHEMA, binding) || !known(value, ["schema", "run", "run_instance_id", "updated_at", "inventory_scope", "inventory_complete", "coverage", "previews_total", "previews"]) ||
        !timestamp(value.updated_at) || value.inventory_scope !== "published_previews" || value.inventory_complete !== false || !coverage(value.coverage) ||
        !Array.isArray(value.previews) || value.previews_total !== value.previews.length)
        throw invalid();
    const ids = new Set();
    const entries = [];
    for (const item of value.previews) {
        const row = record(item);
        if (!row || typeof row.export_id !== "string" || !/^[a-f0-9]{64}$/u.test(row.export_id) || ids.has(row.export_id) || !command(row.command_id) || !timestamp(row.captured_at))
            throw invalid();
        ids.add(row.export_id);
        const base = { export_id: row.export_id, command_id: row.command_id, captured_at: row.captured_at };
        if (row.availability === "available" && known(row, ["export_id", "command_id", "captured_at", "availability", "path", "media_type", "bytes_total", "mutable", "coverage"]) &&
            row.path === previewPath(row.export_id) && row.media_type === "application/json" && count(row.bytes_total) && row.bytes_total <= RUN_CONTEXT_SESSIONS_MAX_BYTES && row.mutable === true && coverage(row.coverage)) {
            entries.push(Object.freeze({ ...base, availability: "available", path: row.path, media_type: "application/json", bytes_total: row.bytes_total, mutable: true, coverage: COVERAGE }));
        }
        else if (row.availability === "unavailable" && known(row, ["export_id", "command_id", "captured_at", "availability", "path", "reason"]) && row.path === null && row.reason === "preview_export_unavailable") {
            entries.push(Object.freeze({ ...base, availability: "unavailable", path: null, reason: "preview_export_unavailable" }));
        }
        else
            throw invalid();
    }
    return { entries, stamp: read.stamp };
}
function directory(path) {
    let value = stamp(path);
    if (!value) {
        mkdirSync(path);
        value = lstatSync(path, { bigint: true });
    }
    if (!value.isDirectory() || value.isSymbolicLink())
        throw new Error("Run session export directory is unavailable or invalid.");
    return value;
}
function targetUnchanged(path, expected) { const current = stamp(path); return expected ? !!current && sameFile(expected, current) : current === undefined; }
/** A real producer is required for both privacy capture and each subsequent evidence commit. */
export function writeRunSessionContextExport(stateDir, producer, query) {
    const captured = withRunProducerEvidence(stateDir, producer, () => {
        const selected = selection(query);
        if (!selected)
            return { status: "unavailable", reason: "request_invalid" };
        const recipePrivacy = readRunProducerCapturedMetadata(producer, RUN_CONTEXT_SOURCE_METADATA_MAX_BYTES);
        if (!recipePrivacy)
            return { status: "unavailable", reason: "session_admission_unavailable" };
        const identity = { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId !== undefined ? { ownerId: producer.ownerId } : {}) };
        const metadataUnredacted = createContextIdentityPrivacyCheck(recipePrivacy);
        if (!metadataUnredacted(identity))
            return { status: "unavailable", reason: "session_identity_redacted" };
        if (!metadataUnredacted({ command_id: selected.command_id }))
            return { status: "unavailable", reason: "session_metadata_redacted" };
        const read = readSelectedSessionPreview(stateDir, identity, selected, recipePrivacy);
        if (read.state === "unavailable")
            return { status: "unavailable", reason: read.reason };
        const id = createHash("sha256").update(JSON.stringify([selected.command_id, selected.path])).digest("hex");
        const capturedAt = new Date().toISOString();
        const base = { export_id: id, command_id: selected.command_id, captured_at: capturedAt };
        if (!metadataUnredacted(previewMetadata({ ...base, path: previewPath(id) })))
            return { status: "unavailable", reason: "session_metadata_redacted" };
        const content = JSON.stringify({ schema: PREVIEW_SCHEMA, run: producer.run, run_instance_id: producer.runInstanceId, command_id: selected.command_id,
            export_id: id, captured_at: capturedAt, source_updated_at: read.source_updated_at, coverage: COVERAGE, preview: read.preview }, null, 2) + "\n";
        if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_SESSIONS_MAX_BYTES)
            return { status: "unavailable", reason: "session_view_too_large" };
        return { status: "captured", content, base, unchanged: read.unchanged, metadataUnredacted };
    });
    if (captured.status === "unavailable")
        return Object.freeze(captured);
    return withRunProducerEvidence(stateDir, producer, () => {
        const owner = readRunContextIdentity(stateDir, { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId !== undefined ? { ownerId: producer.ownerId } : {}) });
        if (owner.state === "unavailable" || !captured.unchanged())
            throw new Error("Run session export source or generation changed.");
        const root = owner.local_path;
        const evidencePath = join(root, "evidence");
        const evidence = directory(evidencePath);
        const prior = readCatalog(root, producer);
        const retained = prior.entries.find(entry => entry.export_id === captured.base.export_id);
        if (retained && retained.command_id !== captured.base.command_id)
            throw new Error("Run session catalog binding contradicts the selected preview.");
        // Only these bound peer fields survive every observation; old times/paths may legitimately refresh or disappear.
        if (prior.entries.some(entry => entry.export_id !== captured.base.export_id &&
            !captured.metadataUnredacted({ export_id: entry.export_id, command_id: entry.command_id }))) {
            return Object.freeze({ status: "unavailable", reason: "session_metadata_redacted" });
        }
        const previewDirectory = join(evidencePath, "sessions");
        const previews = directory(previewDirectory);
        const frameUnchanged = () => {
            const currentEvidence = lstatSync(evidencePath, { bigint: true });
            const currentPreviews = lstatSync(previewDirectory, { bigint: true });
            return owner.unchanged() && currentEvidence.isDirectory() && sameObject(evidence, currentEvidence) && currentPreviews.isDirectory() && sameObject(previews, currentPreviews);
        };
        const path = join(root, previewPath(captured.base.export_id));
        const target = stamp(path);
        if (target && !inspectPreview(root, captured.base, producer))
            throw new Error("Run session preview binding is unavailable or invalid.");
        writeTextAtomic(path, captured.content, { onBeforeReplace() {
                if (!frameUnchanged() || !captured.unchanged() || !targetUnchanged(path, target))
                    throw new Error("Run session export binding or source changed before publication.");
            } });
        const bases = [...prior.entries.filter(entry => entry.export_id !== captured.base.export_id), captured.base];
        const observations = [];
        const entries = bases.map(base => {
            const observed = inspectPreview(root, base, producer);
            if (observed) {
                observations.push(observed);
                return observed.entry;
            }
            return Object.freeze({ export_id: base.export_id, command_id: base.command_id, captured_at: base.captured_at, availability: "unavailable", path: null, reason: "preview_export_unavailable" });
        });
        if (!observations.some(observed => observed.entry.export_id === captured.base.export_id))
            throw new Error("Run session preview binding changed after publication.");
        // The selected preview may already be committed; preserve it and the prior catalog on this distinct refusal.
        if (entries.some(entry => !captured.metadataUnredacted(previewMetadata(entry)))) {
            return Object.freeze({ status: "unavailable", reason: "session_metadata_redacted" });
        }
        const content = JSON.stringify({ schema: CATALOG_SCHEMA, run: producer.run, run_instance_id: producer.runInstanceId, updated_at: captured.base.captured_at,
            inventory_scope: "published_previews", inventory_complete: false, coverage: COVERAGE, previews_total: entries.length, previews: entries }, null, 2) + "\n";
        if (Buffer.byteLength(content, "utf8") > RUN_CONTEXT_SESSIONS_MAX_BYTES)
            throw new Error("Run session catalog exceeds its bounded metadata limit.");
        const catalogPath = join(root, runContextExportPath("sessions"));
        writeTextAtomic(catalogPath, content, { onBeforeReplace() {
                if (!frameUnchanged() || !captured.unchanged() || !targetUnchanged(catalogPath, prior.stamp) || observations.some(view => !sameFile(view.stamp, lstatSync(view.path, { bigint: true })))) {
                    throw new Error("Run session catalog references or source changed before publication.");
                }
            } });
        const entry = Object.freeze({ availability: "available", path: runContextExportPath("sessions"), media_type: "application/json", bytes_total: Buffer.byteLength(content, "utf8"), mutable: true, coverage: COVERAGE });
        return Object.freeze({ status: "written", captured_at: captured.base.captured_at, entry });
    });
}
/** Preview, catalog and context index are separate effects; no failed phase rolls earlier commits back. */
export function writeRunSessionContextIndex(stateDir, producer, query) {
    const view = writeRunSessionContextExport(stateDir, producer, query);
    return withRunProducerEvidence(stateDir, producer, () => {
        if (view.status === "written") {
            const catalog = readCatalog(stateDir, producer);
            for (const entry of catalog.entries) {
                if (entry.availability !== "available")
                    continue;
                const observed = inspectPreview(stateDir, entry, producer);
                if (!observed || observed.entry.bytes_total !== entry.bytes_total || observed.entry.captured_at !== entry.captured_at) {
                    throw new Error("Run session catalog references changed before index publication.");
                }
            }
        }
        const entry = view.status === "written" ? view.entry : view.reason === "manifest_absent" ? { availability: "pending", path: null } : { availability: "unavailable", path: null, reason: view.reason };
        const publication = writeRunContextIndexUnderLock(stateDir, { run: producer.run, run_instance_id: producer.runInstanceId, ...(producer.ownerId !== undefined ? { ownerId: producer.ownerId } : {}) }, { sessions: entry });
        return Object.freeze({ status: "published", ...publication });
    });
}
function readUnavailable(reason) { return Object.freeze({ state: "unavailable", reason }); }
/** Read only the selected published body: index metadata never substitutes for nested format/generation admission. */
export function readRunSessionContextPreview(stateDir, expected, exportId) {
    if (typeof exportId !== "string" || !/^[a-f0-9]{64}$/u.test(exportId))
        return readUnavailable("selection_invalid");
    const owner = readRunContextIdentity(stateDir, expected);
    if (owner.state === "unavailable")
        return readUnavailable(owner.reason);
    try {
        const root = owner.local_path;
        const indexPath = join(root, RUN_CONTEXT_INDEX_FILE);
        const indexBefore = stamp(indexPath);
        if (!indexBefore?.isFile())
            return readUnavailable("index_unavailable");
        const evidencePath = join(root, "evidence");
        const evidence = stamp(evidencePath);
        if (!evidence?.isDirectory() || evidence.isSymbolicLink())
            return readUnavailable("sessions_unavailable");
        const catalogPath = join(root, runContextExportPath("sessions"));
        const catalogBefore = stamp(catalogPath);
        const indexed = readRunContextIndex(root, owner.identity);
        if (!owner.unchanged() || !targetUnchanged(indexPath, indexBefore))
            return readUnavailable("observation_changed");
        if (indexed.state === "unavailable")
            return readUnavailable("index_unavailable");
        const role = indexed.index.entries.sessions;
        if (role.availability !== "available" || role.mutable !== true || !coverage(role.coverage))
            return readUnavailable("sessions_unavailable");
        if (!catalogBefore?.isFile() || catalogBefore.size !== BigInt(role.bytes_total))
            return readUnavailable("catalog_unavailable");
        const binding = { run: owner.identity.run, runInstanceId: owner.identity.run_instance_id };
        const catalog = readCatalog(root, binding);
        if (!catalog.stamp || !sameFile(catalogBefore, catalog.stamp))
            return readUnavailable("observation_changed");
        const selected = catalog.entries.find(entry => entry.export_id === exportId);
        if (!selected)
            return readUnavailable("preview_not_listed");
        if (selected.availability !== "available")
            return readUnavailable("preview_unavailable");
        const previewDirectory = join(evidencePath, "sessions");
        const previews = stamp(previewDirectory);
        if (!previews?.isDirectory() || previews.isSymbolicLink())
            return readUnavailable("preview_invalid");
        const observed = inspectPreview(root, selected, binding);
        if (!observed || observed.entry.bytes_total !== selected.bytes_total || observed.entry.captured_at !== selected.captured_at)
            return readUnavailable("preview_invalid");
        const unchanged = () => {
            try {
                const currentEvidence = lstatSync(evidencePath, { bigint: true });
                const currentPreviews = lstatSync(previewDirectory, { bigint: true });
                return owner.unchanged() && targetUnchanged(indexPath, indexBefore) && targetUnchanged(catalogPath, catalog.stamp) &&
                    currentEvidence.isDirectory() && sameObject(evidence, currentEvidence) && currentPreviews.isDirectory() && sameObject(previews, currentPreviews) &&
                    sameFile(observed.stamp, lstatSync(observed.path, { bigint: true }));
            }
            catch {
                return false;
            }
        };
        if (!unchanged())
            return readUnavailable("observation_changed");
        const result = Object.freeze({ state: "available", identity: owner.identity, export_id: selected.export_id, command_id: selected.command_id,
            captured_at: selected.captured_at, path: observed.entry.path, media_type: observed.entry.media_type, bytes_total: observed.entry.bytes_total,
            mutable: observed.entry.mutable, coverage: COVERAGE, preview: observed.preview, unchanged });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RUN_CONTEXT_SESSIONS_MAX_BYTES)
            return readUnavailable("preview_too_large");
        return result;
    }
    catch {
        return readUnavailable("catalog_unavailable");
    }
}
