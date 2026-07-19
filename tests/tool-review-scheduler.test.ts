/**
 * Automatic tool-review admission regressions.
 * Covers lineage seeding, revision eligibility, exact portfolio capture, and in-flight fencing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as RecipesUsage from "../lib/recipes-usage.ts";
import * as ReviewProjection from "../lib/review-projection.ts";
import {
  captureToolReviewBatch,
  createToolReviewScheduler,
  listEligibleToolReviewRecipes,
  processToolReviewResult,
} from "../lib/tool-review-scheduler.ts";
import type { ToolReviewInput, ToolReviewResult } from "../lib/tool-review.ts";

function fixture(count = 37) {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-tool-review-"));
  const recipeRoot = join(root, "recipes");
  const statePath = join(root, "tmp", "state.json");
  mkdirSync(recipeRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(recipeRoot, `tool_${String(index).padStart(2, "0")}.json`),
      `${JSON.stringify({ description: `Tool ${index}`, template: `echo ${index}` }, null, 2)}\n`,
    );
  }
  return {
    batchRoot: (reviewId: string) => join(root, "tmp", "batches", reviewId),
    recipeRoot,
    root,
    statePath,
  };
}

test("Tool review captures the oldest exact thirty-six eligible revisions", () => {
  const paths = fixture();
  try {
    const batch = captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      createReviewId: () => "12345678-1234-1234-1234-123456789abc",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    });
    assert.equal(batch?.toolNames.length, 36);
    assert.equal(batch?.toolNames[0], "tool_00");
    assert.equal(batch?.toolNames.at(-1), "tool_35");
    const input = JSON.parse(readFileSync(batch!.inputPath, "utf8")) as ToolReviewInput;
    assert.equal(input.tools.length, 36);
    assert.equal(input.tools[0]?.usage?.lifetime_calls, 0);
    assert.equal(input.tools[0]?.usage?.revision_calls, 0);
    const reviewerInput = readFileSync(batch!.reviewerInputPath, "utf8");
    assert.equal(reviewerInput.includes('"recipe"'), false);
    assert.equal(reviewerInput.includes(paths.recipeRoot), false);
    assert.equal(reviewerInput.includes('"template"'), false);
    assert.equal(
      RecipesUsage.readRecipeUsage(join(paths.recipeRoot, "tool_36.json"), paths.recipeRoot)
        ?.lifetime_calls,
      0,
    );
    assert.equal(captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      createReviewId: () => "22345678-1234-1234-1234-123456789abc",
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    }), undefined);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Sensitive active recipes never enter automatic model review", () => {
  const paths = fixture(36);
  try {
    const sensitiveRecipes = [
      { defaults: { api_key: "literal-secret" }, template: "echo {api_key}" },
      { defaults: { accessToken: "literal-secret" }, template: "echo safe" },
      { defaults: { clientSecret: "literal-secret" }, template: "echo safe" },
      { defaults: { secretAccessKey: "literal-secret" }, template: "echo safe" },
      { defaults: { value: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" }, template: "echo safe" },
      { template: "cat ~/.aws/credentials" },
      { defaults: { region: "AWS_SECRET_ACCESS_KEY" }, template: "echo safe" },
      { template: "vault kv get secret/production" },
      { defaults: { value: "ghp_abcdefghijklmnopqrstuvwxyz123456" }, template: "echo safe" },
    ];
    sensitiveRecipes.forEach((recipe, index) => {
      writeFileSync(
        join(paths.recipeRoot, `tool_${String(index).padStart(2, "0")}.json`),
        `${JSON.stringify(recipe, null, 2)}\n`,
      );
    });
    const eligible = listEligibleToolReviewRecipes(
      paths.recipeRoot,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    assert.equal(eligible.length, 27);
    for (let index = 0; index < sensitiveRecipes.length; index += 1) {
      assert.equal(
        eligible.some((tool) => tool.name === `tool_${String(index).padStart(2, "0")}`),
        false,
      );
    }
    assert.equal(captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    }), undefined);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Reviewed revisions leave eligibility until recipe content changes", () => {
  const paths = fixture(1);
  const recipePath = join(paths.recipeRoot, "tool_00.json");
  try {
    assert.deepEqual(listEligibleToolReviewRecipes(paths.recipeRoot).map((tool) => tool.name), ["tool_00"]);
    assert.equal(
      RecipesUsage.recordRecipeReview(
        recipePath,
        "review-1",
        new Date("2026-01-01T00:00:00.000Z"),
        paths.recipeRoot,
      ),
      true,
    );
    assert.deepEqual(listEligibleToolReviewRecipes(paths.recipeRoot), []);
    writeFileSync(
      recipePath,
      `${JSON.stringify({ description: "Revised", template: "echo revised" }, null, 2)}\n`,
    );
    const eligible = listEligibleToolReviewRecipes(
      paths.recipeRoot,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    assert.deepEqual(eligible.map((tool) => tool.name), ["tool_00"]);
    assert.equal(eligible[0]?.usage?.revision, 2);
    assert.equal(eligible[0]?.usage?.revision_calls, 0);
    assert.equal(eligible[0]?.usage?.lifetime_calls, 0);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Tool review scheduler launches one captured portfolio and defers under actor load", async () => {
  const paths = fixture(36);
  try {
    let active = true;
    const launches: string[] = [];
    const scheduler = createToolReviewScheduler({
      batchRoot: paths.batchRoot,
      createReviewId: () => "32345678-1234-1234-1234-123456789abc",
      delayMs: 5,
      hasActiveActors: () => active,
      launch: (batch) => {
        launches.push(batch.reviewId);
        return { run: `tool-review-${batch.reviewId}` };
      },
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    });
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(launches, []);
    active = false;
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(launches, ["32345678-1234-1234-1234-123456789abc"]);
    const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.phase, "launched");
    assert.equal(state.attempts, 1);
    scheduler.close();
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Concurrent tool review schedulers launch one claimed portfolio", async () => {
  const paths = fixture(36);
  const launches: string[] = [];
  try {
    const schedulerDeps = {
      batchRoot: paths.batchRoot,
      createReviewId: () => "72345678-1234-1234-1234-123456789abc",
      delayMs: 1,
      hasActiveActors: () => false,
      launch: (batch: { reviewId: string }) => {
        launches.push(batch.reviewId);
        return { run: `tool-review-${batch.reviewId}` };
      },
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    };
    const first = createToolReviewScheduler(schedulerDeps);
    const second = createToolReviewScheduler(schedulerDeps);
    first.schedule();
    second.schedule();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(launches, ["72345678-1234-1234-1234-123456789abc"]);
    assert.equal(JSON.parse(readFileSync(paths.statePath, "utf8")).phase, "launched");
    first.close();
    second.close();
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Completed reviewer output becomes an immutable approved plan without mutating tools", () => {
  const paths = fixture(36);
  try {
    const batch = captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      createReviewId: () => "42345678-1234-1234-1234-123456789abc",
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    })!;
    const input = JSON.parse(readFileSync(batch.inputPath, "utf8")) as ToolReviewInput;
    const result: ToolReviewResult = {
      createdAt: "2026-01-01T00:01:00.000Z",
      decisions: input.tools.map((tool, index) => ({
        action: "keep",
        assessment: {
          adaptability: 0.5,
          futureUsefulness: 0.5,
          lifetimeCalls: Number(tool.usage?.lifetime_calls ?? 0),
          redundancy: 0.1,
          revisionCalls: Number(tool.usage?.revision_calls ?? 0),
          safety: "Local command contract.",
        },
        rationale: "Keep this revision.",
        sha256: ReviewProjection.toolReviewRevision(input, index),
        source: ReviewProjection.toolReviewIdentity(index),
      })),
      reviewId: batch.reviewId,
    };
    result.decisions[0] = {
      ...result.decisions[0]!,
      action: "evolve",
      target: "renamed_tool",
    };
    result.decisions[1] = { ...result.decisions[1]!, action: "demote" };
    const runDir = join(paths.root, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "stdout.log"), `TOOL_REVIEW_RESULT\n${JSON.stringify(result)}\n`);
    const processed = processToolReviewResult(
      {
        attempts: 1,
        inputPath: batch.inputPath,
        phase: "launched",
        reviewerInputPath: batch.reviewerInputPath,
        reviewId: batch.reviewId,
        runId: "review-run",
        toolNames: batch.toolNames,
        updatedAt: new Date().toISOString(),
      },
      {
        getRunStatus: () => ({ state_dir: runDir, status: "done" }),
        recipeRoot: paths.recipeRoot,
      },
    );
    assert.equal(processed.outcome, "approved");
    const approved = JSON.parse(readFileSync(processed.approvedPath!, "utf8")) as Record<string, unknown>;
    assert.equal((approved.sources as unknown[]).length, 36);
    assert.equal((approved.targets as unknown[]).length, 2);
    const targets = approved.targets as Array<Record<string, unknown>>;
    assert.deepEqual(
      (targets.find((target) => target.name === "renamed_tool")?.recipe as Record<string, unknown>)?.template,
      "echo 0",
    );
    assert.equal(JSON.parse(readFileSync(join(paths.recipeRoot, "tool_00.json"), "utf8")).template, "echo 0");
    assert.notEqual(batch.reviewerInputPath, batch.inputPath);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Review approval fails closed when a captured source changes", () => {
  const paths = fixture(36);
  try {
    const batch = captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      createReviewId: () => "52345678-1234-1234-1234-123456789abc",
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    })!;
    const input = JSON.parse(readFileSync(batch.inputPath, "utf8")) as ToolReviewInput;
    const result: ToolReviewResult = {
      createdAt: new Date().toISOString(),
      decisions: input.tools.map((tool, index) => ({
        action: "keep",
        assessment: {
          adaptability: 0.5,
          futureUsefulness: 0.5,
          lifetimeCalls: Number(tool.usage?.lifetime_calls ?? 0),
          redundancy: 0.1,
          revisionCalls: Number(tool.usage?.revision_calls ?? 0),
          safety: "Safe.",
        },
        rationale: "Keep.",
        sha256: ReviewProjection.toolReviewRevision(input, index),
        source: ReviewProjection.toolReviewIdentity(index),
      })),
      reviewId: batch.reviewId,
    };
    const runDir = join(paths.root, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "stdout.log"), `TOOL_REVIEW_RESULT\n${JSON.stringify(result)}\n`);
    writeFileSync(join(paths.recipeRoot, "tool_00.json"), '{"template":"changed"}\n');
    const processed = processToolReviewResult(
      {
        attempts: 1,
        inputPath: batch.inputPath,
        phase: "launched",
        reviewerInputPath: batch.reviewerInputPath,
        reviewId: batch.reviewId,
        runId: "review-run",
        toolNames: batch.toolNames,
        updatedAt: new Date().toISOString(),
      },
      {
        getRunStatus: () => ({ state_dir: runDir, status: "done" }),
        recipeRoot: paths.recipeRoot,
      },
    );
    assert.equal(processed.outcome, "processing_failed");
    assert.equal(processed.approvedPath, undefined);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Tool review does not capture below the thirty-six-revision threshold", () => {
  const paths = fixture(35);
  try {
    assert.equal(captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    }), undefined);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Tool review classifies missing reviewer run state without throwing", () => {
  assert.deepEqual(
    processToolReviewResult(
      {
        attempts: 1,
        inputPath: "/missing/input.json",
        phase: "launched",
        reviewerInputPath: "/missing/review-input.json",
        reviewId: "12345678-1234-1234-1234-123456789abc",
        runId: "missing-run",
        toolNames: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { getRunStatus: () => { throw new Error("run missing"); } },
    ),
    { error: "run missing", outcome: "review_failed", stage: "review_state" },
  );
});

test("Tool review bounds unexpected result-processing failures", async () => {
  const paths = fixture(36);
  let attempts = 0;
  try {
    const batch = captureToolReviewBatch({
      batchRoot: paths.batchRoot,
      createReviewId: () => "62345678-1234-1234-1234-123456789abc",
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    })!;
    writeFileSync(paths.statePath, JSON.stringify({
      attempts: 1,
      inputPath: batch.inputPath,
      phase: "launched",
      reviewId: batch.reviewId,
      runId: "review-run",
      toolNames: batch.toolNames,
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    const scheduler = createToolReviewScheduler({
      batchRoot: paths.batchRoot,
      delayMs: 1,
      hasActiveActors: () => false,
      launch: () => { throw new Error("unexpected launch"); },
      process: () => {
        attempts += 1;
        throw new Error("corrupt reviewer state");
      },
      recipeRoot: paths.recipeRoot,
      statePath: paths.statePath,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      scheduler.schedule();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
    assert.equal(attempts, 3);
    assert.equal(state.phase, "processing_failed");
    assert.equal(state.processingAttempts, 3);
    assert.equal(state.failedStage, "result_processing");
    assert.equal(state.lastError, "corrupt reviewer state");
    assert.match(state.nextAction, /review\.retry/);
    scheduler.close();
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
