/**
 * Review preflight diagnostic regression tests
 * Covers provider-error classification and compact override hints for review-pipeline preflight failures
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewPreflightDiagnostic,
  classifyReviewPreflightError,
  formatReviewPreflightDiagnostic,
} from "../lib/preflight-diagnostics.ts";

test("Review preflight diagnostics classify common provider failures", () => {
  assert.equal(
    classifyReviewPreflightError("insufficient quota or balance exhausted"),
    "quota_or_balance",
  );
  assert.equal(classifyReviewPreflightError("missing API key"), "auth_or_key");
  assert.equal(classifyReviewPreflightError("404 model not found"), "model_unavailable");
  assert.equal(classifyReviewPreflightError("429 rate limit"), "rate_limited");
  assert.equal(classifyReviewPreflightError("fetch failed ECONNRESET"), "transport");
  assert.equal(classifyReviewPreflightError("", true), "timeout");
});

test("Review preflight diagnostics expose stage, model, prompt file, and override args", () => {
  const diagnostic = buildReviewPreflightDiagnostic({
    args: [
      "-p",
      "--model",
      "bad-model",
      "--thinking",
      "medium",
      "--no-tools",
      "@/tmp/preflight.md",
    ],
    code: 1,
    promptFile: "/tmp/preflight.md",
    promptText: "Preflight check for stage reviewer. Confirm launch.",
    stderr: "404 model not found",
  });

  assert.deepEqual(diagnostic, {
    errorClass: "model_unavailable",
    model: "bad-model",
    promptFile: "/tmp/preflight.md",
    stage: "reviewer",
    suggestedOverrideArgs:
      "reviewer_model=<working-model> thinking=<supported-level> tools=<tool-policy>",
    thinking: "medium",
  });
  assert.equal(
    formatReviewPreflightDiagnostic(diagnostic!),
    'ACTOR_PREFLIGHT_FAILED stage=reviewer model=bad-model thinking=medium error_class=model_unavailable prompt_file=/tmp/preflight.md suggested_override_args="reviewer_model=<working-model> thinking=<supported-level> tools=<tool-policy>"',
  );
});

test("Review preflight diagnostics ignore non-preflight prompts", () => {
  assert.equal(
    buildReviewPreflightDiagnostic({
      args: ["-p", "Review repo"],
      stderr: "boom",
    }),
    undefined,
  );
});
