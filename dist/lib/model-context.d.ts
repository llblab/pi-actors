/**
 * Current model/thinking propagation helpers
 * Zones: pi session context, recipe inheritance
 * Owns current model/thinking extraction from Pi tool contexts and implicit command-template values.
 */
export interface CurrentModelContext {
    currentThinking?: unknown;
    getThinkingLevel?: () => unknown;
    model?: {
        id?: unknown;
        modelId?: unknown;
        provider?: unknown;
    };
    sessionManager?: {
        getBranch?: () => unknown[];
        getSessionId?: () => string;
    };
    thinkingLevel?: unknown;
}
export declare const CURRENT_MODEL_VALUE_KEY = "current_model";
export declare const CURRENT_THINKING_VALUE_KEY = "current_thinking";
export type CurrentPolicySource = "explicit" | "inherited" | "mixed" | "unresolved" | "unused";
export interface CurrentPolicyAxisProvenance {
    explicit_keys?: string[];
    inherited_keys?: string[];
    source: CurrentPolicySource;
    unresolved_keys?: string[];
    value?: string;
}
export interface CurrentPolicyProvenance {
    model: CurrentPolicyAxisProvenance;
    thinking: CurrentPolicyAxisProvenance;
}
export interface CurrentPolicyRecipeSummary {
    model?: {
        inherited_defaults?: string[];
        public_args?: string[];
    };
    thinking?: {
        inherited_defaults?: string[];
        public_args?: string[];
    };
}
export declare function getCurrentModelPattern(ctx: CurrentModelContext | undefined): string | undefined;
export declare function getCurrentThinkingLevel(ctx: CurrentModelContext | undefined): string | undefined;
export declare function withCurrentModelValues<T extends Record<string, unknown>>(values: T, ctx: CurrentModelContext | undefined): T & Record<string, unknown>;
export declare function describeCurrentPolicyProvenance(input: {
    defaults?: Record<string, unknown>;
    template: unknown;
    values?: Record<string, unknown>;
}): CurrentPolicyProvenance;
export declare function describeRecipeCurrentPolicy(input: {
    args?: unknown;
    defaults?: Record<string, unknown>;
    template: unknown;
}): CurrentPolicyRecipeSummary | undefined;
