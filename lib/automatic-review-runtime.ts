/**
 * Automatic recipe-review runtime composition.
 * Zones: session-bound review schedulers, silent reviewer launch adapters, review controls
 * Owns automatic-review lifecycle wiring without owning review decisions or filesystem transactions.
 */

import { fileURLToPath } from "node:url";

import * as AsyncRuns from "./async-runs.ts";
import * as DraftSleep from "./draft-sleep.ts";
import * as ModelContext from "./model-context.ts";
import * as Paths from "./paths.ts";
import type * as Pi from "./pi.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as ReviewControl from "./review-control.ts";
import * as ToolReviewScheduler from "./tool-review-scheduler.ts";

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
}

export const PACKAGE_RECIPE_MEMORY_CONTEXT =
  RecipesReferences.createActiveSkillRecipeContext([
    {
      name: "recipe-memory",
      filePath: fileURLToPath(
        new URL("../skills/recipe-memory/SKILL.md", import.meta.url),
      ),
    },
  ]);

export function createAutomaticReviewRuntime(
  deps: AutomaticReviewRuntimeDeps,
): AutomaticReviewRuntime {
  let draftScheduler: DraftSleep.DraftSleepScheduler | undefined;
  let toolScheduler: ToolReviewScheduler.ToolReviewScheduler | undefined;

  const close = (): void => {
    draftScheduler?.close();
    draftScheduler = undefined;
    toolScheduler?.close();
    toolScheduler = undefined;
  };
  const hasActiveActors = (): boolean =>
    AsyncRuns.listRuns(Paths.EXTENSION_RUNTIME_PATHS.runStateRoot, "running").length > 0;
  const policyValues = (ctx: Pi.ExtensionContext): Record<string, unknown> =>
    ModelContext.withCurrentModelValues(
      {},
      {
        ...(ctx as ModelContext.CurrentModelContext),
        getThinkingLevel: deps.getThinkingLevel,
      },
    );

  return {
    close,
    handleControl(action, input) {
      if (action !== "review.retry" && action !== "review.reset") {
        throw new Error("runtime accepts review.retry or review.reset Controls.");
      }
      if (action === "review.retry" && !Paths.isAutomaticRecipeReviewEnabled()) {
        throw new Error(
          "Automatic recipe review is disabled by PI_ACTORS_AUTOMATIC_REVIEW.",
        );
      }
      return ReviewControl.controlAutomaticReview(
        action,
        ReviewControl.parseAutomaticReviewScope(input),
        {
          scheduleDraft: () => draftScheduler?.schedule(),
          scheduleTool: () => toolScheduler?.schedule(),
        },
      );
    },
    schedule() {
      draftScheduler?.schedule();
      toolScheduler?.schedule();
    },
    start(ctx) {
      close();
      if (!Paths.isAutomaticRecipeReviewEnabled()) return;
      ToolReviewScheduler.applyApprovedToolReviewAtSessionBoundary({
        recipeRoot: Paths.getRecipeRoot(),
      });
      draftScheduler = DraftSleep.createDraftSleepScheduler({
        hasActiveActors,
        launch: (batch) => {
          if (deps.getActiveContext() !== ctx) {
            throw new Error("Draft review session changed before launch.");
          }
          return AsyncRuns.startRun(
            {
              file: "recipe-memory/draft-review",
              launch_source: "tool",
              notification_policy: "silent",
              ownerId: deps.getRunOwnerId(ctx),
              policy_values: policyValues(ctx),
              run_id: DraftSleep.draftSleepRunId(batch.batchId),
              values: { input_path: batch.reviewerInputPath },
            },
            ctx.cwd,
            { skillContext: PACKAGE_RECIPE_MEMORY_CONTEXT },
          );
        },
        process: (state) =>
          DraftSleep.processDraftSleepReview(state, {
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
          return AsyncRuns.startRun(
            {
              file: "recipe-memory/tool-review",
              launch_source: "tool",
              notification_policy: "silent",
              ownerId: deps.getRunOwnerId(ctx),
              policy_values: policyValues(ctx),
              run_id: ToolReviewScheduler.toolReviewRunId(batch.reviewId),
              values: { input_path: batch.reviewerInputPath },
            },
            ctx.cwd,
            { skillContext: PACKAGE_RECIPE_MEMORY_CONTEXT },
          );
        },
        process: (state) =>
          ToolReviewScheduler.processToolReviewResult(state, {
            getRunStatus: AsyncRuns.getRunStatus,
            recipeRoot: Paths.getRecipeRoot(),
          }),
      });
    },
  };
}
