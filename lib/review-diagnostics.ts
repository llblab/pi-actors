/**
 * Automatic recipe-review diagnostics.
 * Zones: bounded draft/tool cycle evidence, lineage summaries, revision snapshot inventory
 * Owns read-only diagnostic projection; schedulers and transactions own mutation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import * as Paths from "./paths.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100;

function readJson(path: string | undefined): Record<string, unknown> | undefined {
  if (!path || !existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown, limit = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function strings(value: unknown, limit = 20): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(-limit)
    : [];
}

function cycleState(state: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!state) return { phase: "idle" };
  return {
    phase: text(state.phase) ?? "unknown",
    attempts: state.attempts,
    failed_stage: text(state.failedStage),
    last_error: text(state.lastError, 500),
    next_action: text(state.nextAction, 500),
    processing_attempts: state.processingAttempts,
    batch_id: text(state.batchId),
    review_id: text(state.reviewId),
    run_id: text(state.runId),
    sources: Array.isArray(state.sourcePaths) ? state.sourcePaths.length : undefined,
    tools: Array.isArray(state.toolNames) ? state.toolNames.length : undefined,
    updated_at: text(state.updatedAt),
  };
}

function draftEvidence(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const evidence = readJson(text(state?.evidencePath, 4096));
  if (!evidence) return undefined;
  const decisions = Array.isArray(evidence.decisions)
    ? evidence.decisions as Array<Record<string, unknown>>
    : [];
  const garbage = evidence.garbageCollection as Record<string, unknown> | undefined;
  return {
    actions: Object.fromEntries(
      ["promote", "discard"].map((action) => [
        action,
        decisions.filter((decision) => decision.action === action).length,
      ]),
    ),
    garbage_collection: garbage
      ? { reviewed_sources: garbage.reviewedSources, status: garbage.status }
      : undefined,
    reviewed_sources: decisions.length,
  };
}

function toolEvidence(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const approved = readJson(text(state?.approvedPath, 4096));
  if (!approved) return undefined;
  const decisions = Array.isArray(approved.decisions)
    ? approved.decisions as Array<Record<string, unknown>>
    : [];
  return {
    actions: Object.fromEntries(
      ["keep", "evolve", "replace", "demote", "merge", "split"].map((action) => [
        action,
        decisions.filter((decision) => decision.action === action).length,
      ]),
    ),
    lineage_phase: readJson(text(state?.lineageJournalPath, 4096))?.phase,
    review_id: text(approved.reviewId),
    sources: Array.isArray(approved.sources) ? approved.sources.length : 0,
    targets: Array.isArray(approved.targets) ? approved.targets.length : 0,
    transaction_phase: readJson(
      join(dirname(text(state?.approvedPath, 4096)!), "journal.json"),
    )?.phase,
  };
}

function lineageSummaries(recipeRoot: string): Record<string, unknown>[] {
  const root = join(recipeRoot, ".usage", "recipes");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(root, entry.name))
    .sort()
    .slice(0, MAX_ENTRIES)
    .flatMap((path) => {
      const record = readJson(path);
      if (!record) return [];
      return [{
        current_path: text(record.current_path),
        demoted_at: text(record.demoted_at),
        demoted_from_revision: record.demoted_from_revision,
        lifetime_calls: record.lifetime_calls,
        name: text(record.lineage_name) ?? basename(path, ".json"),
        review_epochs: strings(record.review_epochs, 5),
        revision: record.revision,
        revision_calls: record.revision_calls,
        rollback_of_revision: record.rollback_of_revision,
      }];
    });
}

function snapshotCount(recipeRoot: string): number {
  const root = join(recipeRoot, ".usage", "revisions");
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const lineage of readdirSync(root, { withFileTypes: true }).slice(0, MAX_ENTRIES)) {
    if (!lineage.isDirectory()) continue;
    count += readdirSync(join(root, lineage.name), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .length;
  }
  return count;
}

export interface AutomaticReviewDiagnosticOptions {
  draftStatePath?: string;
  recipeRoot?: string;
  toolStatePath?: string;
}

export function readAutomaticReviewDiagnostics(
  options: AutomaticReviewDiagnosticOptions = {},
): Record<string, unknown> {
  const recipeRoot = options.recipeRoot ?? Paths.getRecipeRoot();
  const draftState = readJson(options.draftStatePath ?? Paths.getDraftSleepStatePath());
  const toolState = readJson(options.toolStatePath ?? Paths.getToolReviewStatePath());
  const lineages = lineageSummaries(recipeRoot);
  return {
    draft_review: {
      ...cycleState(draftState),
      evidence: draftEvidence(draftState),
    },
    lineage_count: lineages.length,
    lineages,
    revision_snapshots: snapshotCount(recipeRoot),
    tool_review: {
      ...cycleState(toolState),
      evidence: toolEvidence(toolState),
    },
  };
}
