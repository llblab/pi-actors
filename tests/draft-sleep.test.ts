/**
 * Automatic draft-sleep scheduling regressions.
 * Covers the twelve-draft threshold, exact immutable batches, deferred actor load, and duplicate launch suppression.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  captureDraftSleepBatch,
  createDraftSleepScheduler,
  DRAFT_SLEEP_THRESHOLD,
  processDraftSleepReview,
  type DraftSleepBatch,
  type DraftSleepState,
} from "../lib/draft-sleep.ts";
import type { DraftReviewInput } from "../lib/draft-review.ts";
import * as ReviewProjection from "../lib/review-projection.ts";
import {
  getRecipeUsageLedgerPath,
  readRecipeUsage,
  recordRecipeLaunch,
} from "../lib/recipes-usage.ts";

const BATCH_ID = "12345678-1234-1234-1234-123456789abc";

async function fixture(count: number) {
  const agentRoot = await mkdtemp(join(tmpdir(), "pi-actors-draft-sleep-"));
  const recipeRoot = join(agentRoot, "recipes");
  const draftRoot = join(recipeRoot, "drafts");
  const statePath = join(agentRoot, "tmp", "draft-sleep", "state.json");
  await mkdir(draftRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const path = join(draftRoot, `draft_${String(index).padStart(2, "0")}.json`);
    await writeFile(path, JSON.stringify({
      description: `Draft ${index}`,
      template: `echo ${index}`,
    }));
    recordRecipeLaunch(path, new Date(`2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`), "spawn", recipeRoot);
  }
  return { agentRoot, draftRoot, recipeRoot, statePath };
}

function captureOptions(paths: Awaited<ReturnType<typeof fixture>>) {
  return {
    activeTools: () => [],
    batchRoot: (batchId: string) => join(paths.agentRoot, "tmp", "draft-sleep", "batches", batchId),
    createBatchId: () => BATCH_ID,
    draftRoot: paths.draftRoot,
    now: () => new Date("2026-01-02T00:00:00.000Z"),
    recipeRoot: paths.recipeRoot,
    statePath: paths.statePath,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for draft-sleep fixture.");
}

test("Draft sleep does not capture below twelve drafts", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD - 1);
  try {
    assert.equal(captureDraftSleepBatch(captureOptions(paths)), undefined);
    assert.equal(existsSync(paths.statePath), false);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep excludes unchanged demotions until their executable revision changes", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  const demotedPath = join(paths.draftRoot, "draft_00.json");
  const ledgerPath = getRecipeUsageLedgerPath("draft_00", paths.recipeRoot);
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    await writeFile(ledgerPath, JSON.stringify({
      ...ledger,
      demoted_fingerprint: ledger.fingerprint,
    }));
    assert.equal(captureDraftSleepBatch(captureOptions(paths)), undefined);

    await writeFile(demotedPath, JSON.stringify({ template: "echo revised" }));
    const batch = captureDraftSleepBatch(captureOptions(paths));
    assert.ok(batch);
    const input = JSON.parse(await readFile(batch.inputPath, "utf8")) as DraftReviewInput;
    const demoted = input.drafts.find((draft) => draft.path === demotedPath);
    assert.ok(demoted);
    assert.notEqual(
      demoted.usage?.fingerprint,
      demoted.usage?.demoted_fingerprint,
    );
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep captures exactly twelve immutable drafts and leaves newer work", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD + 1);
  try {
    const batch = captureDraftSleepBatch(captureOptions(paths))!;
    const input = JSON.parse(await readFile(batch.inputPath, "utf8")) as DraftReviewInput;

    assert.equal(input.drafts.length, DRAFT_SLEEP_THRESHOLD);
    assert.equal(batch.sourcePaths.length, DRAFT_SLEEP_THRESHOLD);
    assert.equal(input.drafts.some((draft) => draft.path.endsWith("draft_12.json")), false);
    assert.equal(input.drafts[0]?.usage?.lifetime_calls, 1);
    const reviewerInput = await readFile(batch.reviewerInputPath, "utf8");
    assert.equal(reviewerInput.includes('"recipe"'), false);
    assert.equal(reviewerInput.includes(paths.draftRoot), false);
    assert.equal(reviewerInput.includes('"template"'), false);
    assert.equal(existsSync(join(paths.draftRoot, "draft_12.json")), true);
    assert.equal(JSON.parse(await readFile(paths.statePath, "utf8")).phase, "captured");
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep defers under actor load and launches one silent batch later", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  let active = true;
  const launched: DraftSleepBatch[] = [];
  try {
    const scheduler = createDraftSleepScheduler({
      ...captureOptions(paths),
      delayMs: 1,
      hasActiveActors: () => active,
      launch: (batch) => {
        launched.push(batch);
        return { run: `draft-sleep-${batch.batchId}` };
      },
    });
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(launched.length, 0);

    active = false;
    scheduler.schedule();
    await waitFor(() => launched.length === 1);
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(launched.length, 1);
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(state.phase, "launched");
    assert.equal(state.attempts, 1);
    scheduler.close();
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Concurrent draft sleep schedulers launch one claimed batch", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  const launches: string[] = [];
  try {
    const schedulerDeps = {
      ...captureOptions(paths),
      delayMs: 1,
      hasActiveActors: () => false,
      launch: (batch: DraftSleepBatch) => {
        launches.push(batch.batchId);
        return { run: `draft-sleep-${batch.batchId}` };
      },
    };
    const first = createDraftSleepScheduler(schedulerDeps);
    const second = createDraftSleepScheduler(schedulerDeps);
    first.schedule();
    second.schedule();
    await waitFor(() => existsSync(paths.statePath));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(launches, [BATCH_ID]);
    assert.equal(JSON.parse(await readFile(paths.statePath, "utf8")).phase, "launched");
    first.close();
    second.close();
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep applies one promotion, discards the batch, and preserves newer drafts", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD + 1);
  const runDir = join(paths.agentRoot, "run");
  try {
    const batch = captureDraftSleepBatch(captureOptions(paths))!;
    const input = JSON.parse(await readFile(batch.inputPath, "utf8")) as DraftReviewInput;
    await mkdir(runDir, { recursive: true });
    const decisions = input.drafts.map((draft, index) => ({
      action: index === 0 ? "promote" : "discard",
      assessment: {
        flexibility: 0.8,
        futureUsefulness: 0.7,
        launches: Number(draft.usage?.lifetime_calls ?? 0),
        safety: "Validated local recipe.",
        universality: 0.7,
      },
      draft: ReviewProjection.draftReviewIdentity(index),
      rationale: index === 0 ? "Reusable capability." : "One-off draft.",
      ...(index === 0
        ? {
            target: "promoted_tool",
            targetSha256: null,
          }
        : {}),
      sha256: ReviewProjection.draftReviewRevision(input, index),
    }));
    await writeFile(
      join(runDir, "stdout.log"),
      `analysis\nDRAFT_REVIEW_RESULT\n${JSON.stringify({
        batchId: input.batchId,
        createdAt: "2026-01-03T00:00:00.000Z",
        decisions,
      })}\n`,
    );
    const state: DraftSleepState = {
      attempts: 1,
      batchId: batch.batchId,
      inputPath: batch.inputPath,
      phase: "launched",
      reviewerInputPath: batch.reviewerInputPath,
      runId: "review-run",
      sourcePaths: batch.sourcePaths,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    const processed = processDraftSleepReview(state, {
      getRunStatus: () => ({ state_dir: runDir, status: "done" }),
      now: () => new Date("2026-01-04T00:00:00.000Z"),
      recipeRoot: paths.recipeRoot,
    });

    assert.equal(processed.outcome, "completed");
    assert.equal(existsSync(join(paths.recipeRoot, "promoted_tool.json")), true);
    assert.equal(existsSync(join(paths.draftRoot, "draft_00.json")), false);
    assert.equal(existsSync(join(paths.draftRoot, "draft_11.json")), false);
    assert.equal(existsSync(join(paths.draftRoot, "draft_12.json")), true);
    assert.equal(
      readRecipeUsage(join(paths.recipeRoot, "promoted_tool.json"), paths.recipeRoot)
        ?.lineage_name,
      "promoted_tool",
    );
    assert.equal(existsSync(join(dirname(batch.inputPath), "quarantine")), true);
    processed.cleanup?.();
    assert.equal(existsSync(join(dirname(batch.inputPath), "quarantine")), false);
    const evidence = JSON.parse(await readFile(processed.evidencePath!, "utf8"));
    assert.equal(evidence.garbageCollection.status, "completed");
    assert.equal(evidence.garbageCollection.reviewedSources, DRAFT_SLEEP_THRESHOLD);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft transaction recovery ignores changed, malformed, and missing reviewer state", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  const runDir = join(paths.agentRoot, "run-retry");
  try {
    const batch = captureDraftSleepBatch(captureOptions(paths))!;
    const input = JSON.parse(await readFile(batch.inputPath, "utf8")) as DraftReviewInput;
    await mkdir(runDir, { recursive: true });
    const decisions = (target: string) => input.drafts.map((draft, index) => ({
      action: index === 0 ? "promote" : "discard",
      assessment: {
        flexibility: 0.8,
        futureUsefulness: 0.7,
        launches: Number(draft.usage?.lifetime_calls ?? 0),
        safety: "Validated structural projection.",
        universality: 0.7,
      },
      draft: ReviewProjection.draftReviewIdentity(index),
      rationale: index === 0 ? "Reusable capability." : "One-off draft.",
      ...(index === 0 ? { target, targetSha256: null } : {}),
      sha256: ReviewProjection.draftReviewRevision(input, index),
    }));
    const writeResult = async (target: string) => writeFile(
      join(runDir, "stdout.log"),
      `DRAFT_REVIEW_RESULT\n${JSON.stringify({
        batchId: input.batchId,
        createdAt: "2026-01-03T00:00:00.000Z",
        decisions: decisions(target),
      })}\n`,
    );
    await writeResult("original_target");
    await rm(join(paths.recipeRoot, ".usage"), { recursive: true, force: true });
    const state: DraftSleepState = {
      attempts: 1,
      batchId: batch.batchId,
      inputPath: batch.inputPath,
      phase: "launched",
      reviewerInputPath: batch.reviewerInputPath,
      runId: "review-run",
      sourcePaths: batch.sourcePaths,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const first = processDraftSleepReview(state, {
      getRunStatus: () => ({ state_dir: runDir, status: "done" }),
      recipeRoot: paths.recipeRoot,
    });
    assert.equal(first.outcome, "processing_failed");
    assert.equal(existsSync(join(paths.recipeRoot, "original_target.json")), true);
    assert.equal(
      recordRecipeLaunch(
        join(paths.recipeRoot, "original_target.json"),
        new Date("2026-01-04T00:00:00.000Z"),
        "tool",
        paths.recipeRoot,
      ),
      true,
    );

    await writeResult("divergent_target");
    const recover = () => processDraftSleepReview(state, {
      getRunStatus: () => {
        throw new Error("reviewer state must not be consulted after journal creation");
      },
      recipeRoot: paths.recipeRoot,
    });
    const recovered = recover();
    assert.equal(recovered.outcome, "completed");
    assert.equal(existsSync(join(paths.recipeRoot, "original_target.json")), true);
    assert.equal(existsSync(join(paths.recipeRoot, "divergent_target.json")), false);
    const evidence = JSON.parse(await readFile(recovered.evidencePath!, "utf8"));
    assert.equal(evidence.decisions[0].target, "original_target");

    await writeFile(join(runDir, "stdout.log"), "malformed reviewer output");
    assert.equal(recover().outcome, "completed");
    await rm(join(runDir, "stdout.log"));
    assert.equal(recover().outcome, "completed");
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep persists completion before destructive garbage collection", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  let cleanupObservedPhase = "";
  try {
    const batch = captureDraftSleepBatch(captureOptions(paths))!;
    await writeFile(paths.statePath, JSON.stringify({
      attempts: 1,
      batchId: batch.batchId,
      inputPath: batch.inputPath,
      phase: "launched",
      runId: "review-run",
      sourcePaths: batch.sourcePaths,
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    const scheduler = createDraftSleepScheduler({
      ...captureOptions(paths),
      delayMs: 1,
      hasActiveActors: () => false,
      launch: () => {
        throw new Error("unexpected launch");
      },
      process: () => ({
        cleanup: () => {
          cleanupObservedPhase = JSON.parse(
            readFileSync(paths.statePath, "utf8"),
          ).phase;
        },
        evidencePath: join(paths.agentRoot, "evidence.json"),
        outcome: "completed",
      }),
    });
    scheduler.schedule();
    await waitFor(() => cleanupObservedPhase !== "");
    assert.equal(cleanupObservedPhase, "completed");
    scheduler.close();
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep classifies missing reviewer run state without throwing", () => {
  assert.deepEqual(
    processDraftSleepReview(
      {
        attempts: 1,
        batchId: "12345678-1234-1234-1234-123456789abc",
        inputPath: "/missing/input.json",
        phase: "launched",
        reviewerInputPath: "/missing/review-input.json",
        runId: "missing-run",
        sourcePaths: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { getRunStatus: () => { throw new Error("run missing"); } },
    ),
    { error: "run missing", outcome: "review_failed", stage: "review_state" },
  );
});

test("Draft sleep bounds unexpected result-processing failures", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  let attempts = 0;
  try {
    const batch = captureDraftSleepBatch(captureOptions(paths))!;
    await writeFile(paths.statePath, JSON.stringify({
      attempts: 1,
      batchId: batch.batchId,
      inputPath: batch.inputPath,
      phase: "launched",
      runId: "review-run",
      sourcePaths: batch.sourcePaths,
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    const scheduler = createDraftSleepScheduler({
      ...captureOptions(paths),
      delayMs: 1,
      hasActiveActors: () => false,
      launch: () => { throw new Error("unexpected launch"); },
      process: () => {
        attempts += 1;
        throw new Error("corrupt reviewer state");
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      scheduler.schedule();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    assert.equal(attempts, 3);
    assert.equal(state.phase, "processing_failed");
    assert.equal(state.processingAttempts, 3);
    assert.equal(state.failedStage, "result_processing");
    assert.equal(state.lastError, "corrupt reviewer state");
    assert.match(state.nextAction, /review\.retry/);
    scheduler.close();
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Draft sleep rate-limits launch failures to three post-turn attempts", async () => {
  const paths = await fixture(DRAFT_SLEEP_THRESHOLD);
  let attempts = 0;
  try {
    const scheduler = createDraftSleepScheduler({
      ...captureOptions(paths),
      delayMs: 1,
      hasActiveActors: () => false,
      launch: () => {
        attempts += 1;
        throw new Error("review unavailable");
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      scheduler.schedule();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(await readFile(paths.statePath, "utf8")).phase, "failed");
    scheduler.close();
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});
