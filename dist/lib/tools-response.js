/**
 * Public tool response formatting
 * Zones: compact text summaries, verbose JSON switching, next-action rendering
 * Owns model-facing response helpers shared by public tool execution paths
 */
import * as Limits from "./limits.js";
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
function compactPolicyAxis(label, value) {
    const axis = asRecord(value);
    const source = typeof axis.source === "string" ? axis.source : undefined;
    if (!source || source === "unused")
        return undefined;
    const renderedValue = typeof axis.value === "string" && axis.value.trim()
        ? `:${axis.value.trim()}`
        : "";
    return `${label}=${source}${renderedValue}`;
}
function compactModelPolicy(value) {
    const policy = asRecord(value);
    return [
        compactPolicyAxis("model", policy.model),
        compactPolicyAxis("thinking", policy.thinking),
    ].filter((token) => Boolean(token));
}
export function runNextActions(run) {
    const id = String(run ?? "").trim();
    if (!id)
        return [];
    return [
        `inspect target=run:${id} view=recipe`,
        `inspect target=run:${id} view=trace`,
        `inspect target=run:${id} view=control`,
    ];
}
export function compactAsyncRunStatus(value) {
    const status = asRecord(value);
    const progress = asRecord(status.progress);
    const result = asRecord(status.result);
    const run = String(status.run ?? "<unknown>");
    const tokens = [`run=${run}`, `status=${String(status.status ?? "unknown")}`];
    if (status.launch_kind)
        tokens.push(`launch_kind=${String(status.launch_kind)}`);
    tokens.push(...compactModelPolicy(status.model_policy ?? progress.model_policy));
    if (status.tool)
        tokens.push(`tool=${String(status.tool)}`);
    if (status.recipe)
        tokens.push(`recipe=${String(status.recipe)}`);
    if (status.retire_when)
        tokens.push(`retire_when=${String(status.retire_when)}`);
    if (Number(status.pid) > 0)
        tokens.push(`pid=${Number(status.pid)}`);
    if (progress.phase && progress.phase !== status.status)
        tokens.push(`phase=${String(progress.phase)}`);
    if (Number(progress.activeSubagents) > 0)
        tokens.push(`active=${Number(progress.activeSubagents)}`);
    if (Number(progress.completed) > 0)
        tokens.push(`completed=${Number(progress.completed)}`);
    const failures = formatFailureCount(progress.failures);
    if (failures !== undefined && failures > 0)
        tokens.push(`failures=${failures}`);
    if (result.code !== undefined)
        tokens.push(`code=${String(result.code)}`);
    if (result.killed === true)
        tokens.push("killed=true");
    const draftRecipe = status.draft_recipe;
    if (draftRecipe)
        tokens.push(`draft_recipe=${String(draftRecipe)}`);
    const nextActions = runNextActions(run);
    if (nextActions.length > 0)
        tokens.push(`next=${nextActions.map((action) => action.replaceAll(/\s+/g, "_")).join("|")}`);
    return `\n${tokens.join(" ")}`;
}
export function maybeJsonText(value, verbose, compact) {
    return verbose ? jsonText(value) : compact;
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
export function compactRecipeRegistry(summary) {
    const active = Array.isArray(summary.active) ? summary.active.length : 0;
    const shadowed = Array.isArray(summary.shadowed)
        ? summary.shadowed.length
        : 0;
    const invalid = Array.isArray(summary.invalid) ? summary.invalid.length : 0;
    const disabled = Array.isArray(summary.disabled)
        ? summary.disabled.length
        : 0;
    const diagnostics = Array.isArray(summary.diagnostics)
        ? summary.diagnostics.length
        : 0;
    const drafts = Array.isArray(summary.drafts) ? summary.drafts.length : 0;
    const recommendations = Array.isArray(summary.recommendations)
        ? summary.recommendations.length
        : 0;
    const skillCatalogPartial = summary.skill_recipe_catalog_partial === true;
    const currentPolicy = Array.isArray(summary.active)
        ? summary.active.filter((entry) => entry.current_policy).length
        : 0;
    const nextActions = Array.isArray(summary.next_actions)
        ? summary.next_actions
        : [];
    return `\nrecipes active=${active} drafts=${drafts} shadowed=${shadowed} invalid=${invalid} disabled=${disabled} current_policy=${currentPolicy} skill_catalog_partial=${skillCatalogPartial} recommendations=${recommendations} diagnostics=${diagnostics}${compactNextActions(nextActions)}`;
}
export const DEFAULT_INSPECT_LINES = Limits.DEFAULT_INSPECT_LINES;
