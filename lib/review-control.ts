/**
 * Automatic recipe-review operator control.
 * Owns: explicit retry/reset transitions over durable draft/tool admission state.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";
import * as Paths from "./paths.ts";

export type AutomaticReviewScope = "draft" | "tool";
export type AutomaticReviewControlAction = "review.reset" | "review.retry";

export interface AutomaticReviewControlOptions {
  draftStatePath?: string;
  scheduleDraft?(): void;
  scheduleTool?(): void;
  toolStatePath?: string;
}

function readState(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function statePath(
  scope: AutomaticReviewScope,
  options: AutomaticReviewControlOptions,
): string {
  return scope === "draft"
    ? options.draftStatePath ?? Paths.getDraftSleepStatePath()
    : options.toolStatePath ?? Paths.getToolReviewStatePath();
}

function schedule(
  scope: AutomaticReviewScope,
  options: AutomaticReviewControlOptions,
): void {
  if (scope === "draft") options.scheduleDraft?.();
  else options.scheduleTool?.();
}

export function controlAutomaticReview(
  action: AutomaticReviewControlAction,
  scope: AutomaticReviewScope,
  options: AutomaticReviewControlOptions = {},
): Record<string, unknown> {
  const path = statePath(scope, options);
  const result = withFileMutationLock(path, () => {
    const state = readState(path);
    if (!state) {
      return { action, changed: false, phase: "idle", reason: "review_state_unavailable", scope };
    }
    const phase = String(state.phase ?? "unknown");
    if (action === "review.reset") {
      if (!["completed", "failed", "processing_failed"].includes(phase)) {
        return { action, changed: false, phase, reason: "review_state_not_terminal", scope };
      }
      if (
        scope === "tool" &&
        (state.approvedPath || state.transactionEvidencePath || state.lineageJournalPath)
      ) {
        return {
          action,
          changed: false,
          phase,
          reason: "review_recovery_evidence_requires_retry",
          scope,
        };
      }
      rmSync(path, { force: true });
      return { action, changed: true, phase: "idle", previous_phase: phase, scope };
    }
    if (!["failed", "processing_failed"].includes(phase)) {
      return { action, changed: false, phase, reason: "review_state_not_retryable", scope };
    }
    const resumeDraftTransaction =
      scope === "draft" &&
      phase === "processing_failed" &&
      typeof state.inputPath === "string" &&
      typeof state.runId === "string" &&
      existsSync(join(dirname(state.inputPath), "journal.json"));
    const nextPhase = resumeDraftTransaction
      ? "launched"
      : scope === "tool" && state.approvedPath
        ? state.transactionEvidencePath
          ? "lineage_pending"
          : "approved"
        : "captured";
    const next = {
      ...state,
      attempts: 0,
      lastError: undefined,
      nextAction: undefined,
      failedStage: undefined,
      phase: nextPhase,
      processingAttempts: 0,
      runId: resumeDraftTransaction ? state.runId : undefined,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path, next);
    return {
      action,
      changed: true,
      phase: nextPhase,
      previous_phase: phase,
      scope,
    };
  });
  if (result.changed === true) schedule(scope, options);
  const nextActions = ["inspect target=recipes view=reviews"];
  if (
    action === "review.retry" &&
    scope === "tool" &&
    (result.phase === "approved" || result.phase === "lineage_pending")
  ) nextActions.push("/reload");
  return {
    ...result,
    next_actions: nextActions,
    sent: result.changed === true,
  };
}

export function parseAutomaticReviewScope(body: unknown): AutomaticReviewScope {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (record.scope === "draft" || record.scope === "tool") return record.scope;
  throw new Error("review control requires body.scope=draft or body.scope=tool.");
}
