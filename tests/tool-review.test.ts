/**
 * Active-tool portfolio review contract regressions.
 * Covers exact 36-tool input, quota-free actions, evolution, merge/split, and safety gates.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolReviewPrompt,
  parseToolReviewResult,
  TOOL_REVIEW_THRESHOLD,
  validateToolReviewInput,
  validateToolReviewResult,
  type ToolReviewDecision,
  type ToolReviewInput,
  type ToolReviewResult,
} from "../lib/tool-review.ts";

const REVIEW_ID = "12345678-1234-1234-1234-123456789abc";

function input(): ToolReviewInput {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewId: REVIEW_ID,
    tools: Array.from({ length: TOOL_REVIEW_THRESHOLD }, (_, index) => ({
      name: `tool_${String(index).padStart(2, "0")}`,
      path: `/recipes/tool_${String(index).padStart(2, "0")}.json`,
      recipe: { template: `echo ${index}` },
      riskLabels: [],
      sha256: `hash-${index}`,
      usage: {
        lifetime_calls: index,
        revision_calls: index % 3,
      },
      valid: true,
    })),
  };
}

function assessment(index: number) {
  return {
    adaptability: 0.7,
    futureUsefulness: 0.6,
    lifetimeCalls: index,
    redundancy: 0.2,
    revisionCalls: index % 3,
    safety: "Validated local contract.",
  };
}

function keep(index: number): ToolReviewDecision {
  return {
    action: "keep",
    assessment: assessment(index),
    rationale: "Still useful and appropriately shaped.",
    sha256: `hash-${index}`,
    source: `tool_${String(index).padStart(2, "0")}`,
  };
}

function result(decisions = Array.from({ length: TOOL_REVIEW_THRESHOLD }, (_, index) => keep(index))): ToolReviewResult {
  return {
    createdAt: "2026-01-01T00:01:00.000Z",
    decisions,
    reviewId: REVIEW_ID,
  };
}

test("Tool review requires exactly thirty-six active recipes", () => {
  assert.deepEqual(validateToolReviewInput(input()), { errors: [], ok: true });
  const short = input();
  short.tools.pop();
  assert.match(validateToolReviewInput(short).errors.join("\n"), /exactly 36 tools/);
});

test("Tool review accepts a no-op portfolio with no demotion quota", () => {
  assert.deepEqual(validateToolReviewResult(input(), result()), {
    errors: [],
    ok: true,
  });
});

test("Tool review permits rename-only evolution without reviewer-authored recipe content", () => {
  const decisions = result().decisions;
  decisions[0] = {
    action: "evolve",
    assessment: assessment(0),
    rationale: "Give the unchanged captured capability a clearer name.",
    sha256: "hash-0",
    source: "tool_00",
    target: "renamed_tool",
  };
  assert.deepEqual(validateToolReviewResult(input(), result(decisions)), {
    errors: [],
    ok: true,
  });
});

test("Tool review permits only identical-source merges", () => {
  const portfolio = input();
  portfolio.tools[1]!.recipe = { template: "echo 0" };
  const decisions = result().decisions;
  decisions[0] = {
    action: "merge",
    assessment: assessment(0),
    rationale: "Same captured capability.",
    sha256: "hash-0",
    source: "tool_00",
    target: "tool_00",
  };
  decisions[1] = {
    action: "merge",
    assessment: assessment(1),
    rationale: "Same captured capability.",
    sha256: "hash-1",
    source: "tool_01",
    target: "tool_00",
  };
  assert.deepEqual(validateToolReviewResult(portfolio, result(decisions)), {
    errors: [],
    ok: true,
  });
});

test("Tool review rejects reviewer-authored executable content, replace, and split", () => {
  const decisions = result().decisions;
  decisions[0] = {
    action: "evolve",
    assessment: assessment(0),
    rationale: "Attempt executable expansion.",
    recipe: { template: "sh -c 'rm -rf -- {target}'" },
    sha256: "hash-0",
    source: "tool_00",
    target: "tool_00",
  };
  decisions[1] = {
    action: "replace",
    assessment: assessment(1),
    rationale: "Attempt replacement.",
    recipe: { template: "echo replacement" },
    sha256: "hash-1",
    source: "tool_01",
    target: "tool_01",
  };
  decisions[2] = {
    action: "split",
    assessment: assessment(2),
    outputs: [
      { name: "tool_02", recipe: { template: "echo read" } },
      { name: "tool_02_write", recipe: { template: "echo write" } },
    ],
    rationale: "Attempt split.",
    sha256: "hash-2",
    source: "tool_02",
  };
  const validation = validateToolReviewResult(input(), result(decisions));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /must not supply executable recipe content/);
  assert.match(validation.errors.join("\n"), /replace requires explicit operator-authored/);
  assert.match(validation.errors.join("\n"), /split requires explicit operator-authored/);
});

test("Tool review rejects stale usage, unavailable replacement, and incomplete coverage", () => {
  const decisions = result().decisions.slice(0, -1);
  decisions[0] = {
    action: "replace",
    assessment: { ...assessment(0), lifetimeCalls: 99 },
    rationale: "Replace meaning.",
    recipe: {
      defaults: { token: "literal-secret" },
      template: "node /tmp/generated.js",
    },
    sha256: "stale",
    source: "tool_00",
    target: "tool_01",
  };
  const validation = validateToolReviewResult(input(), result(decisions));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /reviewed tool changed/);
  assert.match(validation.errors.join("\n"), /lifetime calls differ/);
  assert.match(validation.errors.join("\n"), /replace requires explicit operator-authored/);
  assert.match(validation.errors.join("\n"), /missing tool decision/);
});

test("Tool reviewer parser and prompt preserve read-only evolution policy", () => {
  const review = result();
  assert.deepEqual(
    parseToolReviewResult(`analysis\nTOOL_REVIEW_RESULT\n${JSON.stringify(review)}`),
    review,
  );
  assert.throws(() => parseToolReviewResult(JSON.stringify(review)), /marker is missing/);
  const prompt = createToolReviewPrompt("/tmp/tool-review.json");
  assert.match(prompt, /all 36 tools/);
  assert.match(prompt, /There is no quota/);
  assert.match(prompt, /evolve may only rename/);
  assert.match(prompt, /Never return recipe or outputs fields/);
  assert.match(prompt, /Do not mutate, register, move, or delete recipes/);
});
