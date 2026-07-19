/**
 * Automatic review diagnostic regressions.
 * Covers bounded cycle, decision, lineage, demotion, rollback, and snapshot evidence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../lib/file-state.ts";
import { readAutomaticReviewDiagnostics } from "../lib/review-diagnostics.ts";
import {
  getRecipeRevisionSnapshotPath,
  getRecipeUsageLedgerPath,
} from "../lib/recipes-usage.ts";

test("Automatic review diagnostics expose bounded failure remediation", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-review-failure-"));
  const draftStatePath = join(root, "draft-state.json");
  try {
    writeJsonAtomic(draftStatePath, {
      attempts: 3,
      failedStage: "result_validation",
      lastError: "x".repeat(700),
      nextAction: "message to=tool:pi-actors type=review.retry body={\"scope\":\"draft\"}",
      phase: "processing_failed",
      processingAttempts: 3,
    });
    const diagnostics = readAutomaticReviewDiagnostics({ draftStatePath });
    const draft = diagnostics.draft_review as Record<string, unknown>;
    assert.equal(draft.failed_stage, "result_validation");
    assert.equal(String(draft.last_error).length <= 500, true);
    assert.match(String(draft.next_action), /review\.retry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Automatic review diagnostics expose bounded semantic evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-review-diagnostics-"));
  const recipeRoot = join(root, "recipes");
  const draftStatePath = join(root, "draft-state.json");
  const toolStatePath = join(root, "tool-state.json");
  const cycleDir = join(root, "tool-cycle");
  try {
    mkdirSync(recipeRoot, { recursive: true });
    const draftEvidencePath = join(root, "draft-evidence.json");
    writeJsonAtomic(draftEvidencePath, {
      decisions: [{ action: "promote" }, { action: "discard" }],
      garbageCollection: { reviewedSources: 2, status: "completed" },
    });
    writeJsonAtomic(draftStatePath, {
      attempts: 1,
      batchId: "draft-batch",
      evidencePath: draftEvidencePath,
      phase: "completed",
      sourcePaths: ["one", "two"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const approvedPath = join(cycleDir, "approved.json");
    const lineageJournalPath = `${approvedPath}.lineage-journal.json`;
    writeJsonAtomic(approvedPath, {
      decisions: [{ action: "keep" }, { action: "demote" }],
      reviewId: "tool-review",
      sources: [{}, {}],
      targets: [{}],
    });
    writeJsonAtomic(join(cycleDir, "journal.json"), { phase: "committed" });
    writeJsonAtomic(lineageJournalPath, { phase: "committed" });
    writeJsonAtomic(toolStatePath, {
      approvedPath,
      attempts: 1,
      lineageJournalPath,
      phase: "completed",
      reviewId: "tool-review",
      toolNames: ["one", "two"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    writeJsonAtomic(getRecipeUsageLedgerPath("demoted", recipeRoot), {
      current_path: "drafts/demoted.json",
      demoted_at: "2026-01-02T00:00:00.000Z",
      demoted_from_revision: 2,
      lifetime_calls: 4,
      lineage_name: "demoted",
      review_epochs: ["tool-review"],
      revision: 3,
      revision_calls: 0,
      rollback_of_revision: 1,
    });
    writeJsonAtomic(getRecipeRevisionSnapshotPath("demoted", 1, recipeRoot), {
      type: "recipe_revision_snapshot",
    });

    const diagnostics = readAutomaticReviewDiagnostics({
      draftStatePath,
      recipeRoot,
      toolStatePath,
    });
    const draft = diagnostics.draft_review as Record<string, unknown>;
    const tool = diagnostics.tool_review as Record<string, unknown>;
    assert.equal(draft.phase, "completed");
    assert.deepEqual((draft.evidence as Record<string, unknown>).actions, {
      discard: 1,
      promote: 1,
    });
    assert.equal(tool.phase, "completed");
    assert.equal((tool.evidence as Record<string, unknown>).lineage_phase, "committed");
    assert.equal(diagnostics.lineage_count, 1);
    assert.equal(diagnostics.revision_snapshots, 1);
    assert.equal(JSON.stringify(diagnostics).includes("template"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
