/**
 * Automatic recipe-review runtime composition.
 * Zones: session-bound review schedulers, silent reviewer launch adapters, review controls
 * Owns automatic-review lifecycle wiring without owning review decisions or filesystem transactions.
 */

import { join } from "node:path";

import * as AsyncRuns from "./async-runs.ts";
import * as DraftSleep from "./draft-sleep.ts";
import * as ModelContext from "./model-context.ts";
import * as Paths from "./paths.ts";
import type * as Pi from "./pi.ts";
import * as ReviewControl from "./review-control.ts";
import * as ToolReviewScheduler from "./tool-review-scheduler.ts";

export interface AutomaticReviewRuntime {
  close(): void;
  handleMessage(type: string, body: unknown): Record<string, unknown>;
  schedule(): void;
  start(ctx: Pi.ExtensionContext): void;
}

export interface AutomaticReviewRuntimeDeps {
  getActiveContext(): Pi.ExtensionContext | undefined;
  getRunOwnerId(ctx: Pi.ExtensionContext): string;
  getThinkingLevel(): unknown;
}

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
    handleMessage(type, body) {
      if (type !== "review.retry" && type !== "review.reset") {
        throw new Error("tool:pi-actors accepts review.retry or review.reset messages.");
      }
      if (type === "review.retry" && !Paths.isAutomaticRecipeReviewEnabled()) {
        throw new Error(
          "Automatic recipe review is disabled by PI_ACTORS_AUTOMATIC_REVIEW.",
        );
      }
      return ReviewControl.controlAutomaticReview(
        type,
        ReviewControl.parseAutomaticReviewScope(body),
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
              file: join(Paths.getPackagedRecipeRoot(), "draft-review.json"),
              launch_source: "tool",
              notification_policy: "silent",
              ownerId: deps.getRunOwnerId(ctx),
              policy_values: policyValues(ctx),
              run_id: DraftSleep.draftSleepRunId(batch.batchId),
              values: { input_path: batch.reviewerInputPath },
            },
            ctx.cwd,
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
              file: join(Paths.getPackagedRecipeRoot(), "tool-review.json"),
              launch_source: "tool",
              notification_policy: "silent",
              ownerId: deps.getRunOwnerId(ctx),
              policy_values: policyValues(ctx),
              run_id: ToolReviewScheduler.toolReviewRunId(batch.reviewId),
              values: { input_path: batch.reviewerInputPath },
            },
            ctx.cwd,
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
