/**
 * Shared response formatting.
 * Zones: compact text summaries, snapshot/literal rendering, JSON switching, next-action rendering.
 * Owns model-facing formatting shared by tool and coordinator delivery paths.
 * Excludes: evidence reads/admission, source visibility, clock measurement and lifecycle/delivery authority.
 */
import { Document, isScalar, visit } from "yaml";
import * as Limits from "./limits.js";
function yamlMetadataText(value) {
    const document = new Document(value, { version: "1.2", schema: "core", aliasDuplicateObjects: false });
    // yaml's plain-key preference otherwise treats a leading BOM as document whitespace.
    visit(document, { Pair(_key, pair) {
            if (isScalar(pair.key) && typeof pair.key.value === "string" && pair.key.value.includes("\uFEFF"))
                pair.key.type = "QUOTE_DOUBLE";
        } });
    return document.toString({ collectionStyle: "block", indent: 2, lineWidth: 0, directives: false,
        defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE", doubleQuotedAsJSON: true });
}
/** Pure selected-metadata formatting, not admission or authority. */
export function renderYamlMetadata(value, byteBudget) {
    // Execution ceiling, not a caller allowance. The caller still owns its smaller policy budget.
    if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0 || byteBudget > 49152)
        return { state: "unavailable", reason: "budget_invalid" };
    let remaining = byteBudget;
    let reason = "metadata_invalid";
    const active = new Set();
    const charge = (bytes) => {
        remaining -= bytes;
        if (remaining >= 0)
            return true;
        reason = "metadata_too_large";
        return false;
    };
    const string = (text) => {
        if (text.length > remaining) {
            reason = "metadata_too_large";
            return false;
        }
        return text.isWellFormed() && charge(Buffer.byteLength(text, "utf8"));
    };
    const copy = (input, depth) => {
        if (!charge(1))
            return undefined;
        if (typeof input === "string")
            return string(input) ? { value: input } : undefined;
        if (input === null || typeof input === "boolean")
            return { value: input };
        // Refuse -0 explicitly: default YAML numeric serialization would erase its sign.
        if (typeof input === "number")
            return Number.isFinite(input) && !Object.is(input, -0) ? { value: input } : undefined;
        if (!input || typeof input !== "object")
            return undefined;
        // Small explicit supported-input ceiling protects the library's recursive AST/stringifier.
        if (depth > 64 || active.has(input))
            return undefined;
        const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
            return undefined;
        active.add(input);
        const result = array ? [] : Object.create(null);
        const length = array ? Object.getOwnPropertyDescriptor(input, "length") : undefined;
        if (array && (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value) || length.value < 0))
            return undefined;
        if (array && length.value > remaining) {
            reason = "metadata_too_large";
            return undefined;
        }
        let count = 0;
        // ownKeys is necessarily atomic reflection; descriptor/value walks stop at the budget.
        for (const key of Reflect.ownKeys(input)) {
            if (array && key === "length")
                continue;
            if (typeof key !== "string" || (array && key !== String(count)))
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
                return undefined;
            if (!array && !string(key))
                return undefined;
            const child = copy(descriptor.value, depth + 1);
            if (!child)
                return undefined;
            Object.defineProperty(result, key, { value: child.value, enumerable: true, configurable: true, writable: true });
            count++;
        }
        if (array && count !== length.value)
            return undefined;
        active.delete(input);
        return { value: result };
    };
    try {
        if (!value || typeof value !== "object")
            return { state: "unavailable", reason: "metadata_invalid" };
        const copied = copy(value, 0);
        if (!copied)
            return { state: "unavailable", reason };
        const text = yamlMetadataText(copied.value);
        return Buffer.byteLength(text, "utf8") <= byteBudget ? { state: "available", text } : { state: "unavailable", reason: "metadata_too_large" };
    }
    catch {
        return { state: "unavailable", reason: "metadata_invalid" };
    }
}
/** One selected metadata node, kept whole or covered by a field/group omission. */
export function selectYamlNode(key, value, byteBudget, total = 1) {
    const full = { [key]: value };
    const complete = renderYamlMetadata(full, byteBudget);
    const invalid = complete.state === "unavailable" && complete.reason === "metadata_invalid";
    const omitted = { [key]: invalid ? "[unavailable]" : "[omitted]",
        [key + "_omission"]: { reason: invalid ? "invalid_selected_metadata" : "response_too_large", shown: 0, omitted: total, total } };
    const fallback = renderYamlMetadata(omitted, byteBudget);
    // Seed the shorter complete-or-omitted form: omission scaffolding must never manufacture overflow.
    const selected = complete.state === "available" && fallback.state === "available" &&
        Buffer.byteLength(complete.text) <= Buffer.byteLength(fallback.text) ? full : omitted;
    return { full: invalid ? omitted : full, selected };
}
/** Opaque selected text or string sequence; malformed selections stay unavailable without repair. */
export function selectYamlField(key, value, byteBudget) {
    const values = typeof value === "string" ? [value] : value;
    if (values.every(item => item.isWellFormed()))
        return selectYamlNode(key, typeof value === "string" ? value : [...value], byteBudget, typeof value === "string" ? 1 : value.length);
    const total = typeof value === "string" ? 1 : value.length;
    const omitted = { [key]: "[unavailable]",
        [key + "_omission"]: { reason: "malformed_selected_text", shown: 0, omitted: total, total } };
    return { full: omitted, selected: omitted };
}
/** Grow whole selected fields in priority order while the complete document still fits. */
export function growYamlDocument(render, order, byteBudget) {
    const fits = () => renderYamlMetadata(render(), byteBudget).state === "available";
    for (const part of order) {
        if (part.selected === part.full)
            continue;
        const previous = part.selected;
        part.selected = part.full;
        if (!fits())
            part.selected = previous;
    }
    const rendered = renderYamlMetadata(render(), byteBudget);
    if (rendered.state !== "available")
        throw new Error("Selected YAML metadata document is unavailable: " + rendered.reason);
    return rendered.text;
}
/** Uncapped UI-only flat metadata; never borrow a model-output allowance for notices. */
export function formatYamlNotice(value) {
    const selected = {};
    for (const [key, field] of Object.entries(value)) {
        if (typeof field === "string" && !field.isWellFormed()) {
            selected[key] = "[unavailable]";
            selected[key + "_omission"] = { reason: "malformed_selected_text", shown: 0, omitted: 1, total: 1 };
        }
        else
            selected[key] = field;
    }
    return yamlMetadataText(selected).replace(/\n$/u, "");
}
/** Close one rendered YAML header; a separate opaque body gets exactly one delimiter pair. */
export function frameMetadataDocument(header, body) {
    return body === undefined ? header : `---\n${header}---\n${body}`;
}
export function formatMarkdownField(key, value, depth = 0) {
    const indent = "  ".repeat(depth);
    return /[\r\n]/u.test(value)
        ? `${indent}- ${key}:\n${indent}  ${value.replaceAll(/\r\n|\r|\n/gu, newline => `${newline}${indent}  `)}`
        : `${indent}- ${key}: ${value}`;
}
export function formatInspectNextAction(target, view, verbose) {
    return ["- next:", formatMarkdownField("tool", "inspect", 1), formatMarkdownField("target", target, 1),
        formatMarkdownField("view", view, 1), ...(verbose === undefined ? [] : [formatMarkdownField("verbose", String(verbose), 1)])].join("\n");
}
export function formatLiteralBlock(value) {
    let length = 3;
    for (const run of value.matchAll(/`+/gu))
        length = Math.max(length, run[0].length + 1);
    const fence = "`".repeat(length);
    return `${fence}text\n${value}\n${fence}`;
}
/** Pure formatting of already-admitted snapshots. DTO/schema validity is NOT source, timing, visibility or lifecycle authority. */
export function renderRunSnapshot(value, format = "text") {
    const unavailable = (reason) => Object.freeze({ state: "unavailable", reason });
    if (format !== "text" && format !== "json")
        return unavailable("format_invalid");
    if (!value || typeof value !== "object" || Array.isArray(value))
        return unavailable("snapshot_invalid");
    const fields = Object.create(null);
    for (const key of ["kind", "run", "run_instance_id", "captured_at", "elapsed_ms", "status", "phase", "cwd", "evidence", "evidence_error"]) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field) {
            if (key !== "phase" && key !== "evidence_error")
                return unavailable("snapshot_invalid");
            continue;
        }
        if (!Object.hasOwn(field, "value"))
            return unavailable("snapshot_invalid");
        if (typeof field.value === "string" && field.value.length > Limits.RUN_DELIVERY_MODEL_MAX_BYTES)
            return unavailable("snapshot_too_large");
        fields[key] = field.value;
    }
    const { kind, run, run_instance_id, captured_at, elapsed_ms, status, phase, cwd, evidence, evidence_error } = fields;
    const scalar = (text) => typeof text === "string" && text.length > 0 && Buffer.from(text).toString("utf8") === text;
    const reference = (text) => scalar(text) && !/[\u0000-\u001f\u007f]/u.test(text);
    if (evidence !== null && !reference(evidence))
        return unavailable("snapshot_invalid");
    if (kind !== "run_snapshot" || !scalar(run) || /[^A-Za-z0-9_.-]/u.test(run) || !scalar(run_instance_id) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(run_instance_id) ||
        !scalar(captured_at) || !Number.isSafeInteger(Date.parse(captured_at)) || new Date(Date.parse(captured_at)).toISOString() !== captured_at ||
        typeof elapsed_ms !== "number" || !Number.isSafeInteger(elapsed_ms) || elapsed_ms < 0 || (status !== "running" && status !== "done" && status !== "failed") ||
        (phase !== undefined && (status !== "running" || phase !== "stopping")) || !reference(cwd) ||
        (evidence === null ? evidence_error !== "index_unavailable" : evidence_error !== undefined))
        return unavailable("snapshot_invalid");
    const snapshot = Object.freeze({ kind, run, run_instance_id, captured_at, elapsed_ms, status,
        ...(phase === "stopping" ? { phase } : {}), cwd, evidence,
        ...(evidence === null ? { evidence_error: "index_unavailable" } : {}) });
    // Compact JSON preserves the same bounded payload without a second pretty-print allowance or implicit fallback.
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES)
        return unavailable("snapshot_too_large");
    const text = format === "json" ? json
        : `run:${snapshot.run} · ${snapshot.status}${snapshot.phase ? ` (${snapshot.phase})` : ""} · elapsed=${snapshot.elapsed_ms}ms\ngeneration:\n${formatLiteralBlock(snapshot.run_instance_id)}` +
            `\ncaptured_at: ${snapshot.captured_at}\ncwd:\n${formatLiteralBlock(snapshot.cwd)}\nevidence:${snapshot.evidence === null ? " unavailable (index_unavailable)" : `\n${formatLiteralBlock(snapshot.evidence)}`}`;
    return Buffer.byteLength(text, "utf8") > Limits.RUN_DELIVERY_MODEL_MAX_BYTES ? unavailable("render_too_large") : Object.freeze({ state: "available", text });
}
export function withLeadingLineBreak(text) {
    return `\n${text.replace(/^\n+/, "")}`;
}
export function spaceToolResult(result) {
    if (!result || typeof result !== "object")
        return result;
    const content = result.content;
    if (!Array.isArray(content))
        return result;
    return {
        ...result,
        content: content.map((item) => item &&
            typeof item === "object" &&
            item.type === "text" &&
            typeof item.text === "string"
            ? {
                ...item,
                text: withLeadingLineBreak(item.text),
            }
            : item),
    };
}
export function spaceToolError(error) {
    if (error instanceof Error) {
        error.message = withLeadingLineBreak(error.message);
        return error;
    }
    return new Error(withLeadingLineBreak(String(error)));
}
export function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
export function jsonText(value) {
    return `\n${JSON.stringify(value, null, 2)}`;
}
export function compactPreview(value, maxLength = Limits.COMPACT_PREVIEW_CHARS) {
    if (value === undefined)
        return undefined;
    const text = typeof value === "string" ? value : JSON.stringify(value, undefined, 0);
    const compact = text.replaceAll(/\s+/g, "_");
    return compact.length > maxLength
        ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
        : compact;
}
export function compactNextActions(actions) {
    return actions.length
        ? ` next=${actions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`
        : "";
}
function formatFailureCount(value) {
    return Array.isArray(value) ? value.length : undefined;
}
function launchModelPolicy(value) {
    const policy = asRecord(value), fields = {};
    for (const key of ["model", "thinking"]) {
        const axis = asRecord(policy[key]);
        if (typeof axis.source !== "string" || !axis.source || axis.source === "unused")
            continue;
        const source = axis.source;
        // Retain legacy coercion/error behavior for unstable getter-produced values.
        formatMarkdownField("source", source, 1);
        const selected = { source };
        if (typeof axis.value === "string" && axis.value.trim()) {
            const text = axis.value.trim();
            formatMarkdownField("value", text, 1);
            selected.value = text;
        }
        fields[key] = Object.values(selected).every(field => typeof field === "string" && field.isWellFormed())
            ? selected : { state: "unavailable", reason: "metadata_invalid" };
    }
    return fields;
}
const RUN_FILE_INVESTIGATION_COMMAND = "inspect target=runtime view=runs verbose=true";
/** Frozen older completion-format text: new launch layout must not change this shared packet helper. */
export function formatRunFileNavigationHandoff() {
    return `Files (optional; current session):\n\`${RUN_FILE_INVESTIGATION_COMMAND}\``;
}
export function runNextActions(run) {
    const id = String(run ?? "").trim();
    if (!id)
        return [];
    return [
        `inspect target=run:${id} view=recipe`,
        `inspect target=run:${id} view=trace`,
        `inspect target=run:${id} view=control`,
        RUN_FILE_INVESTIGATION_COMMAND,
    ];
}
export function compactAsyncRunStatus(value) {
    const status = asRecord(value), progress = asRecord(status.progress), result = asRecord(status.result);
    const run = String(status.run ?? "<unknown>"), displayRun = run.startsWith("run:") ? run.slice(4) : run;
    const core = { run: displayRun, state: String(status.status ?? "unknown") };
    if (status.launch_kind)
        core.launch_kind = String(status.launch_kind);
    if (status.reused === true)
        core.launch = "existing Run reused";
    const catalog = asRecord(status.catalog_registration);
    if (catalog.state === "unavailable" && catalog.reason === "catalog_registration_failed")
        core.catalog = "unavailable";
    const fields = { ...core, ...launchModelPolicy(status.model_policy ?? progress.model_policy) };
    for (const key of ["tool", "recipe", "retire_when"])
        if (status[key])
            fields[key] = String(status[key]);
    if (Number(status.pid) > 0)
        fields.pid = Number(status.pid);
    if (progress.phase && progress.phase !== status.status)
        fields.phase = String(progress.phase);
    if (Number(progress.activeSubagents) > 0)
        fields.active_subagents = Number(progress.activeSubagents);
    if (Number(progress.completed) > 0)
        fields.completed = Number(progress.completed);
    const failures = formatFailureCount(progress.failures);
    if (failures !== undefined && failures > 0)
        fields.failures = failures;
    if (result.code !== undefined) {
        const code = result.code, text = String(code);
        fields.code = typeof code === "number" || typeof code === "boolean" ? code : text;
    }
    if (result.killed === true)
        fields.killed = true;
    if (status.draft_recipe)
        fields.draft_recipe = String(status.draft_recipe);
    const hint = { file_investigation: "optional; current session", next: { tool: "inspect", target: "runtime", view: "runs", verbose: true } };
    const hasNavigation = Object.hasOwn(status, "file_navigation");
    let navigation;
    if (hasNavigation) {
        // Preserve the original JSON selection (including hooks and thrown errors), once only.
        const json = JSON.stringify(status.file_navigation ?? { state: "unavailable", reason: "navigation_unavailable" });
        if (json === undefined)
            formatLiteralBlock(json);
        navigation = JSON.parse(json);
    }
    const direct = hasNavigation && asRecord(status.file_navigation).state === "available" && asRecord(navigation).state === "available";
    const budget = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - 1;
    const render = (metadata) => {
        const rendered = renderYamlMetadata(metadata, budget);
        return rendered.state === "available" ? withLeadingLineBreak(rendered.text) : undefined;
    };
    // Invalid selected scalars are unavailable whole values, never repaired strings/paths.
    for (const group of [core, fields]) {
        for (const key of Object.keys(group)) {
            const field = group[key];
            if ((typeof field === "string" && !field.isWellFormed()) ||
                (typeof field === "number" && (!Number.isFinite(field) || Object.is(field, -0)))) {
                group[key] = { state: "unavailable", reason: "metadata_invalid" };
            }
        }
    }
    // Validate only runtime-selected JSON facts, never walk the original navigation again.
    const navigationRendering = hasNavigation ? renderYamlMetadata({ run_files: navigation }, budget) : undefined;
    const invalidNavigation = navigationRendering?.state === "unavailable" && navigationRendering.reason === "metadata_invalid";
    const locations = !hasNavigation ? {} : { run_files: invalidNavigation
            ? { state: "unavailable", reason: "metadata_invalid" } : navigation,
        run_files_observation: "Observed locations; mutable." };
    const full = render({ ...fields, ...locations, ...(direct && !invalidNavigation ? {} : hint) });
    if (full !== undefined)
        return full;
    const omitted = !hasNavigation ? {} : { run_files: { state: "omitted", reason: "response_too_large", shown: 0, omitted: 1, total: 1 } };
    const withoutRow = render({ ...fields, ...omitted, ...hint });
    if (withoutRow !== undefined)
        return withoutRow;
    // Keep the original fallback observation order; no rereads on successful full receipts.
    const fallback = { ...core };
    if (typeof status.run_instance_id === "string") {
        const generation = status.run_instance_id;
        formatMarkdownField("run_instance_id", generation);
        fallback.run_instance_id = typeof generation === "string" && generation.isWellFormed()
            ? generation : { state: "unavailable", reason: "metadata_invalid" };
    }
    if (Number(status.pid) > 0) {
        const pid = Number(status.pid);
        fallback.pid = Number.isFinite(pid) && !Object.is(pid, -0) ? pid : { state: "unavailable", reason: "metadata_invalid" };
    }
    const omission = { launch_fields: "omitted", launch_omission: "response_too_large" };
    return render({ ...omission, ...fallback, ...omitted, ...hint }) ??
        render({ ...omission, ...omitted, ...hint });
}
export function maybeJsonText(value, verbose, compact) {
    return verbose ? jsonText(value) : compact;
}
function unavailableSpawnProjection(reason) {
    return `projection: unavailable\nreason: ${reason}\nwarning: "Full metadata is not shown. Launch or attachment processing preceded this projection; this is not a workload-failure or no-effects receipt. Do not repeat automatically."\n`;
}
/** Full spawn metadata retains legacy JSON selection; projection is not launch or source authority. */
export function spawnMetadataText(value, verbose, compact) {
    if (!verbose)
        return compact;
    // Original selection faults remain exact, outside the recoverable projection boundary.
    const selected = JSON.stringify(value, null, 2);
    if (selected === undefined)
        return `\n${unavailableSpawnProjection("yaml_projection_failed")}`;
    try {
        const clone = JSON.parse(selected), pending = [clone];
        // Only the JSON clone is walked; full metadata borrows no bounded emitter allowance.
        while (pending.length) {
            const current = pending.pop();
            if (typeof current === "string" && !current.isWellFormed())
                return `\n${unavailableSpawnProjection("malformed_selected_text")}`;
            if (current && typeof current === "object")
                for (const [key, child] of Object.entries(current)) {
                    if (!key.isWellFormed())
                        return `\n${unavailableSpawnProjection("malformed_selected_text")}`;
                    pending.push(child);
                }
        }
        return `\n${yamlMetadataText(clone)}`;
    }
    catch {
        return `\n${unavailableSpawnProjection("yaml_projection_failed")}`;
    }
}
export function compactRecipeImports(summary) {
    const active = Array.isArray(summary.active)
        ? summary.active
        : [];
    const lines = active.flatMap((entry) => {
        const imports = asRecord(entry.imports);
        return Object.entries(imports).map(([alias, value]) => {
            const binding = typeof value === "string" ? { from: value } : asRecord(value);
            return `recipe=${String(entry.id ?? "<unknown>")} alias=${alias} from=${String(binding.from ?? value)}`;
        });
    });
    return lines.length ? `\n${lines.join("\n")}` : "\n(no recipe imports)";
}
export function compactRecipeDoctor(summary) {
    const details = Array.isArray(summary.diagnostic_details)
        ? summary.diagnostic_details
        : [];
    const remediations = Array.isArray(summary.remediations)
        ? summary.remediations
        : [];
    const recommendations = Array.isArray(summary.recommendations)
        ? summary.recommendations
        : [];
    const riskSummary = Array.isArray(summary.risk_summary)
        ? summary.risk_summary
        : [];
    const counts = { error: 0, info: 0, warning: 0 };
    for (const detail of details) {
        const severity = String(detail.severity ?? "info");
        if (severity === "error" || severity === "warning" || severity === "info")
            counts[severity] += 1;
    }
    const riskCount = riskSummary.reduce((total, item) => total + Number(item.count ?? 0), 0);
    const topRisks = riskSummary
        .slice(0, 4)
        .map((item) => `${String(item.label)}:${String(item.count ?? 0)}`)
        .join(",");
    const topAction = asRecord(summary.top_action);
    const lines = [
        `recipes doctor errors=${counts.error} warnings=${counts.warning} info=${counts.info} actions=${remediations.length} recommendations=${recommendations.length} risks=${riskCount}${topRisks ? ` top_risks=${topRisks}` : ""}`,
    ];
    if (Object.keys(topAction).length > 0) {
        const action = compactPreview(topAction.action, Limits.DOCTOR_ACTION_PREVIEW_CHARS);
        lines.push(`top severity=${String(topAction.severity ?? "info")} kind=${String(topAction.kind ?? "inspect")} id=${String(topAction.id ?? "root")} action=${action ?? "inspect"}`);
    }
    for (const item of remediations.slice(0, 8)) {
        const action = compactPreview(item.action, Limits.DOCTOR_ACTION_PREVIEW_CHARS);
        const blocked = item.blocked_fallback
            ? ` blocked=${compactPreview(item.blocked_fallback, Limits.DOCTOR_ACTION_PREVIEW_CHARS)}`
            : "";
        const labels = Array.isArray(item.risk_labels)
            ? ` labels=${item.risk_labels.map(String).slice(0, 4).join(",")}`
            : "";
        lines.push(`${String(item.severity ?? "info")} kind=${String(item.kind ?? "inspect")} id=${String(item.id ?? "root")}${blocked}${labels} action=${action ?? "inspect"}`);
    }
    const nextActions = Array.isArray(summary.next_actions)
        ? summary.next_actions
        : [];
    if (nextActions.length > 0)
        lines[0] = `${lines[0]}${compactNextActions(nextActions)}`;
    return `\n${lines.join("\n")}`;
}
export function recipeRegistryNextActions(summary, view) {
    const actions = [];
    const drafts = Array.isArray(summary.drafts)
        ? summary.drafts
        : [];
    const invalid = Array.isArray(summary.invalid) ? summary.invalid.length : 0;
    const diagnostics = Array.isArray(summary.diagnostics)
        ? summary.diagnostics.length
        : 0;
    const topAction = asRecord(summary.top_action);
    if (view !== "doctor" && (invalid > 0 || diagnostics > 0)) {
        actions.push("inspect target=recipes view=doctor");
    }
    if (view === "doctor" && typeof topAction.action === "string") {
        actions.push(String(topAction.action));
    }
    if (summary.skill_recipe_catalog_partial === true) {
        actions.push("inspect target=recipes view=imports verbose=true");
    }
    if (drafts.length > 0) {
        actions.push("inspect target=recipes view=summary verbose=true");
        const firstPath = typeof drafts[0]?.path === "string" ? drafts[0].path : undefined;
        if (firstPath)
            actions.push(`spawn file=${firstPath}`);
    }
    return [...new Set(actions)].slice(0, 4);
}
/** Compact metadata-only document text: one leading LF, no trailing LF, shared emitter budget. */
export function compactYamlDocument(value) {
    const text = growYamlDocument(() => value, [], Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    return `\n${text.replace(/\n$/u, "")}`;
}
/** Only the closed read-only Recipe inspect literals become typed next; other advice stays opaque content. */
export function nextActionMetadata(action, byteBudget) {
    const recognized = [
        ["inspect target=recipes view=doctor", "doctor", false],
        ["inspect target=recipes view=imports verbose=true", "imports", true],
        ["inspect target=recipes view=summary verbose=true", "summary", true],
    ];
    const match = recognized.find(([literal]) => literal === action);
    if (match) {
        const typed = { next: { tool: "inspect", target: "recipes", view: match[1], ...(match[2] ? { verbose: true } : {}) } };
        return { full: typed, selected: typed };
    }
    const instruction = selectYamlField("instruction", action, byteBudget);
    return { full: { next: instruction.full }, selected: { next: instruction.selected } };
}
/** Only these existing read-only inspection hints become action nodes; other advice stays content. */
export function formatInspectionHint(action) {
    if (action === "inspect target=recipes view=doctor")
        return formatInspectNextAction("recipes", "doctor");
    if (action === "inspect target=recipes view=imports verbose=true")
        return formatInspectNextAction("recipes", "imports", true);
    if (action === "inspect target=recipes view=summary verbose=true")
        return formatInspectNextAction("recipes", "summary", true);
    return formatMarkdownField("instruction", action);
}
export function compactRecipeRegistry(summary) {
    const count = (key, source) => Array.isArray(source) ? source.length : 0;
    const active = count("active", summary.active), shadowed = count("shadowed", summary.shadowed);
    const invalid = count("invalid", summary.invalid), disabled = count("disabled", summary.disabled);
    const diagnostics = count("diagnostics", summary.diagnostics), drafts = count("drafts", summary.drafts);
    const recommendations = count("recommendations", summary.recommendations);
    const skillCatalogPartial = summary.skill_recipe_catalog_partial === true;
    const currentPolicy = Array.isArray(summary.active)
        ? summary.active.filter((entry) => entry.current_policy).length
        : 0;
    const nextActions = Array.isArray(summary.next_actions)
        ? summary.next_actions
        : [];
    const hint = nextActions.length ? nextActionMetadata(nextActions[0], Limits.RUN_DELIVERY_MODEL_MAX_BYTES) : undefined;
    const render = () => ({ recipes: "registry", active, drafts, shadowed, invalid, disabled,
        current_policy: currentPolicy, skill_catalog_partial: skillCatalogPartial, recommendations, diagnostics,
        ...(hint ? hint.selected : {}) });
    return hint
        ? `\n${growYamlDocument(render, [hint], Limits.RUN_DELIVERY_MODEL_MAX_BYTES).replace(/\n$/u, "")}`
        : compactYamlDocument(render());
}
export const DEFAULT_INSPECT_LINES = Limits.DEFAULT_INSPECT_LINES;
