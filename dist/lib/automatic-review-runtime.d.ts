/**
 * Automatic recipe-review runtime composition.
 * Zones: session-bound review schedulers, silent reviewer launch adapters, review controls
 * Owns automatic-review lifecycle wiring without owning review decisions or filesystem transactions.
 */
import * as AsyncRuns from "./async-runs.ts";
import type * as Pi from "./pi.ts";
import * as RecipesReferences from "./recipes-references.ts";
export interface AutomaticReviewRuntime {
    close(): void;
    handleControl(action: string, input: unknown): Record<string, unknown>;
    schedule(): void;
    start(ctx: Pi.ExtensionContext): void;
}
export interface AutomaticReviewRuntimeDeps {
    getActiveContext(): Pi.ExtensionContext | undefined;
    getRunOwnerId(ctx: Pi.ExtensionContext): string;
    getThinkingLevel(): unknown;
    getRunAdmissionObserver?(ctx: Pi.ExtensionContext): AsyncRuns.AsyncRunStartOptions["onSupervisionClockCaptured"];
}
export declare const PACKAGE_RECIPE_MEMORY_CONTEXT: RecipesReferences.ActiveSkillRecipeContext;
export declare function createAutomaticReviewRuntime(deps: AutomaticReviewRuntimeDeps): AutomaticReviewRuntime;
