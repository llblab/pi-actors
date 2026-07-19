/**
 * Automatic draft consolidation contract regressions.
 * Covers complete inventory and promote/merge/discard validation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDraftConsolidationInventory,
  validateDraftConsolidationPlan,
  type DraftConsolidationPlan,
} from "../lib/draft-consolidation.ts";

const CYCLE_ID = "12345678-1234-1234-1234-123456789abc";

const inventory = normalizeDraftConsolidationInventory([
  {
    id: "second",
    path: "/drafts/second.json",
    sha256: "bbb",
    valid: false,
    diagnostics: ["invalid template"],
  },
  {
    id: "first",
    path: "/drafts/first.json",
    sha256: "aaa",
    valid: true,
    description: "Reusable first capability",
    risk_labels: ["filesystem-mutation", 3],
    template_preview: "tool {path}",
  },
  { id: "incomplete", path: "/drafts/incomplete.json" },
]);

test("Draft consolidation inventory is complete, normalized, and stable", () => {
  assert.deepEqual(inventory, [
    {
      id: "first",
      path: "/drafts/first.json",
      sha256: "aaa",
      valid: true,
      description: "Reusable first capability",
      riskLabels: ["filesystem-mutation"],
      templatePreview: "tool {path}",
    },
    {
      id: "second",
      path: "/drafts/second.json",
      sha256: "bbb",
      valid: false,
      diagnostics: ["invalid template"],
    },
  ]);
});

test("Draft consolidation accepts one complete stable decision per draft", () => {
  const plan: DraftConsolidationPlan = {
    createdAt: "2026-01-01T00:00:00.000Z",
    cycleId: CYCLE_ID,
    drafts: [
      {
        action: "promote",
        draft: "/drafts/first.json",
        rationale: "Reusable and parameterized",
        recipe: { description: "First", template: ["first", "{path}"] },
        sha256: "aaa",
        target: "first_tool",
        targetSha256: null,
      },
      {
        action: "discard",
        draft: "/drafts/second.json",
        rationale: "Invalid template",
        sha256: "bbb",
      },
    ],
  };

  assert.deepEqual(validateDraftConsolidationPlan(inventory, plan), {
    ok: true,
    errors: [],
  });
});

test("Draft consolidation rejects incomplete, stale, duplicate, and unsafe plans", () => {
  const plan: DraftConsolidationPlan = {
    createdAt: "2026-01-01T00:00:00.000Z",
    cycleId: CYCLE_ID,
    drafts: [
      {
        action: "merge",
        draft: "/drafts/first.json",
        rationale: "",
        sha256: "stale",
        target: "Bad-Target",
      },
      {
        action: "discard",
        draft: "/drafts/first.json",
        rationale: "duplicate",
        sha256: "aaa",
        target: "must_not_exist",
      },
      {
        action: "promote",
        draft: "/drafts/second.json",
        rationale: "invalid promotion",
        recipe: { description: "Second", template: "second" },
        sha256: "bbb",
        target: "second_tool",
        targetSha256: null,
      },
      {
        action: "discard",
        draft: "/drafts/unknown.json",
        rationale: "unknown",
        sha256: "ccc",
      },
    ],
  };
  const result = validateDraftConsolidationPlan(inventory, plan);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "draft changed after inventory: /drafts/first.json",
    "missing rationale: /drafts/first.json",
    "merge requires snake_case target: /drafts/first.json",
    "duplicate draft decision: /drafts/first.json",
    "invalid draft may only be discarded: /drafts/second.json",
    "unknown draft: /drafts/unknown.json",
  ]);
});

test("Draft consolidation rejects inconsistent merge groups", () => {
  const mergedInventory = normalizeDraftConsolidationInventory([
    { id: "a", path: "/drafts/a.json", sha256: "a", valid: true },
    { id: "b", path: "/drafts/b.json", sha256: "b", valid: true },
  ]);
  const result = validateDraftConsolidationPlan(mergedInventory, {
    createdAt: "2026-01-01T00:00:00.000Z",
    cycleId: CYCLE_ID,
    drafts: [
      {
        action: "merge",
        draft: "/drafts/a.json",
        rationale: "Shared capability",
        recipe: { template: "merged {value}" },
        sha256: "a",
        target: "merged_tool",
        targetSha256: null,
      },
      {
        action: "merge",
        draft: "/drafts/b.json",
        rationale: "Shared capability",
        recipe: { template: "different {value}" },
        sha256: "b",
        target: "merged_tool",
        targetSha256: null,
      },
    ],
  });

  assert.deepEqual(result.errors, [
    "target recipe differs across decisions: merged_tool",
  ]);
});

test("Draft consolidation compares merge recipes canonically", () => {
  const mergedInventory = normalizeDraftConsolidationInventory([
    { id: "a", path: "/drafts/a.json", sha256: "a", valid: true },
    { id: "b", path: "/drafts/b.json", sha256: "b", valid: true },
  ]);
  const result = validateDraftConsolidationPlan(mergedInventory, {
    createdAt: "2026-01-01T00:00:00.000Z",
    cycleId: CYCLE_ID,
    drafts: [
      {
        action: "merge",
        draft: "/drafts/a.json",
        rationale: "Shared capability",
        recipe: {
          description: "Merged",
          template: { parallel: true, template: ["a"] },
        },
        sha256: "a",
        target: "merged_tool",
        targetSha256: "target-hash",
      },
      {
        action: "merge",
        draft: "/drafts/b.json",
        rationale: "Shared capability",
        recipe: {
          template: { template: ["a"], parallel: true },
          description: "Merged",
        },
        sha256: "b",
        target: "merged_tool",
        targetSha256: "target-hash",
      },
    ],
  });

  assert.deepEqual(result, { ok: true, errors: [] });
});
