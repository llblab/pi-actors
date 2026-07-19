/**
 * Tool-review lineage projection regressions.
 * Covers exact source ownership and deterministic grouping for every portfolio action.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { projectToolReviewLineage } from "../lib/tool-review-lineage.ts";
import type {
  ToolReviewApprovedPlan,
  ToolReviewApprovedSource,
  ToolReviewApprovedTarget,
} from "../lib/tool-review-transaction.ts";

function source(
  name: string,
  action: ToolReviewApprovedSource["action"],
): ToolReviewApprovedSource {
  return {
    action,
    name,
    path: `/recipes/${name}.json`,
    sha256: `${name}-hash`,
  };
}

function target(
  name: string,
  lineage: ToolReviewApprovedTarget["lineage"],
  sources: string[],
): ToolReviewApprovedTarget {
  return {
    expectedSha256: null,
    lineage,
    name,
    path: `/recipes/${name}.json`,
    recipe: { template: `echo ${name}` },
    sources,
  };
}

function plan(): ToolReviewApprovedPlan {
  const sources = [
    source("keep", "keep"),
    source("evolve", "evolve"),
    source("replace", "replace"),
    source("demote", "demote"),
    source("merge_a", "merge"),
    source("merge_b", "merge"),
    source("split", "split"),
  ];
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    decisions: [],
    reviewId: "12345678-1234-1234-1234-123456789abc",
    sources,
    targets: [
      target("evolved", "evolve", ["evolve"]),
      target("replaced", "replace", ["replace"]),
      target("demote", "demote", ["demote"]),
      target("merged", "merge", ["merge_a", "merge_b"]),
      target("split_read", "split", ["split"]),
      target("split_write", "split", ["split"]),
    ],
  };
}

test("Lineage projection groups every approved portfolio action exactly once", () => {
  const operations = projectToolReviewLineage(plan());

  assert.deepEqual(
    operations.map((operation) => ({
      action: operation.action,
      sources: operation.sources.map((entry) => entry.name),
      targets: operation.targets.map((entry) => entry.name),
    })),
    [
      { action: "keep", sources: ["keep"], targets: [] },
      { action: "evolve", sources: ["evolve"], targets: ["evolved"] },
      { action: "replace", sources: ["replace"], targets: ["replaced"] },
      { action: "demote", sources: ["demote"], targets: ["demote"] },
      { action: "merge", sources: ["merge_a", "merge_b"], targets: ["merged"] },
      {
        action: "split",
        sources: ["split"],
        targets: ["split_read", "split_write"],
      },
    ],
  );
});

test("Lineage projection rejects ambiguous or unrelated target ownership", () => {
  const keptTarget = plan();
  keptTarget.targets.push(target("bad_keep", "evolve", ["keep"]));
  assert.throws(
    () => projectToolReviewLineage(keptTarget),
    /kept tool owns lineage targets/i,
  );

  const unknownTarget = plan();
  unknownTarget.targets.push(target("unknown", "merge", ["missing"]));
  assert.throws(
    () => projectToolReviewLineage(unknownTarget),
    /unknown tool review lineage target source/i,
  );

  const partialMerge = plan();
  partialMerge.targets = partialMerge.targets.map((entry) =>
    entry.lineage === "merge"
      ? { ...entry, sources: ["merge_a"] }
      : entry,
  );
  assert.throws(
    () => projectToolReviewLineage(partialMerge),
    /invalid merge lineage group/i,
  );
});
