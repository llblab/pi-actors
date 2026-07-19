/**
 * Journaled tool-review lineage finalization regressions.
 * Covers every portfolio action, usage continuity, replacement reset, and partial-write roll-forward.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../lib/file-state.ts";
import {
  finalizeToolReviewLineage,
  rollbackToolRecipeRevision,
} from "../lib/tool-review-lineage-transaction.ts";
import {
  getRecipeRevisionSnapshotPath,
  readRecipeUsage,
  recordRecipeLaunch,
} from "../lib/recipes-usage.ts";
import type {
  ToolReviewApprovedPlan,
  ToolReviewApprovedSource,
  ToolReviewApprovedTarget,
} from "../lib/tool-review-transaction.ts";

const crashWorker = new URL(
  "./fixtures/tool-review-lineage-crash-worker.ts",
  import.meta.url,
).pathname;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-tool-lineage-"));
  const recipeRoot = join(root, "recipes");
  const cycleDir = join(root, "review");
  mkdirSync(recipeRoot, { recursive: true });
  mkdirSync(cycleDir, { recursive: true });
  const definitions: Array<[string, ToolReviewApprovedSource["action"]]> = [
    ["keep", "keep"],
    ["evolve", "evolve"],
    ["replace", "replace"],
    ["demote", "demote"],
    ["merge_a", "merge"],
    ["merge_b", "merge"],
    ["split", "split"],
  ];
  const sources = definitions.map(([name, action]) => {
    const path = join(recipeRoot, `${name}.json`);
    writeJsonAtomic(path, { template: `echo ${name}` });
    recordRecipeLaunch(path, new Date("2026-01-01T00:00:00.000Z"), "tool", recipeRoot);
    return { action, name, path, sha256: fileHash(path) };
  });
  const target = (
    name: string,
    lineage: ToolReviewApprovedTarget["lineage"],
    sourceNames: string[],
    path = join(recipeRoot, `${name}.json`),
  ): ToolReviewApprovedTarget => ({
    expectedSha256: null,
    lineage,
    name,
    path,
    recipe: { template: `echo ${name} final` },
    sources: sourceNames,
  });
  const targets = [
    target("evolved", "evolve", ["evolve"]),
    target("replaced", "replace", ["replace"]),
    target(
      "demote",
      "demote",
      ["demote"],
      join(recipeRoot, "drafts", "demote.json"),
    ),
    target("merged", "merge", ["merge_a", "merge_b"]),
    target("split_read", "split", ["split"]),
    target("split_write", "split", ["split"]),
  ];
  const quarantineDir = join(cycleDir, "quarantine");
  mkdirSync(quarantineDir, { recursive: true });
  const sourceOperations = sources
    .filter((source) => source.action !== "keep")
    .map((source, index) => {
      const quarantine = join(quarantineDir, `${index}-${source.name}.json`);
      writeFileSync(quarantine, readFileSync(source.path));
      return { original: source.path, quarantine, sha256: source.sha256 };
    });
  writeJsonAtomic(join(cycleDir, "journal.json"), {
    operations: { sources: sourceOperations },
    phase: "committed",
  });
  for (const source of sources) {
    if (source.action !== "keep") rmSync(source.path);
  }
  for (const entry of targets) writeJsonAtomic(entry.path, entry.recipe);
  const plan: ToolReviewApprovedPlan = {
    createdAt: "2026-01-02T00:00:00.000Z",
    decisions: [],
    reviewId: "12345678-1234-1234-1234-123456789abc",
    sources,
    targets,
  };
  const approvedPath = join(cycleDir, "approved.json");
  writeJsonAtomic(approvedPath, plan);
  return { approvedPath, plan, recipeRoot, root };
}

function usage(path: string, recipeRoot: string): Record<string, unknown> {
  const value = readRecipeUsage(path, recipeRoot);
  assert.ok(value, path);
  return value;
}

test("Lineage finalization applies every action and preserves intended usage", () => {
  const fx = fixture();
  try {
    const result = finalizeToolReviewLineage(fx.approvedPath, {
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      recipeRoot: fx.recipeRoot,
    });
    assert.equal(result.phase, "committed");
    assert.deepEqual(usage(join(fx.recipeRoot, "keep.json"), fx.recipeRoot).review_epochs, [
      fx.plan.reviewId,
    ]);
    assert.equal(
      usage(join(fx.recipeRoot, "evolved.json"), fx.recipeRoot).lifetime_calls,
      1,
    );
    assert.equal(
      usage(join(fx.recipeRoot, "replaced.json"), fx.recipeRoot).lifetime_calls,
      0,
    );
    for (const name of ["evolved", "replaced"]) {
      const snapshot = JSON.parse(
        readFileSync(
          getRecipeRevisionSnapshotPath(name, 1, fx.recipeRoot),
          "utf8",
        ),
      );
      assert.equal(snapshot.type, "recipe_revision_snapshot");
      assert.equal(snapshot.lineage_name, name);
      assert.equal(snapshot.source_revision, 1);
      assert.equal(snapshot.transition_action, name === "replaced" ? "replace" : "evolve");
      assert.equal(typeof snapshot.content_base64, "string");
    }
    const demoted = usage(
      join(fx.recipeRoot, "drafts", "demote.json"),
      fx.recipeRoot,
    );
    assert.equal(demoted.current_path, "drafts/demote.json");
    assert.equal(demoted.demoted_fingerprint, demoted.fingerprint);
    assert.equal(demoted.demoted_from_revision, 1);
    assert.equal(demoted.demoted_review_epoch, fx.plan.reviewId);
    assert.equal(
      usage(join(fx.recipeRoot, "merged.json"), fx.recipeRoot).lifetime_calls,
      2,
    );
    assert.equal(
      usage(join(fx.recipeRoot, "split_read.json"), fx.recipeRoot).lifetime_calls,
      1,
    );
    assert.equal(
      usage(join(fx.recipeRoot, "split_write.json"), fx.recipeRoot).lifetime_calls,
      1,
    );
    assert.equal(
      finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot }).phase,
      "committed",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Replacement snapshots rotate the bounded slot for a new meaning", () => {
  const fx = fixture();
  const snapshotPath = getRecipeRevisionSnapshotPath("replaced", 1, fx.recipeRoot);
  try {
    writeJsonAtomic(snapshotPath, {
      source_revision: 1,
      transition_action: "replace",
      type: "recipe_revision_snapshot",
    });
    finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(snapshot.review_id, fx.plan.reviewId);
    assert.equal(snapshot.transition_action, "replace");
    assert.equal(typeof snapshot.content_base64, "string");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Revision rollback restores bytes and advances lineage without resetting lifetime usage", () => {
  const fx = fixture();
  const evolvedPath = join(fx.recipeRoot, "evolved.json");
  try {
    finalizeToolReviewLineage(fx.approvedPath, {
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      recipeRoot: fx.recipeRoot,
    });
    const before = usage(evolvedPath, fx.recipeRoot);
    assert.equal(before.revision, 2);
    assert.equal(before.lifetime_calls, 1);

    const rolledBack = rollbackToolRecipeRevision("evolved", 1, {
      now: () => new Date("2026-01-04T00:00:00.000Z"),
      recipeRoot: fx.recipeRoot,
    });
    assert.equal(rolledBack.restoredRevision, 1);
    assert.equal(existsSync(rolledBack.journalPath), true);
    assert.equal(JSON.parse(readFileSync(rolledBack.journalPath, "utf8")).phase, "committed");
    assert.equal(JSON.parse(readFileSync(evolvedPath, "utf8")).template, "echo evolve");
    const after = usage(evolvedPath, fx.recipeRoot);
    assert.equal(after.revision, 3);
    assert.equal(after.lifetime_calls, 1);
    assert.equal(after.rollback_of_revision, 1);
    assert.equal(
      (after.lineage_events as Array<Record<string, unknown>>).at(-1)?.type,
      "rollback",
    );

    rollbackToolRecipeRevision("evolved", 1, { recipeRoot: fx.recipeRoot });
    assert.equal(usage(evolvedPath, fx.recipeRoot).revision, 3);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Revision rollback rolls post-write failures forward from its durable journal", async (t) => {
  await t.test("recipe written before failure", () => {
    const fx = fixture();
    const evolvedPath = join(fx.recipeRoot, "evolved.json");
    try {
      finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot });
      assert.throws(
        () => rollbackToolRecipeRevision("evolved", 1, {
          checkpoint: (checkpoint) => {
            if (checkpoint === "recipe_written") throw new Error("fault after recipe write");
          },
          recipeRoot: fx.recipeRoot,
        }),
        /fault after recipe write/,
      );
      assert.equal(JSON.parse(readFileSync(evolvedPath, "utf8")).template, "echo evolve");
      assert.equal(usage(evolvedPath, fx.recipeRoot).revision, 2);
      const recovered = rollbackToolRecipeRevision("evolved", 1, {
        recipeRoot: fx.recipeRoot,
      });
      assert.equal(JSON.parse(readFileSync(recovered.journalPath, "utf8")).phase, "committed");
      assert.equal(usage(evolvedPath, fx.recipeRoot).revision, 3);
      assert.equal(usage(evolvedPath, fx.recipeRoot).rollback_of_revision, 1);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  await t.test("lineage written before failure", () => {
    const fx = fixture();
    const evolvedPath = join(fx.recipeRoot, "evolved.json");
    try {
      finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot });
      assert.throws(
        () => rollbackToolRecipeRevision("evolved", 1, {
          checkpoint: (checkpoint) => {
            if (checkpoint === "ledger_written") throw new Error("fault after lineage write");
          },
          recipeRoot: fx.recipeRoot,
        }),
        /fault after lineage write/,
      );
      assert.equal(usage(evolvedPath, fx.recipeRoot).revision, 3);
      const recovered = rollbackToolRecipeRevision("evolved", 1, {
        recipeRoot: fx.recipeRoot,
      });
      assert.equal(JSON.parse(readFileSync(recovered.journalPath, "utf8")).phase, "committed");
      assert.equal(usage(evolvedPath, fx.recipeRoot).revision, 3);
      assert.equal(usage(evolvedPath, fx.recipeRoot).rollback_of_revision, 1);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

test("Revision rollback rejects a concurrently changed target", () => {
  const fx = fixture();
  const evolvedPath = join(fx.recipeRoot, "evolved.json");
  try {
    finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    writeJsonAtomic(evolvedPath, { template: "concurrent change" });
    assert.throws(
      () => rollbackToolRecipeRevision("evolved", 1, { recipeRoot: fx.recipeRoot }),
      /target CAS failed/,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Revision rollback rejects tampered, rotated, and symlinked snapshots", () => {
  const fx = fixture();
  const snapshotPath = getRecipeRevisionSnapshotPath("evolved", 1, fx.recipeRoot);
  try {
    finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    writeJsonAtomic(snapshotPath, {
      ...snapshot,
      rollback_recipe: { template: "echo tampered" },
    });
    assert.throws(
      () => rollbackToolRecipeRevision("evolved", 1, { recipeRoot: fx.recipeRoot }),
      /invalid or rotated/i,
    );

    writeJsonAtomic(snapshotPath, snapshot);
    assert.throws(
      () => rollbackToolRecipeRevision("evolved", 33, { recipeRoot: fx.recipeRoot }),
      /invalid or rotated/i,
    );

    const outside = join(fx.root, "outside-snapshot.json");
    renameSync(snapshotPath, outside);
    symlinkSync(outside, snapshotPath);
    assert.throws(
      () => rollbackToolRecipeRevision("evolved", 1, { recipeRoot: fx.recipeRoot }),
      /symlink is not allowed/i,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Lineage finalization rejects recomputed journal paths outside the approved projection", () => {
  const fx = fixture();
  try {
    assert.throws(
      () => finalizeToolReviewLineage(fx.approvedPath, {
        checkpoint: (checkpoint) => {
          if (checkpoint === "prepared") throw new Error("stop after prepare");
        },
        recipeRoot: fx.recipeRoot,
      }),
      /stop after prepare/,
    );
    const journalPath = `${fx.approvedPath}.lineage-journal.json`;
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.writes[0].path = join(fx.root, "outside.json");
    journal.operationsSha256 = createHash("sha256")
      .update(canonicalJson({ deletes: journal.deletes, writes: journal.writes }))
      .digest("hex");
    writeJsonAtomic(journalPath, journal);

    assert.throws(
      () => finalizeToolReviewLineage(fx.approvedPath, { recipeRoot: fx.recipeRoot }),
      /paths do not match the approved plan/i,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Lineage finalization rolls partial ledger writes forward after hard crash", () => {
  const fx = fixture();
  try {
    const crashed = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        crashWorker,
        fx.approvedPath,
        fx.recipeRoot,
      ],
      { encoding: "utf8" },
    );
    assert.equal(crashed.status, 75, crashed.stderr || crashed.stdout);

    const recovered = finalizeToolReviewLineage(fx.approvedPath, {
      recipeRoot: fx.recipeRoot,
    });
    assert.equal(recovered.phase, "committed");
    assert.equal(
      usage(join(fx.recipeRoot, "merged.json"), fx.recipeRoot).lifetime_calls,
      2,
    );
    assert.equal(
      usage(join(fx.recipeRoot, "replaced.json"), fx.recipeRoot).lifetime_calls,
      0,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
