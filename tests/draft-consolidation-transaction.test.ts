/**
 * Deterministic draft consolidation transaction regressions.
 * Covers promote/merge/discard, target CAS, rollback, duplicate claims, complete recipe persistence, and journal recovery.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";

import type {
  DraftConsolidationInventoryItem,
  DraftConsolidationPlan,
} from "../lib/draft-consolidation.ts";
import {
  applyDraftConsolidationPlan,
  recoverDraftConsolidationCycle,
  type DraftConsolidationCheckpoint,
  type DraftConsolidationJournal,
} from "../lib/draft-consolidation-transaction.ts";
import { writeJsonAtomic } from "../lib/file-state.ts";
import { createRecipeToolReloadWatcher } from "../lib/runtime.ts";

const CYCLE_ID = "12345678-1234-1234-1234-123456789abc";
const execFileAsync = promisify(execFile);
const worker = new URL("./fixtures/draft-consolidation-worker.ts", import.meta.url).pathname;

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function source(
  draftRoot: string,
  name: string,
  recipe: Record<string, unknown>,
): Promise<DraftConsolidationInventoryItem> {
  const path = join(draftRoot, `${name}.json`);
  const bytes = `${JSON.stringify(recipe, null, 2)}\n`;
  await writeFile(path, bytes);
  return { id: name, path, sha256: hash(bytes), valid: true };
}

function plan(
  drafts: DraftConsolidationPlan["drafts"],
): DraftConsolidationPlan {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    cycleId: CYCLE_ID,
    drafts,
  };
}

async function fixture() {
  const agentRoot = await mkdtemp(join(tmpdir(), "pi-actors-consolidation-"));
  const recipeRoot = join(agentRoot, "recipes");
  const draftRoot = join(recipeRoot, "drafts");
  const cycleDir = join(agentRoot, "tmp", CYCLE_ID);
  await mkdir(draftRoot, { recursive: true });
  return { agentRoot, cycleDir, draftRoot, recipeRoot };
}

async function workerConfig(
  paths: Awaited<ReturnType<typeof fixture>>,
  transactionPlan: DraftConsolidationPlan,
  inventory: DraftConsolidationInventoryItem[],
  control: {
    blockedPath?: string;
    crashAt?: DraftConsolidationCheckpoint;
    holdAt?: DraftConsolidationCheckpoint;
    readyPath?: string;
    releasePath?: string;
    startedPath?: string;
  } = {},
): Promise<string> {
  const path = join(
    paths.agentRoot,
    `worker-${control.crashAt ?? control.startedPath?.split("/").at(-1) ?? "apply"}.json`,
  );
  await writeFile(path, JSON.stringify({
    ...control,
    options: {
      cycleDir: paths.cycleDir,
      draftRoot: paths.draftRoot,
      inventory,
      recipeRoot: paths.recipeRoot,
    },
    plan: transactionPlan,
  }));
  return path;
}

function runWorker(configPath: string) {
  return execFileAsync(process.execPath, [
    "--experimental-strip-types",
    worker,
    configPath,
  ]);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

test("Transaction promotes, merges, discards, preserves complete recipes, and empties drafts", async () => {
  const paths = await fixture();
  try {
    const promote = await source(paths.draftRoot, "promote", { template: "old promote" });
    const mergeA = await source(paths.draftRoot, "merge-a", { template: "old a" });
    const mergeB = await source(paths.draftRoot, "merge-b", { template: "old b" });
    const discard = await source(paths.draftRoot, "discard", { template: "one off" });
    const promotedRecipe = {
      async: true,
      artifacts: { report: "{path}/report.md" },
      description: "Promoted complete recipe",
      mailbox: { accepts: ["control.kill"], emits: ["run.done"] },
      output: "summary",
      template: "promote {path}",
    };
    const mergedRecipe = {
      defaults: { mode: "safe" },
      description: "Merged recipe",
      template: ["first {mode}", "second {mode}"],
    };
    const transactionPlan = plan([
      {
        action: "promote",
        draft: promote.path,
        rationale: "Reusable",
        recipe: promotedRecipe,
        sha256: promote.sha256,
        target: "promoted_tool",
        targetSha256: null,
      },
      {
        action: "merge",
        draft: mergeA.path,
        rationale: "Shared behavior",
        recipe: mergedRecipe,
        sha256: mergeA.sha256,
        target: "merged_tool",
        targetSha256: null,
      },
      {
        action: "merge",
        draft: mergeB.path,
        rationale: "Shared behavior",
        recipe: mergedRecipe,
        sha256: mergeB.sha256,
        target: "merged_tool",
        targetSha256: null,
      },
      {
        action: "discard",
        draft: discard.path,
        rationale: "One off",
        sha256: discard.sha256,
      },
    ]);

    const result = applyDraftConsolidationPlan(transactionPlan, {
      ...paths,
      inventory: [promote, mergeA, mergeB, discard],
    });

    assert.equal(result.phase, "committed");
    assert.equal(result.targets, 2);
    assert.deepEqual(await readdir(paths.draftRoot), []);
    assert.deepEqual(
      JSON.parse(await readFile(join(paths.recipeRoot, "promoted_tool.json"), "utf8")),
      promotedRecipe,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(paths.recipeRoot, "merged_tool.json"), "utf8")),
      mergedRecipe,
    );
    const evidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
    assert.equal(evidence.outcome, "committed");
    assert.equal(evidence.decisions.length, 4);
    assert.equal(
      (await readdir(join(paths.cycleDir, "quarantine"))).length,
      4,
    );
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Recipe watcher converges only after the synchronous multi-target commit", async () => {
  const paths = await fixture();
  const snapshots: Array<[boolean, boolean]> = [];
  const watcher = createRecipeToolReloadWatcher(
    {
      loadTools: () => snapshots.push([
        existsSync(join(paths.recipeRoot, "first_tool.json")),
        existsSync(join(paths.recipeRoot, "second_tool.json")),
      ]),
    },
    { recipeRoot: paths.recipeRoot },
  );
  try {
    const first = await source(paths.draftRoot, "first", { template: "first" });
    const second = await source(paths.draftRoot, "second", { template: "second" });
    watcher.watch({ hasUI: true, ui: { notify() {} } });
    applyDraftConsolidationPlan(
      plan([
        {
          action: "promote",
          draft: first.path,
          rationale: "First",
          recipe: { template: "echo first" },
          sha256: first.sha256,
          target: "first_tool",
          targetSha256: null,
        },
        {
          action: "promote",
          draft: second.path,
          rationale: "Second",
          recipe: { template: "echo second" },
          sha256: second.sha256,
          target: "second_tool",
          targetSha256: null,
        },
      ]),
      { ...paths, inventory: [first, second] },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(snapshots.length >= 1, true);
    assert.equal(snapshots.every(([a, b]) => a && b), true);
  } finally {
    watcher.close();
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Transaction rejects target changes and restores source plus concurrent target", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const targetPath = join(paths.recipeRoot, "target.json");
    const reviewed = `${JSON.stringify({ template: "reviewed" })}\n`;
    const concurrent = `${JSON.stringify({ template: "concurrent" })}\n`;
    await writeFile(targetPath, reviewed);
    const transactionPlan = plan([{
      action: "merge",
      draft: item.path,
      rationale: "Merge",
      recipe: { template: "planned" },
      sha256: item.sha256,
      target: "target",
      targetSha256: hash(reviewed),
    }]);
    await writeFile(targetPath, concurrent);

    assert.throws(
      () => applyDraftConsolidationPlan(transactionPlan, {
        ...paths,
        inventory: [item],
      }),
      /Active target changed after planning/,
    );
    assert.equal(existsSync(item.path), true);
    assert.equal(await readFile(targetPath, "utf8"), concurrent);
    const journal = JSON.parse(
      await readFile(join(paths.cycleDir, "journal.json"), "utf8"),
    );
    assert.equal(journal.phase, "rolled_back");
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Transaction rolls back earlier targets when a later target is invalid", async () => {
  const paths = await fixture();
  try {
    const first = await source(paths.draftRoot, "first", { template: "first" });
    const second = await source(paths.draftRoot, "second", { template: "second" });
    const transactionPlan = plan([
      {
        action: "promote",
        draft: first.path,
        rationale: "Valid",
        recipe: { template: "valid" },
        sha256: first.sha256,
        target: "a_valid",
        targetSha256: null,
      },
      {
        action: "promote",
        draft: second.path,
        rationale: "Invalid",
        recipe: { template: null },
        sha256: second.sha256,
        target: "z_invalid",
        targetSha256: null,
      },
    ]);

    assert.throws(
      () => applyDraftConsolidationPlan(transactionPlan, {
        ...paths,
        inventory: [first, second],
      }),
      /Persisted target recipe is invalid/,
    );
    assert.equal(existsSync(first.path), true);
    assert.equal(existsSync(second.path), true);
    assert.equal(existsSync(join(paths.recipeRoot, "a_valid.json")), false);
    assert.equal(existsSync(join(paths.recipeRoot, "z_invalid.json")), false);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Evidence publication failure rolls back targets and quarantined sources", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "promote",
      draft: item.path,
      rationale: "Promote",
      recipe: { template: "echo target" },
      sha256: item.sha256,
      target: "target",
      targetSha256: null,
    }]);
    await mkdir(join(paths.cycleDir, "evidence.json"), { recursive: true });

    assert.throws(
      () => applyDraftConsolidationPlan(transactionPlan, {
        ...paths,
        inventory: [item],
      }),
    );
    assert.equal(existsSync(item.path), true);
    assert.equal(existsSync(join(paths.recipeRoot, "target.json")), false);
    const journal = JSON.parse(
      await readFile(join(paths.cycleDir, "journal.json"), "utf8"),
    );
    assert.equal(journal.phase, "rolled_back");
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Transaction cycle claim rejects duplicate apply", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "discard",
      draft: item.path,
      rationale: "Discard",
      sha256: item.sha256,
    }]);
    applyDraftConsolidationPlan(transactionPlan, {
      ...paths,
      inventory: [item],
    });

    assert.throws(
      () => applyDraftConsolidationPlan(transactionPlan, {
        ...paths,
        inventory: [item],
      }),
      /cycle already claimed/,
    );
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Sibling processes allow exactly one apply claim", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "promote",
      draft: item.path,
      rationale: "Promote",
      recipe: { template: "echo target" },
      sha256: item.sha256,
      target: "target",
      targetSha256: null,
    }]);
    const readyPath = join(paths.agentRoot, "first-ready");
    const releasePath = join(paths.agentRoot, "release-first");
    const secondStartedPath = join(paths.agentRoot, "second-started");
    const firstConfig = await workerConfig(paths, transactionPlan, [item], {
      holdAt: "prepared",
      readyPath,
      releasePath,
      startedPath: join(paths.agentRoot, "first-started"),
    });
    const secondConfig = await workerConfig(paths, transactionPlan, [item], {
      startedPath: secondStartedPath,
    });

    const first = runWorker(firstConfig);
    await waitForFile(readyPath);
    const second = runWorker(secondConfig);
    await waitForFile(secondStartedPath);
    await writeFile(releasePath, "release\n");
    const outcomes = await Promise.allSettled([first, second]);

    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "rejected").length,
      1,
    );
    const journal = JSON.parse(
      await readFile(join(paths.cycleDir, "journal.json"), "utf8"),
    );
    assert.equal(journal.phase, "committed");
    assert.deepEqual(await readdir(paths.draftRoot), []);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Distinct cycles contend on the shared source and target locks", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const firstPlan = plan([{
      action: "promote",
      draft: item.path,
      rationale: "Promote",
      recipe: { template: "echo target" },
      sha256: item.sha256,
      target: "target",
      targetSha256: null,
    }]);
    const secondCycleId = "abcdefab-cdef-cdef-cdef-abcdefabcdef";
    const secondPlan = { ...firstPlan, cycleId: secondCycleId };
    const secondPaths = {
      ...paths,
      cycleDir: join(paths.agentRoot, "tmp", secondCycleId),
    };
    const readyPath = join(paths.agentRoot, "distinct-first-ready");
    const releasePath = join(paths.agentRoot, "distinct-release");
    const blockedPath = join(paths.agentRoot, "distinct-second-blocked");
    const firstConfig = await workerConfig(paths, firstPlan, [item], {
      holdAt: "prepared",
      readyPath,
      releasePath,
      startedPath: join(paths.agentRoot, "distinct-first-started"),
    });
    const secondConfig = await workerConfig(secondPaths, secondPlan, [item], {
      blockedPath,
      startedPath: join(paths.agentRoot, "distinct-second-started"),
    });

    const first = runWorker(firstConfig);
    await waitForFile(readyPath);
    const second = runWorker(secondConfig);
    await waitForFile(blockedPath);
    assert.equal(
      existsSync(join(secondPaths.cycleDir, "journal.json")),
      false,
    );
    await writeFile(releasePath, "release\n");
    const outcomes = await Promise.allSettled([first, second]);

    assert.equal(outcomes[0]!.status, "fulfilled");
    assert.equal(outcomes[1]!.status, "rejected");
    assert.equal(existsSync(join(paths.recipeRoot, "target.json")), true);
    assert.deepEqual(await readdir(paths.draftRoot), []);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Hard crashes at every transition recover deterministically", async (t) => {
  const checkpoints: Array<{
    point: DraftConsolidationCheckpoint;
    recovery: "committed" | "rolled_back";
  }> = [
    { point: "prepared", recovery: "rolled_back" },
    { point: "target_written", recovery: "rolled_back" },
    { point: "targets_validated", recovery: "rolled_back" },
    { point: "source_quarantined", recovery: "rolled_back" },
    { point: "sources_quarantined", recovery: "committed" },
    { point: "committed_evidence_pending", recovery: "committed" },
    { point: "evidence_written", recovery: "committed" },
  ];
  for (const checkpoint of checkpoints) {
    await t.test(checkpoint.point, async () => {
      const paths = await fixture();
      try {
        const item = await source(paths.draftRoot, "draft", { template: "draft" });
        const transactionPlan = plan([{
          action: "promote",
          draft: item.path,
          rationale: "Promote",
          recipe: { template: "echo target" },
          sha256: item.sha256,
          target: "target",
          targetSha256: null,
        }]);
        const configPath = await workerConfig(
          paths,
          transactionPlan,
          [item],
          { crashAt: checkpoint.point },
        );

        await assert.rejects(runWorker(configPath));
        const recovered = recoverDraftConsolidationCycle(paths);

        assert.equal(recovered.phase, checkpoint.recovery);
        assert.equal(existsSync(item.path), checkpoint.recovery === "rolled_back");
        assert.equal(
          existsSync(join(paths.recipeRoot, "target.json")),
          checkpoint.recovery === "committed",
        );
      } finally {
        await rm(paths.agentRoot, { recursive: true, force: true });
      }
    });
  }
});

test("Rollback recovery preserves a legitimate post-crash target edit", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "promote",
      draft: item.path,
      rationale: "Promote",
      recipe: { template: "echo planned" },
      sha256: item.sha256,
      target: "target",
      targetSha256: null,
    }]);
    const configPath = await workerConfig(paths, transactionPlan, [item], {
      crashAt: "target_written",
    });
    await assert.rejects(runWorker(configPath));
    const targetPath = join(paths.recipeRoot, "target.json");
    const concurrent = `${JSON.stringify({ template: "echo concurrent" })}\n`;
    await writeFile(targetPath, concurrent);

    assert.throws(
      () => recoverDraftConsolidationCycle(paths),
      /target changed after crash/,
    );
    assert.equal(await readFile(targetPath, "utf8"), concurrent);
    assert.equal(existsSync(item.path), true);
    const journal = JSON.parse(
      await readFile(join(paths.cycleDir, "journal.json"), "utf8"),
    );
    assert.equal(journal.phase, "rollback_required");
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test(
  "Rollback recovery rejects original-source symlink substitution",
  { skip: process.platform === "win32" },
  async () => {
    const paths = await fixture();
    try {
      const item = await source(paths.draftRoot, "draft", { template: "draft" });
      const transactionPlan = plan([{
        action: "promote",
        draft: item.path,
        rationale: "Promote",
        recipe: { template: "echo planned" },
        sha256: item.sha256,
        target: "target",
        targetSha256: null,
      }]);
      const configPath = await workerConfig(paths, transactionPlan, [item], {
        crashAt: "source_quarantined",
      });
      await assert.rejects(runWorker(configPath));
      const external = join(paths.agentRoot, "external.json");
      const originalBytes = await readFile(
        JSON.parse(await readFile(join(paths.cycleDir, "journal.json"), "utf8"))
          .sources[0].quarantinePath,
      );
      await writeFile(external, originalBytes);
      await symlink(external, item.path, "file");

      assert.throws(
        () => recoverDraftConsolidationCycle(paths),
        /Symlink is not allowed in consolidation state/,
      );
      assert.equal(await readFile(external, "utf8"), originalBytes.toString("utf8"));
      assert.equal((await lstat(item.path)).isSymbolicLink(), true);
    } finally {
      await rm(paths.agentRoot, { recursive: true, force: true });
    }
  },
);

test("Roll-forward recovery rejects missing or changed committed targets", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "promote",
      draft: item.path,
      rationale: "Promote",
      recipe: { template: "echo planned" },
      sha256: item.sha256,
      target: "target",
      targetSha256: null,
    }]);
    const configPath = await workerConfig(paths, transactionPlan, [item], {
      crashAt: "sources_quarantined",
    });
    await assert.rejects(runWorker(configPath));
    const targetPath = join(paths.recipeRoot, "target.json");
    await rm(targetPath, { force: true });

    assert.throws(
      () => recoverDraftConsolidationCycle(paths),
      /Committed source|Committed target/,
    );
    assert.equal(existsSync(item.path), false);
    assert.equal(existsSync(targetPath), false);
    const journal = JSON.parse(
      await readFile(join(paths.cycleDir, "journal.json"), "utf8"),
    );
    assert.equal(journal.phase, "sources_quarantined");
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Terminal recovery repairs missing runtime evidence", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "discard",
      draft: item.path,
      rationale: "Discard",
      sha256: item.sha256,
    }]);
    const applied = applyDraftConsolidationPlan(transactionPlan, {
      ...paths,
      inventory: [item],
    });
    await rm(applied.evidencePath, { force: true });

    const recovered = recoverDraftConsolidationCycle(paths);

    assert.equal(recovered.phase, "committed");
    assert.equal(existsSync(recovered.evidencePath), true);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Recovery rejects tampered journal paths and plan content", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "discard",
      draft: item.path,
      rationale: "Discard",
      sha256: item.sha256,
    }]);
    applyDraftConsolidationPlan(transactionPlan, {
      ...paths,
      inventory: [item],
    });
    const journalPath = join(paths.cycleDir, "journal.json");
    const journal = JSON.parse(
      await readFile(journalPath, "utf8"),
    ) as DraftConsolidationJournal;
    journal.sources[0]!.path = "/tmp/escape.json";
    writeJsonAtomic(journalPath, journal);

    assert.throws(
      () => recoverDraftConsolidationCycle(paths),
      /journal operations do not match its plan/,
    );

    journal.sources[0]!.path = item.path;
    journal.plan.drafts[0]!.rationale = "tampered";
    writeJsonAtomic(journalPath, journal);
    assert.throws(
      () => recoverDraftConsolidationCycle(paths),
      /Invalid or mismatched consolidation journal identity/,
    );
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test(
  "Recovery rejects quarantine directory symlink substitution",
  { skip: process.platform === "win32" },
  async () => {
    const paths = await fixture();
    try {
      const item = await source(paths.draftRoot, "draft", { template: "draft" });
      const transactionPlan = plan([{
        action: "discard",
        draft: item.path,
        rationale: "Discard",
        sha256: item.sha256,
      }]);
      applyDraftConsolidationPlan(transactionPlan, {
        ...paths,
        inventory: [item],
      });
      const quarantine = join(paths.cycleDir, "quarantine");
      const displaced = join(paths.cycleDir, "quarantine-real");
      await rename(quarantine, displaced);
      await symlink(displaced, quarantine, "dir");

      assert.throws(
        () => recoverDraftConsolidationCycle(paths),
        /Symlink is not allowed in consolidation state/,
      );
    } finally {
      await rm(paths.agentRoot, { recursive: true, force: true });
    }
  },
);

for (const substitution of [
  "draft-root",
  "recipe-root",
  "cycle-dir",
  "target",
  "backup",
] as const) {
  test(
    `Recovery rejects ${substitution} symlink substitution`,
    { skip: process.platform === "win32" },
    async () => {
      const paths = await fixture();
      try {
        const item = await source(paths.draftRoot, "draft", { template: "draft" });
        const targetPath = join(paths.recipeRoot, "target.json");
        const originalTarget = `${JSON.stringify({ template: "echo original" })}\n`;
        if (substitution === "backup") await writeFile(targetPath, originalTarget);
        const transactionPlan = plan([{
          action: "promote",
          draft: item.path,
          rationale: "Promote",
          recipe: { template: "echo planned" },
          sha256: item.sha256,
          target: "target",
          targetSha256: substitution === "backup" ? hash(originalTarget) : null,
        }]);
        applyDraftConsolidationPlan(transactionPlan, {
          ...paths,
          inventory: [item],
        });
        const journal = JSON.parse(
          await readFile(join(paths.cycleDir, "journal.json"), "utf8"),
        ) as DraftConsolidationJournal;
        const substitutedPath = substitution === "draft-root"
          ? paths.draftRoot
          : substitution === "recipe-root"
            ? paths.recipeRoot
            : substitution === "cycle-dir"
              ? paths.cycleDir
              : substitution === "target"
                ? journal.targets[0]!.path
                : journal.targets[0]!.backupPath!;
        const displaced = `${substitutedPath}-real`;
        await rename(substitutedPath, displaced);
        await symlink(
          displaced,
          substitutedPath,
          ["draft-root", "recipe-root", "cycle-dir"].includes(substitution)
            ? "dir"
            : "file",
        );

        assert.throws(
          () => recoverDraftConsolidationCycle(paths),
          /Symlink is not allowed in consolidation state/,
        );
      } finally {
        await rm(paths.agentRoot, { recursive: true, force: true });
      }
    },
  );
}

for (const recoveryState of ["rollback", "roll-forward", "terminal"] as const) {
  test(
    `${recoveryState} recovery rejects trusted-root ancestor symlink substitution`,
    { skip: process.platform === "win32" },
    async () => {
      const paths = await fixture();
      const displacedRoot = `${paths.agentRoot}-real`;
      try {
        const item = await source(paths.draftRoot, "draft", { template: "draft" });
        const transactionPlan = plan([{
          action: "promote",
          draft: item.path,
          rationale: "Promote",
          recipe: { template: "echo planned" },
          sha256: item.sha256,
          target: "target",
          targetSha256: null,
        }]);
        if (recoveryState === "terminal") {
          applyDraftConsolidationPlan(transactionPlan, {
            ...paths,
            inventory: [item],
          });
        } else {
          const configPath = await workerConfig(paths, transactionPlan, [item], {
            crashAt: recoveryState === "rollback"
              ? "source_quarantined"
              : "sources_quarantined",
          });
          await assert.rejects(runWorker(configPath));
        }
        await rename(paths.agentRoot, displacedRoot);
        await symlink(displacedRoot, paths.agentRoot, "dir");

        assert.throws(
          () => recoverDraftConsolidationCycle(paths),
          /Consolidation root identity changed/,
        );
      } finally {
        await rm(paths.agentRoot, { recursive: true, force: true });
        await rm(displacedRoot, { recursive: true, force: true });
      }
    },
  );
}

test("Recovery rolls forward quarantined sources and recreates evidence", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "discard",
      draft: item.path,
      rationale: "Discard",
      sha256: item.sha256,
    }]);
    const applied = applyDraftConsolidationPlan(transactionPlan, {
      ...paths,
      inventory: [item],
    });
    const journalPath = join(paths.cycleDir, "journal.json");
    const journal = JSON.parse(
      await readFile(journalPath, "utf8"),
    ) as DraftConsolidationJournal;
    journal.phase = "sources_quarantined";
    writeJsonAtomic(journalPath, journal);
    await rm(applied.evidencePath, { force: true });

    const recovered = recoverDraftConsolidationCycle(paths);

    assert.equal(recovered.phase, "committed");
    assert.equal(existsSync(recovered.evidencePath), true);
    assert.deepEqual(await readdir(paths.draftRoot), []);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});

test("Recovery rolls back pre-commit target and source changes", async () => {
  const paths = await fixture();
  try {
    const item = await source(paths.draftRoot, "draft", { template: "draft" });
    const transactionPlan = plan([{
      action: "promote",
      draft: item.path,
      rationale: "Promote",
      recipe: { template: "echo target" },
      sha256: item.sha256,
      target: "target",
      targetSha256: null,
    }]);
    applyDraftConsolidationPlan(transactionPlan, {
      ...paths,
      inventory: [item],
    });
    const journalPath = join(paths.cycleDir, "journal.json");
    const journal = JSON.parse(
      await readFile(journalPath, "utf8"),
    ) as DraftConsolidationJournal;
    journal.phase = "targets_validated";
    writeJsonAtomic(journalPath, journal);

    const recovered = recoverDraftConsolidationCycle(paths);

    assert.equal(recovered.phase, "rolled_back");
    assert.equal(existsSync(item.path), true);
    assert.equal(existsSync(join(paths.recipeRoot, "target.json")), false);
  } finally {
    await rm(paths.agentRoot, { recursive: true, force: true });
  }
});
