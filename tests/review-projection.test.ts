/**
 * Automatic review confidentiality projection regressions.
 * Proves model inputs contain structural evidence without authored recipe values or paths.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  projectDraftReviewInput,
  projectToolReviewInput,
  restoreDraftReviewResult,
  restoreToolReviewResult,
} from "../lib/review-projection.ts";
import type {
  DraftReviewInput,
  DraftReviewResult,
} from "../lib/draft-review.ts";
import type {
  ToolReviewInput,
  ToolReviewResult,
} from "../lib/tool-review.ts";

const secretRecipe = {
  defaults: {
    accessToken: "ghp_abcdefghijklmnopqrstuvwxyz",
    clientSecret: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
    value: "~/.aws/credentials",
  },
  description: "vault kv get private/service",
  template: "sh -c 'vault kv get secret/app && cat ~/.aws/credentials'",
};

function assertValueFree(value: Record<string, unknown>): void {
  const encoded = JSON.stringify(value);
  for (const secret of [
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "OPENSSH PRIVATE KEY",
    ".aws/credentials",
    "vault kv get",
    "secret/app",
    "sh -c",
    "/home/private",
    "ghp_credential_shaped_identity",
    "credential_shaped_draft",
    "raw-content-sha",
  ]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(encoded.includes('"recipe"'), false);
  assert.equal(encoded.includes('"defaults"'), false);
  assert.equal(encoded.includes('"description"'), false);
  assert.equal(encoded.includes('"path"'), false);
}

test("Draft review projection exposes only value-free contract shape", () => {
  const input: DraftReviewInput = {
    activeTools: [{
      name: "ghp_credential_shaped_identity",
      path: "/home/private/existing.json",
      sha256: "raw-content-sha-active",
    }],
    batchId: "12345678-1234-1234-1234-123456789abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    drafts: [{
      path: "/home/private/drafts/credential_shaped_draft.json",
      recipe: secretRecipe,
      riskLabels: ["risk.shell", "risk.secret_touching"],
      sha256: "raw-content-sha-draft",
      usage: { calls: 4, current_path: "private/path", last_called: "private" },
      valid: true,
    }],
  };
  const projected = projectDraftReviewInput(input);
  assertValueFree(projected);
  const draft = (projected.drafts as Array<Record<string, unknown>>)[0]!;
  assert.equal(draft.draft, "draft_01");
  assert.equal(draft.sha256, "content_group_02");
  assert.deepEqual(projected.activeTools, [{
    name: "active_tool_01",
    sha256: "content_group_01",
  }]);
  assert.equal((draft.contract as Record<string, unknown>).default_count, 3);

  const restored = restoreDraftReviewResult(input, {
    batchId: input.batchId,
    createdAt: input.createdAt,
    decisions: [{
      action: "discard",
      assessment: {
        flexibility: 0.5,
        futureUsefulness: 0.5,
        launches: 4,
        safety: "Structurally reviewed.",
        universality: 0.5,
      },
      draft: "draft_01",
      rationale: "Discard.",
      sha256: "content_group_02",
    }],
  } satisfies DraftReviewResult);
  assert.equal(restored.decisions[0]?.draft, input.drafts[0]?.path);
  assert.equal(restored.decisions[0]?.sha256, "raw-content-sha-draft");
  const guessed = restoreDraftReviewResult(input, {
    ...restored,
    decisions: [{
      ...restored.decisions[0]!,
      draft: "credential_shaped_draft.json",
      sha256: "raw-content-sha-draft",
    }],
  });
  assert.match(guessed.decisions[0]!.draft, /^unknown:/);
  assert.match(guessed.decisions[0]!.sha256, /^invalid:/);
});

test("Tool review projection excludes raw recipes and filesystem identity", () => {
  const input: ToolReviewInput = {
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewId: "12345678-1234-1234-1234-123456789abc",
    tools: [{
      name: "ghp_credential_shaped_identity",
      path: "/home/private/credential_shaped_tool.json",
      recipe: secretRecipe,
      riskLabels: ["risk.network"],
      sha256: "raw-content-sha-tool",
      usage: { lifetime_calls: 2, revision: 3, revision_calls: 1 },
      valid: true,
    }],
  };
  const projected = projectToolReviewInput(input);
  assertValueFree(projected);
  const tool = (projected.tools as Array<Record<string, unknown>>)[0]!;
  assert.equal(tool.name, "tool_01");
  assert.equal(tool.sha256, "content_group_01");
  assert.deepEqual(tool.usage, { lifetime_calls: 2, revision: 3, revision_calls: 1 });

  const restored = restoreToolReviewResult(input, {
    createdAt: input.createdAt,
    decisions: [{
      action: "evolve",
      assessment: {
        adaptability: 0.5,
        futureUsefulness: 0.5,
        lifetimeCalls: 2,
        redundancy: 0.1,
        revisionCalls: 1,
        safety: "Structurally reviewed.",
      },
      rationale: "Retain the same identity.",
      sha256: "content_group_01",
      source: "tool_01",
      target: "tool_01",
    }],
    reviewId: input.reviewId,
  } satisfies ToolReviewResult);
  assert.equal(restored.decisions[0]?.source, "ghp_credential_shaped_identity");
  assert.equal(restored.decisions[0]?.sha256, "raw-content-sha-tool");
  assert.equal(restored.decisions[0]?.target, "ghp_credential_shaped_identity");
  const guessed = restoreToolReviewResult(input, {
    ...restored,
    decisions: [{
      ...restored.decisions[0]!,
      sha256: "raw-content-sha-tool",
      source: "ghp_credential_shaped_identity",
    }],
  });
  assert.match(guessed.decisions[0]!.source, /^unknown:/);
  assert.match(guessed.decisions[0]!.sha256, /^invalid:/);
});

test("Opaque content groups preserve only batch-local equality", () => {
  const input: ToolReviewInput = {
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewId: "12345678-1234-1234-1234-123456789abc",
    tools: [
      { name: "first_secret_name", path: "/private/first", recipe: {}, riskLabels: [], sha256: "same-raw-hash", valid: true },
      { name: "second_secret_name", path: "/private/second", recipe: {}, riskLabels: [], sha256: "same-raw-hash", valid: true },
      { name: "third_secret_name", path: "/private/third", recipe: {}, riskLabels: [], sha256: "different-raw-hash", valid: true },
    ],
  };
  const tools = projectToolReviewInput(input).tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.sha256, "content_group_01");
  assert.equal(tools[1]?.sha256, "content_group_01");
  assert.equal(tools[2]?.sha256, "content_group_02");
  const encoded = JSON.stringify(tools);
  assert.equal(encoded.includes("raw-hash"), false);
  assert.equal(encoded.includes("secret_name"), false);
});
