/**
 * Review preflight diagnostics
 * Zones: recipe diagnostics, subagent launch policy
 * Owns compact classification of failed review-pipeline preflight commands.
 */

export type ReviewPreflightErrorClass =
  | "auth_or_key"
  | "model_unavailable"
  | "quota_or_balance"
  | "rate_limited"
  | "timeout"
  | "transport"
  | "unknown_provider_failure";

export interface ReviewPreflightDiagnosticInput {
  args: readonly string[];
  code?: number;
  killed?: boolean;
  promptFile?: string;
  promptText?: string;
  stderr?: string;
  stdout?: string;
}

export interface ReviewPreflightDiagnostic {
  errorClass: ReviewPreflightErrorClass;
  model?: string;
  promptFile?: string;
  stage: string;
  suggestedOverrideArgs: string;
  thinking?: string;
}

const PREFLIGHT_STAGE_PATTERN = /Preflight check for stage\s+([^\s.]+)\.?/i;

function getFlagValue(args: readonly string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) return args[index + 1];
    if (value?.startsWith(inlinePrefix)) return value.slice(inlinePrefix.length);
  }
  return undefined;
}

function getToolPolicy(args: readonly string[]): string {
  if (args.includes("--no-tools")) return "<tool-policy>";
  return getFlagValue(args, "--tools") ?? "<tool-policy>";
}

export function extractReviewPreflightStage(
  promptText: string | undefined,
): string | undefined {
  return promptText?.match(PREFLIGHT_STAGE_PATTERN)?.[1];
}

export function classifyReviewPreflightError(
  text: string,
  killed = false,
): ReviewPreflightErrorClass {
  if (killed) return "timeout";
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

function getStageModelArg(stage: string): string {
  if (
    stage === "reviewer" ||
    stage === "verifier" ||
    stage === "merger" ||
    stage === "judge"
  ) {
    return `${stage}_model`;
  }
  return "model";
}

function buildSuggestedOverrideArgs(stage: string, args: readonly string[]): string {
  return `${getStageModelArg(stage)}=<working-model> thinking=<supported-level> tools=${getToolPolicy(args)}`;
}

export function buildReviewPreflightDiagnostic(
  input: ReviewPreflightDiagnosticInput,
): ReviewPreflightDiagnostic | undefined {
  const stage = extractReviewPreflightStage(input.promptText);
  if (!stage) return undefined;
  return {
    errorClass: classifyReviewPreflightError(
      [input.stderr, input.stdout].filter(Boolean).join("\n"),
      input.killed,
    ),
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

export function formatReviewPreflightDiagnostic(
  diagnostic: ReviewPreflightDiagnostic,
): string {
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
