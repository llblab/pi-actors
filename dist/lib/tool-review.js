/**
 * Automatic active-tool portfolio review contract.
 * Zones: thirty-six-tool reviewer input, evolution decisions, mechanical contract gates
 * Owns strict read-only keep/evolve/replace/demote/merge/split review semantics.
 */
export const TOOL_REVIEW_THRESHOLD = 36;
const UUID_PATTERN = /^[a-f0-9-]{36}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (!isRecord(value))
        return JSON.stringify(value);
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`;
}
function finiteScore(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function calls(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : 0;
}
function validateAssessment(assessment, tool, errors) {
    if (!isRecord(assessment) ||
        !finiteScore(assessment.adaptability) ||
        !finiteScore(assessment.futureUsefulness) ||
        !finiteScore(assessment.redundancy) ||
        typeof assessment.safety !== "string" ||
        !assessment.safety.trim() ||
        !Number.isInteger(assessment.lifetimeCalls) ||
        Number(assessment.lifetimeCalls) < 0 ||
        !Number.isInteger(assessment.revisionCalls) ||
        Number(assessment.revisionCalls) < 0) {
        errors.push(`invalid tool assessment: ${tool.name}`);
        return;
    }
    if (assessment.lifetimeCalls !== calls(tool.usage?.lifetime_calls ?? tool.usage?.calls)) {
        errors.push(`tool lifetime calls differ from lineage: ${tool.name}`);
    }
    if (assessment.revisionCalls !== calls(tool.usage?.revision_calls)) {
        errors.push(`tool revision calls differ from lineage: ${tool.name}`);
    }
}
export function validateToolReviewInput(input) {
    const errors = [];
    if (!UUID_PATTERN.test(input.reviewId))
        errors.push("tool reviewId must be a UUID");
    if (!input.createdAt || Number.isNaN(Date.parse(input.createdAt))) {
        errors.push("tool review createdAt must be an ISO timestamp");
    }
    if (!Array.isArray(input.tools) || input.tools.length !== TOOL_REVIEW_THRESHOLD) {
        errors.push(`tool review input must contain exactly ${TOOL_REVIEW_THRESHOLD} tools`);
    }
    const names = new Set();
    for (const tool of input.tools ?? []) {
        if (!tool ||
            !TOOL_NAME_PATTERN.test(tool.name) ||
            typeof tool.path !== "string" ||
            typeof tool.sha256 !== "string" ||
            typeof tool.valid !== "boolean" ||
            !isRecord(tool.recipe) ||
            !Array.isArray(tool.riskLabels) ||
            names.has(tool.name)) {
            errors.push(`invalid or duplicate reviewed tool: ${String(tool?.name)}`);
            continue;
        }
        names.add(tool.name);
    }
    return { errors, ok: errors.length === 0 };
}
export function validateToolReviewResult(input, result) {
    const errors = [...validateToolReviewInput(input).errors];
    if (result.reviewId !== input.reviewId)
        errors.push("tool review identity mismatch");
    if (!result.createdAt || Number.isNaN(Date.parse(result.createdAt))) {
        errors.push("tool review result createdAt must be an ISO timestamp");
    }
    if (!Array.isArray(result.decisions)) {
        errors.push("tool review decisions must be an array");
        return { errors, ok: false };
    }
    const inventory = new Map(input.tools.map((tool) => [tool.name, tool]));
    const activeNames = new Set(inventory.keys());
    const seen = new Set();
    const outputNames = new Set();
    const mergeGroups = new Map();
    for (const decision of result.decisions) {
        const tool = inventory.get(decision.source);
        if (!tool) {
            errors.push(`unknown reviewed tool: ${decision.source}`);
            continue;
        }
        if (seen.has(decision.source)) {
            errors.push(`duplicate tool decision: ${decision.source}`);
            continue;
        }
        seen.add(decision.source);
        if (decision.sha256 !== tool.sha256)
            errors.push(`reviewed tool changed: ${tool.name}`);
        if (!decision.rationale?.trim())
            errors.push(`missing tool rationale: ${tool.name}`);
        validateAssessment(decision.assessment, tool, errors);
        if (decision.action === "keep" || decision.action === "demote") {
            if (decision.target || decision.recipe || decision.outputs) {
                errors.push(`${decision.action} declares evolution fields: ${tool.name}`);
            }
            continue;
        }
        if (decision.action === "replace" || decision.action === "split") {
            errors.push(`${decision.action} requires explicit operator-authored recipe mutation: ${tool.name}`);
            continue;
        }
        if (decision.action === "evolve") {
            if (!decision.target || !TOOL_NAME_PATTERN.test(decision.target)) {
                errors.push(`evolve requires snake_case target: ${tool.name}`);
            }
            if (decision.recipe !== undefined || decision.outputs !== undefined) {
                errors.push(`evolve must not supply executable recipe content: ${tool.name}`);
            }
            if (decision.target &&
                activeNames.has(decision.target) &&
                decision.target !== tool.name) {
                errors.push(`evolve target collides with active tool: ${decision.target}`);
            }
            if (decision.target && outputNames.has(decision.target)) {
                errors.push(`duplicate evolved target: ${decision.target}`);
            }
            else if (decision.target)
                outputNames.add(decision.target);
            continue;
        }
        if (decision.action === "merge") {
            if (!decision.target || !TOOL_NAME_PATTERN.test(decision.target)) {
                errors.push(`merge requires snake_case target: ${tool.name}`);
                continue;
            }
            if (decision.recipe !== undefined || decision.outputs !== undefined) {
                errors.push(`merge must not supply executable recipe content: ${tool.name}`);
            }
            const group = mergeGroups.get(decision.target) ?? [];
            group.push({ decision, recipe: canonicalJson(tool.recipe) });
            mergeGroups.set(decision.target, group);
            continue;
        }
        errors.push(`invalid tool review action: ${tool.name}`);
    }
    for (const tool of input.tools) {
        if (!seen.has(tool.name))
            errors.push(`missing tool decision: ${tool.name}`);
    }
    for (const [target, group] of mergeGroups) {
        if (group.length < 2)
            errors.push(`merge target requires at least two sources: ${target}`);
        if (activeNames.has(target) &&
            !group.some((entry) => entry.decision.source === target)) {
            errors.push(`merge target collides with unrelated active tool: ${target}`);
        }
        if (new Set(group.map((entry) => entry.recipe)).size !== 1) {
            errors.push(`merge target recipes differ: ${target}`);
        }
        if (outputNames.has(target))
            errors.push(`duplicate evolved target: ${target}`);
        outputNames.add(target);
    }
    return { errors, ok: errors.length === 0 };
}
export function parseToolReviewResult(stdout) {
    const marker = "TOOL_REVIEW_RESULT";
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0)
        throw new Error("Tool reviewer output marker is missing.");
    const payload = stdout.slice(markerIndex + marker.length).trim();
    if (!payload.startsWith("{") || !payload.endsWith("}")) {
        throw new Error("Tool reviewer output must end with one JSON object.");
    }
    const value = JSON.parse(payload);
    if (!isRecord(value))
        throw new Error("Tool reviewer result must be an object.");
    return value;
}
export function createToolReviewPrompt(inputPath) {
    return [
        `Review the attached immutable active-tool portfolio from ${inputPath}.`,
        "Evaluate all 36 tools independently from lifetime/revision usage, adaptability, redundancy, safety, contract quality, and likely future usefulness.",
        "Choose exactly one action per source: keep, evolve, demote, or merge. There is no quota for any action.",
        "evolve may only rename one unchanged captured recipe; demote moves the unchanged recipe to draft memory; merge may only deduplicate at least two canonically identical captured recipes. Never return recipe or outputs fields. replace and split require explicit operator-authored mutation and are unavailable to automatic review.",
        "Do not mutate, register, move, or delete recipes. You are a read-only selector; the deterministic executor derives exact recipe bytes from captured sources and owns every portfolio mutation.",
        "End stdout with TOOL_REVIEW_RESULT on its own line followed by exactly one JSON object with reviewId, createdAt, and decisions.",
    ].join("\n");
}
