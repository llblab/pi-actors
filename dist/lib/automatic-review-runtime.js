/**
 * Automatic recipe-review runtime composition.
 * Zones: session-bound review schedulers, silent reviewer launch adapters, review controls
 * Owns automatic-review lifecycle wiring without owning review decisions or filesystem transactions.
 */
import { fileURLToPath } from "node:url";
import * as AsyncRuns from "./async-runs.js";
import * as DraftSleep from "./draft-sleep.js";
import * as ModelContext from "./model-context.js";
import * as Paths from "./paths.js";
import * as RecipesReferences from "./recipes-references.js";
import * as ReviewControl from "./review-control.js";
import * as ToolReviewScheduler from "./tool-review-scheduler.js";
export const PACKAGE_RECIPE_MEMORY_CONTEXT = RecipesReferences.createActiveSkillRecipeContext([
    {
        name: "recipe-memory",
        filePath: fileURLToPath(new URL("../skills/recipe-memory/SKILL.md", import.meta.url)),
    },
]);
export function createAutomaticReviewRuntime(deps) {
    let draftScheduler;
    let toolScheduler;
    const close = () => {
        draftScheduler?.close();
        draftScheduler = undefined;
        toolScheduler?.close();
        toolScheduler = undefined;
    };
    const hasActiveActors = () => AsyncRuns.listRuns(Paths.EXTENSION_RUNTIME_PATHS.runStateRoot, "running").length > 0;
    const policyValues = (ctx) => ModelContext.withCurrentModelValues({}, {
        ...ctx,
        getThinkingLevel: deps.getThinkingLevel,
    });
    return {
        close,
        handleControl(action, input) {
            if (action !== "review.retry" && action !== "review.reset") {
                throw new Error("runtime accepts review.retry or review.reset Controls.");
            }
            if (action === "review.retry" && !Paths.isAutomaticRecipeReviewEnabled()) {
                throw new Error("Automatic recipe review is disabled by PI_ACTORS_AUTOMATIC_REVIEW.");
            }
            return ReviewControl.controlAutomaticReview(action, ReviewControl.parseAutomaticReviewScope(input), {
                scheduleDraft: () => draftScheduler?.schedule(),
                scheduleTool: () => toolScheduler?.schedule(),
            });
        },
        schedule() {
            draftScheduler?.schedule();
            toolScheduler?.schedule();
        },
        start(ctx) {
            close();
            if (!Paths.isAutomaticRecipeReviewEnabled())
                return;
            ToolReviewScheduler.applyApprovedToolReviewAtSessionBoundary({
                recipeRoot: Paths.getRecipeRoot(),
            });
            draftScheduler = DraftSleep.createDraftSleepScheduler({
                hasActiveActors,
                launch: (batch) => {
                    if (deps.getActiveContext() !== ctx) {
                        throw new Error("Draft review session changed before launch.");
                    }
                    return AsyncRuns.startRun({
                        file: "recipe-memory/draft-review",
                        launch_source: "tool",
                        notification_policy: "silent",
                        ownerId: deps.getRunOwnerId(ctx),
                        policy_values: policyValues(ctx),
                        run_id: DraftSleep.draftSleepRunId(batch.batchId),
                        values: { input_path: batch.reviewerInputPath },
                    }, ctx.cwd, { skillContext: PACKAGE_RECIPE_MEMORY_CONTEXT });
                },
                process: (state) => DraftSleep.processDraftSleepReview(state, {
                    getRunStatus: AsyncRuns.getRunStatus,
                    recipeRoot: Paths.getRecipeRoot(),
                }),
            });
            toolScheduler = ToolReviewScheduler.createToolReviewScheduler({
                hasActiveActors,
                launch: (batch) => {
                    if (deps.getActiveContext() !== ctx) {
                        throw new Error("Tool review session changed before launch.");
                    }
                    return AsyncRuns.startRun({
                        file: "recipe-memory/tool-review",
                        launch_source: "tool",
                        notification_policy: "silent",
                        ownerId: deps.getRunOwnerId(ctx),
                        policy_values: policyValues(ctx),
                        run_id: ToolReviewScheduler.toolReviewRunId(batch.reviewId),
                        values: { input_path: batch.reviewerInputPath },
                    }, ctx.cwd, { skillContext: PACKAGE_RECIPE_MEMORY_CONTEXT });
                },
                process: (state) => ToolReviewScheduler.processToolReviewResult(state, {
                    getRunStatus: AsyncRuns.getRunStatus,
                    recipeRoot: Paths.getRecipeRoot(),
                }),
            });
        },
    };
}
