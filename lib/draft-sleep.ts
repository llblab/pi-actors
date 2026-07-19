/**
 * Automatic draft-sleep scheduling.
 * Zones: twelve-draft trigger, immutable batch capture, silent post-turn launch
 * Owns non-blocking review admission and persisted launch evidence, not reviewer decisions or mutation.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { DraftConsolidationPlan } from "./draft-consolidation.ts";
import * as DraftConsolidationTransaction from "./draft-consolidation-transaction.ts";
import type {
  DraftReviewActiveTool,
  DraftReviewDraft,
  DraftReviewInput,
} from "./draft-review.ts";
import {
  parseDraftReviewResult,
  validateDraftReviewInput,
  validateDraftReviewResult,
} from "./draft-review.ts";
import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";
import * as Paths from "./paths.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import * as ReviewProjection from "./review-projection.ts";

export const DRAFT_SLEEP_THRESHOLD = 12;
const DEFAULT_DELAY_MS = 25;

export interface DraftSleepBatch {
  batchId: string;
  inputPath: string;
  reviewerInputPath: string;
  sourcePaths: string[];
}

export interface DraftSleepState {
  attempts: number;
  batchId: string;
  inputPath: string;
  evidencePath?: string;
  failedStage?: string;
  lastError?: string;
  nextAction?: string;
  phase: "captured" | "completed" | "failed" | "launched" | "processing_failed";
  processingAttempts?: number;
  reviewerInputPath: string;
  runId?: string;
  sourcePaths: string[];
  updatedAt: string;
}

export interface DraftSleepProcessResult {
  cleanup?(): void;
  error?: string;
  evidencePath?: string;
  outcome: "completed" | "pending" | "processing_failed" | "review_failed";
  stage?: string;
}

export interface DraftSleepSchedulerDeps {
  activeTools?(): DraftReviewActiveTool[];
  batchRoot?(batchId: string): string;
  createBatchId?(): string;
  delayMs?: number;
  draftRoot?: string;
  hasActiveActors(): boolean;
  launch(batch: DraftSleepBatch): { run: string };
  now?(): Date;
  process?(state: DraftSleepState): DraftSleepProcessResult;
  recipeRoot?: string;
  statePath?: string;
}

export interface DraftSleepScheduler {
  close(): void;
  schedule(): void;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readState(path: string): DraftSleepState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as DraftSleepState;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function defaultActiveTools(recipeRoot: string): DraftReviewActiveTool[] {
  const discovered = RecipesDiscovery.discoverRecipeSources([
    { root: recipeRoot, defaultTool: true, mutableUsage: true },
    { root: Paths.getPackagedRecipeRoot() },
  ]);
  return [...discovered.active.values()]
    .filter((entry) => existsSync(entry.path))
    .map((entry) => ({
      name: entry.id,
      path: entry.path,
      sha256: sha256(entry.path),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function draftFromRecord(
  record: Record<string, unknown>,
  recipeRoot: string,
  now: Date,
): DraftReviewDraft | undefined {
  if (
    typeof record.path !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.valid !== "boolean"
  ) {
    return undefined;
  }
  RecipesUsage.ensureRecipeLineage(record.path, now, recipeRoot);
  const riskLabels = Array.isArray(record.risk_labels)
    ? record.risk_labels.filter((label): label is string => typeof label === "string")
    : [];
  const secretTouching = riskLabels.includes("risk.secret_touching");
  const recipe = secretTouching || !record.valid
    ? undefined
    : RecipesReferences.readRawRecipeConfig(record.path);
  const usage = RecipesUsage.readRecipeUsage(record.path, recipeRoot);
  if (
    typeof usage?.demoted_fingerprint === "string" &&
    usage.demoted_fingerprint === usage.fingerprint
  ) {
    return undefined;
  }
  return {
    ...(record.diagnostics !== undefined
      ? { diagnostics: record.diagnostics }
      : {}),
    path: record.path,
    ...(recipe ? { recipe } : {}),
    riskLabels,
    sha256: record.sha256,
    ...(usage ? { usage } : {}),
    valid: record.valid && !secretTouching,
  };
}

type DraftSleepCaptureOptions = Pick<
  DraftSleepSchedulerDeps,
  | "activeTools"
  | "batchRoot"
  | "createBatchId"
  | "draftRoot"
  | "now"
  | "recipeRoot"
  | "statePath"
>;

function captureDraftSleepBatchLocked(
  options: DraftSleepCaptureOptions,
  draftRoot: string,
  recipeRoot: string,
  statePath: string,
): DraftSleepBatch | undefined {
  const state = readState(statePath);
  if (
    state?.phase === "captured" ||
    state?.phase === "launched" ||
    state?.phase === "processing_failed"
  ) return undefined;
  return withFileMutationLock(draftRoot, () => {
    const records = RecipesDiscovery.listDraftRecipes(draftRoot);
    const capturedAt = (options.now ?? (() => new Date()))();
    const candidates = records.flatMap((record) => {
      const draft = draftFromRecord(record, recipeRoot, capturedAt);
      return draft ? [draft] : [];
    });
    if (candidates.length < DRAFT_SLEEP_THRESHOLD) return undefined;
    const batchId = (options.createBatchId ?? randomUUID)();
    const batchDir = (options.batchRoot ?? Paths.getDraftSleepBatchDir)(batchId);
    const inputPath = join(batchDir, "input.json");
    const drafts = candidates.slice(0, DRAFT_SLEEP_THRESHOLD);
    const input: DraftReviewInput = {
      activeTools: options.activeTools?.() ?? defaultActiveTools(recipeRoot),
      batchId,
      createdAt: capturedAt.toISOString(),
      drafts,
    };
    const validation = validateDraftReviewInput(input);
    if (!validation.ok) {
      throw new Error(`Draft sleep input rejected: ${validation.errors.join("; ")}`);
    }
    writeJsonAtomic(inputPath, input);
    const reviewerInputPath = join(batchDir, "review-input.json");
    writeJsonAtomic(reviewerInputPath, ReviewProjection.projectDraftReviewInput(input));
    const sourcePaths = drafts.map((draft) => draft.path);
    writeJsonAtomic(statePath, {
      attempts: 0,
      batchId,
      inputPath,
      phase: "captured",
      reviewerInputPath,
      sourcePaths,
      updatedAt: input.createdAt,
    } satisfies DraftSleepState);
    return { batchId, inputPath, reviewerInputPath, sourcePaths };
  });
}

export function captureDraftSleepBatch(
  options: DraftSleepCaptureOptions = {},
): DraftSleepBatch | undefined {
  const draftRoot = options.draftRoot ?? Paths.getRecipeDraftRoot();
  const recipeRoot = options.recipeRoot ?? Paths.getRecipeRoot();
  const statePath = options.statePath ?? Paths.getDraftSleepStatePath();
  return withFileMutationLock(statePath, () =>
    captureDraftSleepBatchLocked(options, draftRoot, recipeRoot, statePath),
  );
}

export interface ProcessDraftSleepReviewDeps {
  getRunStatus(runId: string): Record<string, unknown>;
  now?(): Date;
  recipeRoot?: string;
}

function completeDraftSleepTransaction(
  transaction: DraftConsolidationTransaction.DraftConsolidationTransactionResult,
  state: DraftSleepState,
  deps: ProcessDraftSleepReviewDeps,
  cycleDir: string,
  recipeRoot: string,
): DraftSleepProcessResult {
  try {
    if (transaction.phase !== "committed") {
      return {
        error: `draft transaction remained ${transaction.phase}`,
        outcome: "processing_failed",
        stage: "transaction",
      };
    }
    const committedDecisions = transaction.plan.drafts;
    for (const decision of committedDecisions) {
      if (decision.action === "promote") {
        const targetPath = join(recipeRoot, `${decision.target}.json`);
        if (!RecipesUsage.moveRecipeUsage(decision.draft, targetPath, recipeRoot)) {
          throw new Error(`Could not transfer promoted recipe lineage: ${decision.draft}`);
        }
      } else if (!RecipesUsage.retireRecipeUsage(decision.draft, recipeRoot)) {
        throw new Error(`Could not retire discarded recipe lineage: ${decision.draft}`);
      }
    }
    const evidencePath = join(cycleDir, "sleep-evidence.json");
    writeJsonAtomic(evidencePath, {
      batchId: state.batchId,
      decisions: committedDecisions,
      garbageCollection: {
        reviewedSources: committedDecisions.length,
        status: "pending",
      },
      transactionEvidencePath: transaction.evidencePath,
      ts: (deps.now ?? (() => new Date()))().toISOString(),
    });
    return {
      cleanup: () => {
        rmSync(join(cycleDir, "quarantine"), { recursive: true, force: true });
        rmSync(join(cycleDir, "backups"), { recursive: true, force: true });
        writeJsonAtomic(evidencePath, {
          batchId: state.batchId,
          decisions: committedDecisions,
          garbageCollection: {
            reviewedSources: committedDecisions.length,
            status: "completed",
          },
          transactionEvidencePath: transaction.evidencePath,
          ts: (deps.now ?? (() => new Date()))().toISOString(),
        });
      },
      evidencePath,
      outcome: "completed",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      outcome: "processing_failed",
      stage: "transaction_or_lineage",
    };
  }
}

export function processDraftSleepReview(
  state: DraftSleepState,
  deps: ProcessDraftSleepReviewDeps,
): DraftSleepProcessResult {
  const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
  const cycleDir = dirname(state.inputPath);
  if (existsSync(join(cycleDir, "journal.json"))) {
    const firstSource = state.sourcePaths[0];
    if (!firstSource) {
      return {
        error: "captured draft source is unavailable for transaction recovery",
        outcome: "processing_failed",
        stage: "transaction",
      };
    }
    try {
      const transaction = DraftConsolidationTransaction.recoverDraftConsolidationCycle({
        cycleDir,
        draftRoot: dirname(firstSource),
        recipeRoot,
      });
      return completeDraftSleepTransaction(transaction, state, deps, cycleDir, recipeRoot);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        outcome: "processing_failed",
        stage: "transaction_or_lineage",
      };
    }
  }
  if (!state.runId) {
    return { error: "review run id is unavailable", outcome: "review_failed", stage: "review_state" };
  }
  let status: Record<string, unknown>;
  try {
    status = deps.getRunStatus(state.runId);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      outcome: "review_failed",
      stage: "review_state",
    };
  }
  if (status.status === "running") return { outcome: "pending" };
  if (status.status !== "done" || typeof status.state_dir !== "string") {
    return {
      error: `review run ended with status ${String(status.status ?? "unknown")}`,
      outcome: "review_failed",
      stage: "review_run",
    };
  }
  let input: DraftReviewInput;
  let result: ReturnType<typeof parseDraftReviewResult>;
  try {
    input = JSON.parse(readFileSync(state.inputPath, "utf8")) as DraftReviewInput;
    result = parseDraftReviewResult(
      readFileSync(join(status.state_dir, "stdout.log"), "utf8"),
    );
    result = ReviewProjection.restoreDraftReviewResult(input, result);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      outcome: "review_failed",
      stage: "result_parse",
    };
  }
  const validation = validateDraftReviewResult(input, result);
  if (!validation.ok) {
    return {
      error: validation.errors.join("; "),
      outcome: "review_failed",
      stage: "result_validation",
    };
  }
  const draftRoot = dirname(input.drafts[0]!.path);
  const capturedDrafts = new Map(input.drafts.map((draft) => [draft.path, draft]));
  const plan: DraftConsolidationPlan = {
    createdAt: result.createdAt,
    cycleId: state.batchId,
    drafts: result.decisions.map((decision) => {
      const source = capturedDrafts.get(decision.draft);
      if (decision.action === "promote" && !source?.recipe) {
        throw new Error(`Promoted draft source recipe is unavailable: ${decision.draft}`);
      }
      return {
        action: decision.action,
        draft: decision.draft,
        rationale: decision.rationale,
        ...(decision.action === "promote" ? { recipe: source!.recipe } : {}),
        sha256: decision.sha256,
        ...(decision.target ? { target: decision.target } : {}),
        ...(decision.action === "promote" ? { targetSha256: null } : {}),
      };
    }),
  };
  const inventory = input.drafts.map((draft) => ({
    id: basename(draft.path).replace(/\.(?:json|md)$/u, ""),
    path: draft.path,
    sha256: draft.sha256,
    valid: draft.valid,
    ...(draft.diagnostics !== undefined ? { diagnostics: draft.diagnostics } : {}),
    ...(draft.riskLabels.length > 0 ? { riskLabels: draft.riskLabels } : {}),
  }));
  try {
    const transaction = DraftConsolidationTransaction.applyDraftConsolidationPlan(plan, {
      cycleDir,
      draftRoot,
      inventory,
      recipeRoot,
      sourceScope: "batch",
    });
    return completeDraftSleepTransaction(transaction, state, deps, cycleDir, recipeRoot);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      outcome: "processing_failed",
      stage: "transaction_or_lineage",
    };
  }
}

function cleanupCompletedState(state: DraftSleepState): void {
  const cycleDir = dirname(state.inputPath);
  rmSync(join(cycleDir, "quarantine"), { recursive: true, force: true });
  rmSync(join(cycleDir, "backups"), { recursive: true, force: true });
  if (!state.evidencePath || !existsSync(state.evidencePath)) return;
  try {
    const evidence = JSON.parse(readFileSync(state.evidencePath, "utf8")) as Record<string, unknown>;
    const garbageCollection = evidence.garbageCollection as
      | Record<string, unknown>
      | undefined;
    if (garbageCollection?.status === "completed") return;
    writeJsonAtomic(state.evidencePath, {
      ...evidence,
      garbageCollection: {
        ...garbageCollection,
        status: "completed",
      },
    });
  } catch {
    /* bounded diagnostic evidence remains available for later inspection */
  }
}

