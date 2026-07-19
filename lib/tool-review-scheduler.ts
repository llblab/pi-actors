/**
 * Automatic active-tool portfolio review admission.
 * Zones: revision eligibility, immutable thirty-six-tool capture, persisted review state
 * Owns exact portfolio admission; reviewer execution and recipe mutation remain separate domains.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";
import * as Paths from "./paths.ts";
import * as RecipesDiscovery from "./recipes-discovery.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import * as ReviewProjection from "./review-projection.ts";
import * as ToolReviewLineage from "./tool-review-lineage.ts";
import * as ToolReviewLineageTransaction from "./tool-review-lineage-transaction.ts";
import * as ToolReviewTransaction from "./tool-review-transaction.ts";
import { findUnsafeRecipeReason } from "./draft-review.ts";
import {
  parseToolReviewResult,
  TOOL_REVIEW_THRESHOLD,
  validateToolReviewInput,
  validateToolReviewResult,
  type ToolReviewDecision,
  type ToolReviewInput,
  type ToolReviewTool,
} from "./tool-review.ts";

export const TOOL_REVIEW_RESULT_MAX_BYTES = 16 * 1024 * 1024;

export interface ToolReviewBatch {
  inputPath: string;
  reviewerInputPath: string;
  reviewId: string;
  toolNames: string[];
}

export interface ToolReviewAdmissionState {
  approvedPath?: string;
  attempts: number;
  failedStage?: string;
  lastError?: string;
  lineageJournalPath?: string;
  inputPath: string;
  nextAction?: string;
  phase: "approved" | "captured" | "completed" | "failed" | "launched" | "lineage_pending" | "processing_failed";
  processingAttempts?: number;
  reviewerInputPath: string;
  reviewId: string;
  runId?: string;
  toolNames: string[];
  transactionEvidencePath?: string;
  updatedAt: string;
}

export interface ToolReviewSchedulerDeps extends CaptureToolReviewOptions {
  delayMs?: number;
  hasActiveActors(): boolean;
  launch(batch: ToolReviewBatch): { run: string };
  process?(state: ToolReviewAdmissionState): ToolReviewProcessResult;
}

export interface ToolReviewProcessResult {
  approvedPath?: string;
  error?: string;
  outcome: "approved" | "pending" | "processing_failed" | "review_failed";
  stage?: string;
}

export interface ToolReviewScheduler {
  close(): void;
  schedule(): void;
}

export interface CaptureToolReviewOptions {
  batchRoot?(reviewId: string): string;
  createReviewId?(): string;
  now?(): Date;
  recipeRoot?: string;
  statePath?: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readAdmissionState(path: string): ToolReviewAdmissionState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ToolReviewAdmissionState;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function usageOrder(tool: ToolReviewTool): string {
  const firstSeen = tool.usage?.first_seen;
  return typeof firstSeen === "string" ? firstSeen : "";
}

export function listEligibleToolReviewRecipes(
  recipeRoot = Paths.getRecipeRoot(),
  now = new Date(),
): ToolReviewTool[] {
  const discovered = RecipesDiscovery.discoverRecipeSources([
    { root: recipeRoot, defaultTool: true, mutableUsage: true },
  ]);
  return [...discovered.active.values()]
    .filter((entry) => entry.active && entry.tool && !entry.invalid && !entry.disabled)
    .flatMap((entry) => {
      if (!RecipesUsage.ensureRecipeLineage(entry.path, now, recipeRoot)) return [];
      if (RecipesUsage.isCurrentRecipeRevisionReviewed(entry.path, recipeRoot)) return [];
      const recipe = RecipesReferences.readRawRecipeConfig(entry.path);
      if (
        !recipe ||
        entry.riskLabels.includes("risk.secret_touching") ||
        findUnsafeRecipeReason(recipe)
      ) return [];
      return [{
        name: entry.id,
        path: entry.path,
        recipe,
        riskLabels: [...entry.riskLabels],
        sha256: sha256(entry.path),
        usage: RecipesUsage.readRecipeUsage(entry.path, recipeRoot),
        valid: true,
      } satisfies ToolReviewTool];
    })
    .sort((left, right) =>
      usageOrder(left).localeCompare(usageOrder(right)) ||
      left.name.localeCompare(right.name),
    );
}

function captureToolReviewBatchLocked(
  options: CaptureToolReviewOptions,
  recipeRoot: string,
  statePath: string,
  now: () => Date,
): ToolReviewBatch | undefined {
  const state = readAdmissionState(statePath);
  if (
    state?.phase === "captured" ||
    state?.phase === "launched" ||
    state?.phase === "processing_failed"
  ) return undefined;
  const eligible = listEligibleToolReviewRecipes(recipeRoot, now());
  if (eligible.length < TOOL_REVIEW_THRESHOLD) return undefined;
  const reviewId = (options.createReviewId ?? randomUUID)();
  const inputPath = join(
    (options.batchRoot ?? Paths.getToolReviewBatchDir)(reviewId),
    "input.json",
  );
  const tools = eligible.slice(0, TOOL_REVIEW_THRESHOLD);
  const input: ToolReviewInput = {
    createdAt: now().toISOString(),
    reviewId,
    tools,
  };
  const validation = validateToolReviewInput(input);
  if (!validation.ok) {
    throw new Error(`Tool review input rejected: ${validation.errors.join("; ")}`);
  }
  writeJsonAtomic(inputPath, input);
  const reviewerInputPath = join(dirname(inputPath), "review-input.json");
  writeJsonAtomic(reviewerInputPath, ReviewProjection.projectToolReviewInput(input));
  const toolNames = tools.map((tool) => tool.name);
  writeJsonAtomic(statePath, {
    attempts: 0,
    inputPath,
    phase: "captured",
    reviewerInputPath,
    reviewId,
    toolNames,
    updatedAt: input.createdAt,
  } satisfies ToolReviewAdmissionState);
  return { inputPath, reviewerInputPath, reviewId, toolNames };
}

export function captureToolReviewBatch(
  options: CaptureToolReviewOptions = {},
): ToolReviewBatch | undefined {
  const recipeRoot = options.recipeRoot ?? Paths.getRecipeRoot();
  const statePath = options.statePath ?? Paths.getToolReviewStatePath();
  const now = options.now ?? (() => new Date());
  return withFileMutationLock(statePath, () =>
    captureToolReviewBatchLocked(options, recipeRoot, statePath, now),
  );
}

function approvedTargets(
  input: ToolReviewInput,
  decisions: ToolReviewDecision[],
  recipeRoot: string,
): ToolReviewTransaction.ToolReviewApprovedTarget[] {
  const targets = new Map<string, ToolReviewTransaction.ToolReviewApprovedTarget>();
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const add = (
    name: string,
    path: string,
    recipe: Record<string, unknown>,
    lineage: ToolReviewTransaction.ToolReviewApprovedTarget["lineage"],
    source: string,
  ): void => {
    const existing = targets.get(path);
    if (existing) {
      if (lineage !== "merge" || existing.lineage !== "merge") {
        throw new Error(`Duplicate tool review target: ${path}`);
      }
      existing.sources.push(source);
      return;
    }
    const sourceAtPath = input.tools.find((tool) => tool.path === path);
    if (existsSync(path) && !sourceAtPath) {
      throw new Error(`Tool review target appeared after capture: ${path}`);
    }
    targets.set(path, {
      expectedSha256: sourceAtPath?.sha256 ?? null,
      lineage,
      name,
      path,
      recipe,
      sources: [source],
    });
  };
  for (const decision of decisions) {
    const source = tools.get(decision.source)!;
    if (decision.action === "keep") continue;
    if (decision.action === "demote") {
      add(
        decision.source,
        join(recipeRoot, "drafts", `${decision.source}.json`),
        source.recipe,
        "demote",
        decision.source,
      );
      continue;
    }
    if (decision.action === "evolve") {
      const source = tools.get(decision.source)!;
      add(
        decision.target!,
        join(recipeRoot, `${decision.target}.json`),
        source.recipe,
        "evolve",
        decision.source,
      );
      continue;
    }
    if (decision.action === "merge") {
      const source = tools.get(decision.source)!;
      add(
        decision.target!,
        join(recipeRoot, `${decision.target}.json`),
        source.recipe,
        "merge",
        decision.source,
      );
      continue;
    }
    throw new Error(
      `${decision.action} requires explicit operator-authored recipe mutation.`,
    );
  }
  return [...targets.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export interface ProcessToolReviewDeps {
  draftRoot?: string;
  getRunStatus(runId: string): Record<string, unknown>;
  now?(): Date;
  recipeRoot?: string;
}

export function processToolReviewResult(
  state: ToolReviewAdmissionState,
  deps: ProcessToolReviewDeps,
): ToolReviewProcessResult {
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
  let input: ToolReviewInput;
  let result: ReturnType<typeof parseToolReviewResult>;
  try {
    input = JSON.parse(readFileSync(state.inputPath, "utf8")) as ToolReviewInput;
    const stdoutPath = join(status.state_dir, "stdout.log");
    if (statSync(stdoutPath).size > TOOL_REVIEW_RESULT_MAX_BYTES) {
      throw new Error("Tool reviewer output exceeds the approval limit.");
    }
    result = ReviewProjection.restoreToolReviewResult(
      input,
      parseToolReviewResult(readFileSync(stdoutPath, "utf8")),
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      outcome: "review_failed",
      stage: "result_parse",
    };
  }
  const validation = validateToolReviewResult(input, result);
  if (!validation.ok) {
    return {
      error: validation.errors.join("; "),
      outcome: "review_failed",
      stage: "result_validation",
    };
  }
  try {
    for (const tool of input.tools) {
      if (!existsSync(tool.path) || sha256(tool.path) !== tool.sha256) {
        throw new Error(`Reviewed tool changed after capture: ${tool.name}`);
      }
    }
    const recipeRoot = deps.recipeRoot ?? Paths.getRecipeRoot();
    const plan: ToolReviewTransaction.ToolReviewApprovedPlan = {
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      decisions: result.decisions,
      reviewId: state.reviewId,
      sources: result.decisions.map((decision) => {
        const tool = input.tools.find((candidate) => candidate.name === decision.source)!;
        return {
          action: decision.action,
          name: tool.name,
          path: tool.path,
          sha256: tool.sha256,
        };
      }),
      targets: approvedTargets(input, result.decisions, recipeRoot),
    };
    ToolReviewLineage.projectToolReviewLineage(plan);
    if (Buffer.byteLength(JSON.stringify(plan)) > TOOL_REVIEW_RESULT_MAX_BYTES) {
      throw new Error("Tool review approved plan exceeds the persistence limit.");
    }
    const approvedPath = join(dirname(state.inputPath), "approved.json");
    writeJsonAtomic(approvedPath, plan);
    return { approvedPath, outcome: "approved" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      outcome: "processing_failed",
      stage: "approval",
    };
  }
}

export interface ToolReviewBoundaryResult {
  outcome: "completed" | "lineage_pending" | "none" | "processing_failed";
  state?: ToolReviewAdmissionState;
}

export function applyApprovedToolReviewAtSessionBoundary(
  options: {
    lifecycleHooks?: {
      onCompleted?(): void;
      onLineagePending?(): void;
      onStateLocked?(): void;
    };
    now?(): Date;
    recipeRoot?: string;
    statePath?: string;
  } = {},
): ToolReviewBoundaryResult {
  const statePath = options.statePath ?? Paths.getToolReviewStatePath();
  const recipeRoot = options.recipeRoot ?? Paths.getRecipeRoot();
  return withFileMutationLock(statePath, () => {
    options.lifecycleHooks?.onStateLocked?.();
    const state = readAdmissionState(statePath);
    if (!state) return { outcome: "none" };
    if (state.phase === "completed") {
      if (state.approvedPath) {
        rmSync(join(dirname(state.approvedPath), "quarantine"), {
          recursive: true,
          force: true,
        });
      }
      return { outcome: "completed", state };
    }
    if (state.phase !== "approved" && state.phase !== "lineage_pending") {
      return { outcome: "none" };
    }
    if (!state.approvedPath) {
      const failed = {
        ...state,
        failedStage: "approval_state",
        lastError: "approved review path is unavailable",
        nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
        phase: "processing_failed" as const,
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      writeJsonAtomic(statePath, failed);
      return { outcome: "processing_failed", state: failed };
    }
    try {
      const journalPath = join(dirname(state.approvedPath), "journal.json");
      const transaction = existsSync(journalPath)
        ? ToolReviewTransaction.recoverToolReviewTransaction(state.approvedPath, {
            now: options.now,
            recipeRoot,
          })
        : ToolReviewTransaction.applyToolReviewPlan(state.approvedPath, {
            now: options.now,
            recipeRoot,
          });
      if (transaction.phase !== "committed") {
        const failed = {
          ...state,
          failedStage: "transaction",
          lastError: `tool review transaction remained ${transaction.phase}`,
          nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
          phase: "processing_failed" as const,
          updatedAt: (options.now ?? (() => new Date()))().toISOString(),
        };
        writeJsonAtomic(statePath, failed);
        return { outcome: "processing_failed", state: failed };
      }
      const pending = {
        ...state,
        ...(transaction.evidencePath
          ? { transactionEvidencePath: transaction.evidencePath }
          : {}),
        phase: "lineage_pending" as const,
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      writeJsonAtomic(statePath, pending);
      options.lifecycleHooks?.onLineagePending?.();
      let lineage: ToolReviewLineageTransaction.ToolReviewLineageTransactionResult;
      try {
        lineage = ToolReviewLineageTransaction.finalizeToolReviewLineage(
          state.approvedPath,
          {
            now: options.now,
            recipeRoot,
          },
        );
      } catch (error) {
        const failedPending = {
          ...pending,
          failedStage: "lineage",
          lastError: error instanceof Error ? error.message : String(error),
          nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
        };
        writeJsonAtomic(statePath, failedPending);
        return { outcome: "lineage_pending", state: failedPending };
      }
      const completed = {
        ...pending,
        lineageJournalPath: lineage.journalPath,
        phase: "completed" as const,
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      writeJsonAtomic(statePath, completed);
      options.lifecycleHooks?.onCompleted?.();
      rmSync(transaction.quarantineDir, { recursive: true, force: true });
      return { outcome: "completed", state: completed };
    } catch (error) {
      const failed = {
        ...state,
        failedStage: "transaction",
        lastError: error instanceof Error ? error.message : String(error),
        nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
        phase: "processing_failed" as const,
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      writeJsonAtomic(statePath, failed);
      return { outcome: "processing_failed", state: failed };
    }
  });
}

export function createToolReviewScheduler(
  deps: ToolReviewSchedulerDeps,
): ToolReviewScheduler {
  const statePath = deps.statePath ?? Paths.getToolReviewStatePath();
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
          const existing = readAdmissionState(statePath);
      if (
        existing?.phase === "launched" ||
        existing?.phase === "processing_failed"
      ) {
        if (!deps.process || (existing.processingAttempts ?? 0) >= 3) return;
        let processed: ToolReviewProcessResult;
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
        if (processed.outcome === "approved") {
          writeJsonAtomic(statePath, {
            ...existing,
            ...(processed.approvedPath ? { approvedPath: processed.approvedPath } : {}),
            failedStage: undefined,
            lastError: undefined,
            nextAction: undefined,
            phase: "approved",
            updatedAt: now().toISOString(),
          } satisfies ToolReviewAdmissionState);
          return;
        }
        writeJsonAtomic(statePath, {
          ...existing,
          failedStage: processed.stage ?? "review_result",
          lastError: processed.error ?? "automatic tool reviewer failed",
          nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
          phase: processed.outcome === "processing_failed"
            ? "processing_failed"
            : "failed",
          ...(processed.outcome === "processing_failed"
            ? { processingAttempts: (existing.processingAttempts ?? 0) + 1 }
            : { runId: undefined }),
          updatedAt: now().toISOString(),
        } satisfies ToolReviewAdmissionState);
        return;
      }
      if (
        existing?.phase === "captured" ||
        existing?.phase === "failed"
      ) {
        if (existing.attempts >= 3) return;
        try {
          const launched = deps.launch({
            inputPath: existing.inputPath,
            reviewerInputPath: existing.reviewerInputPath,
            reviewId: existing.reviewId,
            toolNames: existing.toolNames,
          });
          writeJsonAtomic(statePath, {
            ...existing,
            attempts: existing.attempts + 1,
            phase: "launched",
            runId: launched.run,
            updatedAt: now().toISOString(),
          } satisfies ToolReviewAdmissionState);
        } catch (error) {
          writeJsonAtomic(statePath, {
            ...existing,
            attempts: existing.attempts + 1,
            failedStage: "review_launch",
            lastError: error instanceof Error ? error.message : String(error),
            nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
            phase: "failed",
            updatedAt: now().toISOString(),
          } satisfies ToolReviewAdmissionState);
        }
        return;
      }
      if (existing && existing.phase !== "completed") return;
      let batch: ToolReviewBatch | undefined;
      try {
        batch = captureToolReviewBatchLocked(
          deps,
          recipeRoot,
          statePath,
          now,
        );
        if (!batch) return;
        const launched = deps.launch(batch);
        writeJsonAtomic(statePath, {
          attempts: 1,
          inputPath: batch.inputPath,
          phase: "launched",
          reviewerInputPath: batch.reviewerInputPath,
          reviewId: batch.reviewId,
          runId: launched.run,
          toolNames: batch.toolNames,
          updatedAt: now().toISOString(),
        } satisfies ToolReviewAdmissionState);
      } catch (error) {
        if (!batch) return;
        writeJsonAtomic(statePath, {
          attempts: 1,
          failedStage: "review_launch",
          inputPath: batch.inputPath,
          lastError: error instanceof Error ? error.message : String(error),
          nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"tool\"}",
          phase: "failed",
          reviewerInputPath: batch.reviewerInputPath,
          reviewId: batch.reviewId,
          toolNames: batch.toolNames,
          updatedAt: now().toISOString(),
        } satisfies ToolReviewAdmissionState);
      }
        });
      } catch {
        /* another session owns the durable admission transition */
      }
    }, deps.delayMs ?? 50);
    timer.unref?.();
  };
  return { close, schedule };
}

export function toolReviewRunId(reviewId: string): string {
  return `tool-review-${reviewId}`;
}
