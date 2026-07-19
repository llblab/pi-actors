/**
 * Automatic draft-review contract regressions.
 * Covers quota-free decisions, strict batch identity, safety gates, and read-only output parsing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDraftReviewPrompt,
  findUnsafeRecipeReason,
  parseDraftReviewResult,
  validateDraftReviewInput,
  validateDraftReviewResult,
  type DraftReviewDecision,
  type DraftReviewInput,
  type DraftReviewResult,
} from "../lib/draft-review.ts";

const BATCH_ID = "12345678-1234-1234-1234-123456789abc";

function input(): DraftReviewInput {
  return {
    activeTools: [{
      name: "existing_tool",
      path: "/recipes/existing_tool.json",
      sha256: "existing-hash",
    }],
    batchId: BATCH_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    drafts: [
      {
        path: "/recipes/drafts/first.json",
        recipe: { template: "echo {value}" },
        riskLabels: [],
        sha256: "first-hash",
        usage: { lifetime_calls: 4, lineage_name: "first" },
        valid: true,
      },
      {
        path: "/recipes/drafts/second.json",
        recipe: { template: "printf ok" },
        riskLabels: [],
        sha256: "second-hash",
        usage: { lifetime_calls: 1, lineage_name: "second" },
        valid: true,
      },
    ],
  };
}

function assessment(launches: number) {
  return {
    flexibility: 0.8,
    futureUsefulness: 0.7,
    launches,
    safety: "No secrets or external side effects.",
    universality: 0.6,
  };
}

function discard(path: string, sha256: string, launches: number): DraftReviewDecision {
  return {
    action: "discard",
    assessment: assessment(launches),
    draft: path,
    rationale: "Too specific for durable tool memory.",
    sha256,
  };
}

function promote(
  path: string,
  sha256: string,
  launches: number,
  target: string,
): DraftReviewDecision {
  return {
    action: "promote",
    assessment: assessment(launches),
    draft: path,
    rationale: "Reusable, parameterized, and likely useful again.",
    sha256,
    target,
    targetSha256: null,
  };
}

function result(decisions: DraftReviewDecision[]): DraftReviewResult {
  return {
    batchId: BATCH_ID,
    createdAt: "2026-01-01T00:01:00.000Z",
    decisions,
  };
}

test("Draft-review input requires one immutable non-empty batch", () => {
  assert.deepEqual(validateDraftReviewInput(input()), { errors: [], ok: true });
  const invalid = input();
  invalid.drafts.push({ ...invalid.drafts[0]! });
  assert.equal(validateDraftReviewInput(invalid).ok, false);
});

for (const [name, decisions, promotions] of [
  [
    "zero",
    [
      discard("/recipes/drafts/first.json", "first-hash", 4),
      discard("/recipes/drafts/second.json", "second-hash", 1),
    ],
    0,
  ],
  [
    "one",
    [
      promote("/recipes/drafts/first.json", "first-hash", 4, "first_tool"),
      discard("/recipes/drafts/second.json", "second-hash", 1),
    ],
    1,
  ],
  [
    "all",
    [
      promote("/recipes/drafts/first.json", "first-hash", 4, "first_tool"),
      promote("/recipes/drafts/second.json", "second-hash", 1, "second_tool"),
    ],
    2,
  ],
] as const) {
  test(`Draft review accepts ${name} promotions without a selection quota`, () => {
    const review = result([...decisions]);
    assert.deepEqual(validateDraftReviewResult(input(), review), {
      errors: [],
      ok: true,
    });
    assert.equal(
      review.decisions.filter((decision) => decision.action === "promote").length,
      promotions,
    );
  });
}

test("Draft review rejects incomplete, duplicate, stale, and fabricated decisions", () => {
  const review = result([
    promote("/recipes/drafts/first.json", "stale", 99, "existing_tool"),
    promote("/recipes/drafts/first.json", "first-hash", 4, "first_tool"),
  ]);
  const validation = validateDraftReviewResult(input(), review);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /review draft changed/);
  assert.match(validation.errors.join("\n"), /launch count differs from lineage/);
  assert.match(validation.errors.join("\n"), /target is not uniquely absent/);
  assert.match(validation.errors.join("\n"), /duplicate review decision/);
  assert.match(validation.errors.join("\n"), /missing review decision/);
});

test("Draft review requires an executable revision before re-promoting a demotion", () => {
  const demoted = input();
  demoted.drafts[0]!.usage = {
    demoted_fingerprint: "same-fingerprint",
    fingerprint: "same-fingerprint",
    lifetime_calls: 4,
    lineage_name: "first",
  };
  const review = result([
    promote("/recipes/drafts/first.json", "first-hash", 4, "first_tool"),
    discard("/recipes/drafts/second.json", "second-hash", 1),
  ]);
  const blocked = validateDraftReviewResult(demoted, review);
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join("\n"), /requires a revision before automatic promotion/);

  demoted.drafts[0]!.usage!.fingerprint = "revised-fingerprint";
  assert.equal(validateDraftReviewResult(demoted, review).ok, true);
});

test("Draft safety classification covers common credential forms", () => {
  const unsafeRecipes = [
    { defaults: { accessToken: "literal-secret" }, template: "echo safe" },
    { defaults: { clientSecret: "literal-secret" }, template: "echo safe" },
    { defaults: { secretAccessKey: "literal-secret" }, template: "echo safe" },
    { defaults: { value: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" }, template: "echo safe" },
    { template: "cat ~/.aws/credentials" },
    { defaults: { region: "AWS_SECRET_ACCESS_KEY" }, template: "echo safe" },
    { template: "vault kv get secret/production" },
    { defaults: { value: "ghp_abcdefghijklmnopqrstuvwxyz123456" }, template: "echo safe" },
  ];

  for (const recipe of unsafeRecipes) {
    assert.notEqual(findUnsafeRecipeReason(recipe), undefined, JSON.stringify(recipe));
  }
  assert.equal(
    findUnsafeRecipeReason({ defaults: { region: "us-east-1" }, template: "echo {region}" }),
    undefined,
  );
});

test("Draft review mechanically rejects secrets and temporary paths", () => {
  const secretInput = input();
  secretInput.drafts[0]!.riskLabels = ["risk.secret_touching"];
  secretInput.drafts[0]!.recipe = {
    defaults: { api_key: "literal-secret" },
    template: "node /tmp/generated-script.js {api_key}",
  };
  const review = result([
    {
      ...promote("/recipes/drafts/first.json", "first-hash", 4, "first_tool"),
      recipe: { template: "sh -c 'rm -rf -- {target}'" },
    },
    discard("/recipes/drafts/second.json", "second-hash", 1),
  ]);
  const validation = validateDraftReviewResult(secretInput, review);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /secret-touching draft may only be discarded/);
  assert.match(validation.errors.join("\n"), /must not supply executable recipe content/);
  assert.match(validation.errors.join("\n"), /unsafe promotion source/);
});

test("Draft reviewer parser accepts only a terminal marked JSON object", () => {
  const review = result([
    discard("/recipes/drafts/first.json", "first-hash", 4),
    discard("/recipes/drafts/second.json", "second-hash", 1),
  ]);
  assert.deepEqual(
    parseDraftReviewResult(`analysis\nDRAFT_REVIEW_RESULT\n${JSON.stringify(review)}`),
    review,
  );
  assert.throws(() => parseDraftReviewResult(JSON.stringify(review)), /marker is missing/);
  assert.throws(
    () => parseDraftReviewResult(`DRAFT_REVIEW_RESULT\n${JSON.stringify(review)}\ntrailing`),
    /must end with one JSON object|Unexpected non-whitespace/,
  );
});

test("Draft reviewer prompt forbids mutation and states quota-free selection", () => {
  const prompt = createDraftReviewPrompt("/tmp/review-input.json");
  assert.match(prompt, /There is no selection quota/);
  assert.match(prompt, /read-only reviewer/);
  assert.match(prompt, /Never return recipe content/);
  assert.match(prompt, /demoted draft becomes automatically eligible only after/);
  assert.match(prompt, /Do not create, update, move, register, or delete recipes/);
  assert.match(prompt, /DRAFT_REVIEW_RESULT/);
});
