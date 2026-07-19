/**
 * Automatic review operator-control regressions.
 * Covers explicit retry/reset transitions without bypassing recovery evidence.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { controlAutomaticReview } from "../lib/review-control.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-review-control-"));
  const draftStatePath = join(root, "draft-state.json");
  const toolStatePath = join(root, "tool-state.json");
  mkdirSync(root, { recursive: true });
  return { draftStatePath, root, toolStatePath };
}

test("Draft review retry returns a failed immutable batch to capture launch", () => {
  const fx = fixture();
  let scheduled = 0;
  try {
    writeFileSync(fx.draftStatePath, JSON.stringify({
      attempts: 3,
      batchId: "batch",
      failedStage: "result_validation",
      inputPath: "/batch/input.json",
      lastError: "invalid decision",
      nextAction: "retry",
      phase: "processing_failed",
      processingAttempts: 3,
      sourcePaths: ["/draft.json"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const result = controlAutomaticReview("review.retry", "draft", {
      draftStatePath: fx.draftStatePath,
      scheduleDraft: () => { scheduled += 1; },
    });
    assert.equal(result.changed, true);
    assert.equal(result.phase, "captured");
    assert.equal(scheduled, 1);
    const state = JSON.parse(readFileSync(fx.draftStatePath, "utf8"));
    assert.equal(state.attempts, 0);
    assert.equal(state.processingAttempts, 0);
    assert.equal(state.lastError, undefined);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Draft retry resumes an existing transaction without another reviewer", () => {
  const fx = fixture();
  let scheduled = 0;
  try {
    const inputPath = join(fx.root, "batch", "input.json");
    mkdirSync(join(fx.root, "batch"), { recursive: true });
    writeFileSync(join(fx.root, "batch", "journal.json"), "{}");
    writeFileSync(fx.draftStatePath, JSON.stringify({
      attempts: 1,
      batchId: "batch",
      inputPath,
      phase: "processing_failed",
      processingAttempts: 3,
      reviewerInputPath: join(fx.root, "batch", "review-input.json"),
      runId: "original-review-run",
      sourcePaths: ["/draft.json"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const result = controlAutomaticReview("review.retry", "draft", {
      draftStatePath: fx.draftStatePath,
      scheduleDraft: () => { scheduled += 1; },
    });
    const state = JSON.parse(readFileSync(fx.draftStatePath, "utf8"));
    assert.equal(result.phase, "launched");
    assert.equal(state.runId, "original-review-run");
    assert.equal(scheduled, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Tool review retry preserves committed transaction recovery", () => {
  const fx = fixture();
  let scheduled = 0;
  try {
    writeFileSync(fx.toolStatePath, JSON.stringify({
      approvedPath: "/review/approved.json",
      attempts: 1,
      inputPath: "/review/input.json",
      phase: "processing_failed",
      reviewId: "review",
      toolNames: [],
      transactionEvidencePath: "/review/transaction-evidence.json",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const result = controlAutomaticReview("review.retry", "tool", {
      scheduleTool: () => { scheduled += 1; },
      toolStatePath: fx.toolStatePath,
    });
    assert.equal(result.phase, "lineage_pending");
    assert.equal(scheduled, 1);
    assert.equal(JSON.parse(readFileSync(fx.toolStatePath, "utf8")).approvedPath, "/review/approved.json");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Review reset clears disposable failure but preserves recovery evidence", () => {
  const fx = fixture();
  try {
    writeFileSync(fx.draftStatePath, JSON.stringify({ phase: "failed" }));
    const reset = controlAutomaticReview("review.reset", "draft", {
      draftStatePath: fx.draftStatePath,
    });
    assert.equal(reset.changed, true);
    assert.equal(existsSync(fx.draftStatePath), false);

    writeFileSync(fx.toolStatePath, JSON.stringify({
      approvedPath: "/review/approved.json",
      phase: "processing_failed",
    }));
    const rejected = controlAutomaticReview("review.reset", "tool", {
      toolStatePath: fx.toolStatePath,
    });
    assert.equal(rejected.changed, false);
    assert.equal(rejected.reason, "review_recovery_evidence_requires_retry");
    assert.equal(existsSync(fx.toolStatePath), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
