/**
 * Review preflight diagnostics
 * Zones: recipe diagnostics, subagent launch policy
 * Owns compact classification of failed review-pipeline preflight commands.
 */
const PREFLIGHT_STAGE_PATTERN = /Preflight check for stage\s+([^\s.]+)\.?/i;
function getFlagValue(args, flag) {
    const inlinePrefix = `${flag}=`;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === flag)
            return args[index + 1];
        if (value?.startsWith(inlinePrefix))
            return value.slice(inlinePrefix.length);
    }
    return undefined;
}
function getToolPolicy(args) {
    if (args.includes("--no-tools"))
        return "<tool-policy>";
    return getFlagValue(args, "--tools") ?? "<tool-policy>";
}
export function extractReviewPreflightStage(promptText) {
    return promptText?.match(PREFLIGHT_STAGE_PATTERN)?.[1];
}
export function classifyReviewPreflightError(text, killed = false) {
    if (killed)
        return "timeout";
    const normalized = text.toLowerCase();
    if (/insufficient[_ -]?quota|\bquota\b|balance|billing|credits?|payment/.test(normalized)) {
        return "quota_or_balance";
    }
    if (/api[_ -]?key|unauthori[sz]ed|forbidden|permission|\b401\b|\b403\b|auth/.test(normalized)) {
        return "auth_or_key";
    }
    if (/\b404\b|not found|unknown model|model .*not (exist|found)|invalid model|unsupported model/.test(normalized)) {
        return "model_unavailable";
    }
    if (/rate limit|\b429\b|too many requests/.test(normalized)) {
        return "rate_limited";
    }
    if (/network|econn|enotfound|etimedout|fetch failed|socket|\btls\b/.test(normalized)) {
        return "transport";
    }
    return "unknown_provider_failure";
}
function getStageModelArg(stage) {
    if (stage === "reviewer" ||
        stage === "verifier" ||
        stage === "merger" ||
        stage === "judge") {
        return `${stage}_model`;
    }
    return "model";
}
function buildSuggestedOverrideArgs(stage, args) {
    return `${getStageModelArg(stage)}=<working-model> thinking=<supported-level> tools=${getToolPolicy(args)}`;
}
export function buildReviewPreflightDiagnostic(input) {
    const stage = extractReviewPreflightStage(input.promptText);
    if (!stage)
        return undefined;
    return {
        errorClass: classifyReviewPreflightError([input.stderr, input.stdout].filter(Boolean).join("\n"), input.killed),
        ...(getFlagValue(input.args, "--model")
            ? { model: getFlagValue(input.args, "--model") }
            : {}),
        ...(input.promptFile ? { promptFile: input.promptFile } : {}),
        stage,
        suggestedOverrideArgs: buildSuggestedOverrideArgs(stage, input.args),
        ...(getFlagValue(input.args, "--thinking")
            ? { thinking: getFlagValue(input.args, "--thinking") }
            : {}),
    };
}
export function formatReviewPreflightDiagnostic(diagnostic) {
    return [
        "ACTOR_PREFLIGHT_FAILED",
        `stage=${diagnostic.stage}`,
        ...(diagnostic.model ? [`model=${diagnostic.model}`] : []),
        ...(diagnostic.thinking ? [`thinking=${diagnostic.thinking}`] : []),
        `error_class=${diagnostic.errorClass}`,
        ...(diagnostic.promptFile ? [`prompt_file=${diagnostic.promptFile}`] : []),
        `suggested_override_args=\"${diagnostic.suggestedOverrideArgs}\"`,
    ].join(" ");
}