export function createDraftSleepScheduler(
  deps: DraftSleepSchedulerDeps,
): DraftSleepScheduler {
  const statePath = deps.statePath ?? Paths.getDraftSleepStatePath();
  const draftRoot = deps.draftRoot ?? Paths.getRecipeDraftRoot();
  const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const close = (): void => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || deps.hasActiveActors()) return;
      try {
        withFileMutationLock(statePath, () => {
          const existing = readState(statePath);
      if (existing?.phase === "completed") {
        cleanupCompletedState(existing);
        return;
      }
      if (
        existing?.phase === "launched" ||
        existing?.phase === "processing_failed"
      ) {
        if (!deps.process || (existing.processingAttempts ?? 0) >= 3) return;
        let processed: DraftSleepProcessResult;
        try {
          processed = deps.process(existing);
        } catch (error) {
          processed = {
            error: error instanceof Error ? error.message : String(error),
            outcome: "processing_failed",
            stage: "result_processing",
          };
        }
        if (processed.outcome === "pending") return;
        if (processed.outcome === "completed") {
          const completed = {
            ...existing,
            ...(processed.evidencePath
              ? { evidencePath: processed.evidencePath }
              : {}),
            failedStage: undefined,
            lastError: undefined,
            nextAction: undefined,
            phase: "completed" as const,
            updatedAt: now().toISOString(),
          };
          writeJsonAtomic(statePath, completed);
          processed.cleanup?.();
          return;
        }
        if (processed.outcome === "processing_failed") {
          writeJsonAtomic(statePath, {
            ...existing,
            failedStage: processed.stage ?? "result_processing",
            lastError: processed.error ?? "automatic draft review processing failed",
            nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"draft\"}",
            phase: "processing_failed",
            processingAttempts: (existing.processingAttempts ?? 0) + 1,
            updatedAt: now().toISOString(),
          });
          return;
        }
        writeJsonAtomic(statePath, {
          ...existing,
          failedStage: processed.stage ?? "review_result",
          lastError: processed.error ?? "automatic draft reviewer failed",
          nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"draft\"}",
          phase: "failed",
          runId: undefined,
          updatedAt: now().toISOString(),
        });
        return;
      }
      let batch: DraftSleepBatch | undefined;
      try {
        batch = existing?.phase === "captured" || existing?.phase === "failed"
          ? {
              batchId: existing.batchId,
              inputPath: existing.inputPath,
              reviewerInputPath: existing.reviewerInputPath,
              sourcePaths: existing.sourcePaths,
            }
          : captureDraftSleepBatchLocked(
              deps,
              draftRoot,
              recipeRoot,
              statePath,
            );
        if (!batch) return;
        const attempts = (existing?.batchId === batch.batchId ? existing.attempts : 0) + 1;
        if (attempts > 3) return;
        const launched = deps.launch(batch);
        writeJsonAtomic(statePath, {
          attempts,
          batchId: batch.batchId,
          inputPath: batch.inputPath,
          phase: "launched",
          reviewerInputPath: batch.reviewerInputPath,
          runId: launched.run,
          sourcePaths: batch.sourcePaths,
          updatedAt: now().toISOString(),
        } satisfies DraftSleepState);
      } catch (error) {
        if (!batch) return;
        const prior = readState(statePath);
        writeJsonAtomic(statePath, {
          attempts: (prior?.batchId === batch.batchId ? prior.attempts : 0) + 1,
          failedStage: "review_launch",
          lastError: error instanceof Error ? error.message : String(error),
          nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"draft\"}",
          batchId: batch.batchId,
          inputPath: batch.inputPath,
          phase: "failed",
          reviewerInputPath: batch.reviewerInputPath,
          sourcePaths: batch.sourcePaths,
          updatedAt: now().toISOString(),
        } satisfies DraftSleepState);
      }
        });
      } catch {
        /* another session owns the durable admission transition */
      }
    }, deps.delayMs ?? DEFAULT_DELAY_MS);
    timer.unref?.();
  };
  return { close, schedule };
}

export function draftSleepRunId(batchId: string): string {
  return `draft-sleep-${basename(batchId)}`;
}
