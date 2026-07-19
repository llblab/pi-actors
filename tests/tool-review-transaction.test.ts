/**
 * Journaled tool-review filesystem transaction regressions.
 * Covers exact CAS, quarantine commit, demotion/evolution, idempotent terminal recovery, and collision failure.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { join, win32 } from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../lib/file-state.ts";
import {
  readRecipeUsage,
  recordRecipeLaunch,
} from "../lib/recipes-usage.ts";

const activationCrashWorker = new URL(
  "./fixtures/tool-review-activation-crash-worker.ts",
  import.meta.url,
).pathname;
const boundaryWorker = new URL(
  "./fixtures/tool-review-boundary-worker.ts",
  import.meta.url,
).pathname;
const crashWorker = new URL(
  "./fixtures/tool-review-crash-worker.ts",
  import.meta.url,
).pathname;

function startBoundaryWorker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", boundaryWorker, ...args],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`boundary worker exited ${code}`));
    });
  });
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

import {
  applyApprovedToolReviewAtSessionBoundary,
} from "../lib/tool-review-scheduler.ts";
import {
  applyToolReviewPlan,
  isPathContained,
  recoverToolReviewTransaction,
  type ToolReviewApprovedPlan,
} from "../lib/tool-review-transaction.ts";

test("Tool review containment handles native Windows paths", () => {
  assert.equal(
    isPathContained("C:\\agent\\recipes\\tool.json", "C:\\agent\\recipes", win32),
    true,
  );
  assert.equal(
    isPathContained("c:\\agent\\recipes\\drafts\\tool.json", "C:\\AGENT\\recipes", win32),
    true,
  );
  assert.equal(
    isPathContained("C:\\agent\\recipes", "C:\\agent\\recipes", win32),
    false,
  );
  assert.equal(
    isPathContained("C:\\agent\\recipes-old\\tool.json", "C:\\agent\\recipes", win32),
    false,
  );
  assert.equal(
    isPathContained("D:\\agent\\recipes\\tool.json", "C:\\agent\\recipes", win32),
    false,
  );
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-actors-tool-transaction-"));
  const recipeRoot = join(root, "recipes");
  const cycleDir = join(root, "review");
  mkdirSync(recipeRoot, { recursive: true });
  const sources = Array.from({ length: 36 }, (_, index) => {
    const name = `tool_${String(index).padStart(2, "0")}`;
    const path = join(recipeRoot, `${name}.json`);
    writeJsonAtomic(path, { description: name, template: `echo ${index}` });
    recordRecipeLaunch(
      path,
      new Date("2026-01-01T00:00:00.000Z"),
      "tool",
      recipeRoot,
    );
    return { name, path, sha256: hash(path) };
  });
  const decisions = sources.map((source, index) => ({
    action: index === 0 ? "evolve" as const : index === 1 ? "demote" as const : "keep" as const,
    assessment: {
      adaptability: 0.5,
      futureUsefulness: 0.5,
      lifetimeCalls: 0,
      redundancy: 0.1,
      revisionCalls: 0,
      safety: "Safe.",
    },
    rationale: "Portfolio decision.",
    ...(index === 0
      ? { recipe: { description: "Evolved", template: "echo evolved" }, target: source.name }
      : {}),
    sha256: source.sha256,
    source: source.name,
  }));
  const plan: ToolReviewApprovedPlan = {
    createdAt: "2026-01-01T00:00:00.000Z",
    decisions,
    reviewId: "12345678-1234-1234-1234-123456789abc",
    sources: sources.map((source, index) => ({
      action: decisions[index]!.action,
      ...source,
    })),
    targets: [
      {
        expectedSha256: sources[0]!.sha256,
        lineage: "evolve",
        name: sources[0]!.name,
        path: sources[0]!.path,
        recipe: { description: "Evolved", template: "echo evolved" },
        sources: [sources[0]!.name],
      },
      {
        expectedSha256: null,
        lineage: "demote",
        name: sources[1]!.name,
        path: join(recipeRoot, "drafts", `${sources[1]!.name}.json`),
        recipe: { description: sources[1]!.name, template: "echo 1" },
        sources: [sources[1]!.name],
      },
    ],
  };
  const approvedPath = join(cycleDir, "approved.json");
  writeJsonAtomic(approvedPath, plan);
  return { approvedPath, plan, recipeRoot, root, sources };
}

test("Tool review transaction evolves, demotes, and keeps one exact portfolio", () => {
  const fx = fixture();
  try {
    const result = applyToolReviewPlan(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    assert.equal(result.phase, "committed");
    assert.equal(JSON.parse(readFileSync(fx.sources[0]!.path, "utf8")).template, "echo evolved");
    assert.equal(existsSync(fx.sources[1]!.path), false);
    assert.equal(
      JSON.parse(readFileSync(join(fx.recipeRoot, "drafts", "tool_01.json"), "utf8")).template,
      "echo 1",
    );
    assert.equal(JSON.parse(readFileSync(fx.sources[2]!.path, "utf8")).template, "echo 2");
    assert.equal(existsSync(result.evidencePath!), true);
    const recovered = recoverToolReviewTransaction(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    assert.equal(recovered.phase, "committed");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Approved portfolio mutates only when the safe session boundary runs", () => {
  const fx = fixture();
  const statePath = join(fx.root, "state.json");
  try {
    writeJsonAtomic(statePath, {
      approvedPath: fx.approvedPath,
      attempts: 1,
      inputPath: join(fx.root, "review", "input.json"),
      phase: "approved",
      reviewId: fx.plan.reviewId,
      runId: "review-run",
      toolNames: fx.plan.sources.map((source) => source.name),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(JSON.parse(readFileSync(fx.sources[0]!.path, "utf8")).template, "echo 0");
    const boundary = applyApprovedToolReviewAtSessionBoundary({
      recipeRoot: fx.recipeRoot,
      statePath,
    });
    assert.equal(boundary.outcome, "completed");
    assert.equal(JSON.parse(readFileSync(fx.sources[0]!.path, "utf8")).template, "echo evolved");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.phase, "completed");
    assert.equal(typeof state.transactionEvidencePath, "string");
    assert.equal(typeof state.lineageJournalPath, "string");
    const repeated = applyApprovedToolReviewAtSessionBoundary({
      recipeRoot: fx.recipeRoot,
      statePath,
    });
    assert.equal(repeated.outcome, "completed");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Concurrent session boundaries preserve completed lineage state", async () => {
  const fx = fixture();
  const statePath = join(fx.root, "state.json");
  const firstOutput = join(fx.root, "first-output.json");
  const secondOutput = join(fx.root, "second-output.json");
  const firstReady = join(fx.root, "first-ready");
  const firstProceed = join(fx.root, "first-proceed");
  try {
    writeJsonAtomic(statePath, {
      approvedPath: fx.approvedPath,
      attempts: 1,
      inputPath: join(fx.root, "review", "input.json"),
      phase: "approved",
      reviewId: fx.plan.reviewId,
      runId: "review-run",
      toolNames: fx.plan.sources.map((source) => source.name),
      updatedAt: new Date().toISOString(),
    });
    const first = startBoundaryWorker([
      statePath,
      fx.recipeRoot,
      firstOutput,
      firstReady,
      firstProceed,
    ]);
    await waitForPath(firstReady);
    const second = startBoundaryWorker([statePath, fx.recipeRoot, secondOutput]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(secondOutput), false);

    writeFileSync(firstProceed, "proceed\n");
    await Promise.all([first, second]);

    assert.equal(JSON.parse(readFileSync(firstOutput, "utf8")).outcome, "completed");
    assert.equal(JSON.parse(readFileSync(secondOutput, "utf8")).outcome, "completed");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "completed");
    assert.equal(JSON.parse(readFileSync(fx.sources[0]!.path, "utf8")).template, "echo evolved");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Safe-boundary restart completes lineage before quarantine cleanup", () => {
  for (const crashAt of ["lineage_pending", "completed"] as const) {
    const fx = fixture();
    const statePath = join(fx.root, "state.json");
    try {
      writeJsonAtomic(statePath, {
        approvedPath: fx.approvedPath,
        attempts: 1,
        inputPath: join(fx.root, "review", "input.json"),
        phase: "approved",
        reviewId: fx.plan.reviewId,
        runId: "review-run",
        toolNames: fx.plan.sources.map((source) => source.name),
        updatedAt: new Date().toISOString(),
      });
      const crashed = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          activationCrashWorker,
          statePath,
          fx.recipeRoot,
          crashAt,
        ],
        { encoding: "utf8" },
      );
      assert.equal(crashed.status, 76, `${crashAt}: ${crashed.stderr || crashed.stdout}`);
      assert.equal(
        JSON.parse(readFileSync(statePath, "utf8")).phase,
        crashAt,
      );
      assert.equal(existsSync(join(fx.root, "review", "quarantine")), true);

      const recovered = applyApprovedToolReviewAtSessionBoundary({
        recipeRoot: fx.recipeRoot,
        statePath,
      });
      assert.equal(recovered.outcome, "completed");
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "completed");
      assert.equal(existsSync(join(fx.root, "review", "quarantine")), false);
      assert.equal(
        (readRecipeUsage(fx.sources[0]!.path, fx.recipeRoot)?.review_epochs as string[])
          .includes(fx.plan.reviewId),
        true,
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("Hard crashes at every tool review transition recover deterministically", () => {
  const cases = [
    ["prepared", "rolled_back"],
    ["source_quarantined", "rolled_back"],
    ["sources_quarantined", "rolled_back"],
    ["target_written", "rolled_back"],
    ["targets_written", "committed"],
    ["evidence_written", "committed"],
  ] as const;
  for (const [checkpoint, expectedPhase] of cases) {
    const fx = fixture();
    try {
      const crashed = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          crashWorker,
          fx.approvedPath,
          fx.recipeRoot,
          checkpoint,
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        crashed.status,
        74,
        `${checkpoint}: ${crashed.stderr || crashed.stdout}`,
      );
      const recovered = recoverToolReviewTransaction(fx.approvedPath, {
        recipeRoot: fx.recipeRoot,
      });
      assert.equal(recovered.phase, expectedPhase, checkpoint);
      if (expectedPhase === "committed") {
        assert.equal(
          JSON.parse(readFileSync(fx.sources[0]!.path, "utf8")).template,
          "echo evolved",
        );
        assert.equal(existsSync(fx.sources[1]!.path), false);
      } else {
        assert.equal(
          JSON.parse(readFileSync(fx.sources[0]!.path, "utf8")).template,
          "echo 0",
        );
        assert.equal(existsSync(fx.sources[1]!.path), true);
      }
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("Tool review recovery rejects journal operations rewritten outside the plan", () => {
  const fx = fixture();
  try {
    applyToolReviewPlan(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    const journalPath = join(fx.root, "review", "journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.operations.sources[0].quarantine = join(fx.root, "outside.json");
    journal.operationsSha256 = createHash("sha256")
      .update(canonicalJson(journal.operations))
      .digest("hex");
    journal.quarantined[0].quarantine = journal.operations.sources[0].quarantine;
    writeJsonAtomic(journalPath, journal);

    assert.throws(
      () => recoverToolReviewTransaction(fx.approvedPath, { recipeRoot: fx.recipeRoot }),
      /invalid or mismatched tool review transaction journal/i,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Tool review committed recovery rejects changed quarantine", () => {
  const fx = fixture();
  try {
    const result = applyToolReviewPlan(fx.approvedPath, { recipeRoot: fx.recipeRoot });
    const journal = JSON.parse(
      readFileSync(join(fx.root, "review", "journal.json"), "utf8"),
    );
    writeFileSync(journal.quarantined[0].quarantine, "changed\n");

    assert.throws(
      () => recoverToolReviewTransaction(fx.approvedPath, { recipeRoot: fx.recipeRoot }),
      /quarantine changed/,
    );
    assert.equal(result.phase, "committed");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test(
  "Tool review recovery rejects recipe-root symlink substitution",
  { skip: process.platform === "win32" },
  () => {
    const fx = fixture();
    const movedRoot = `${fx.recipeRoot}-moved`;
    try {
      applyToolReviewPlan(fx.approvedPath, { recipeRoot: fx.recipeRoot });
      renameSync(fx.recipeRoot, movedRoot);
      symlinkSync(movedRoot, fx.recipeRoot, "dir");

      assert.throws(
        () => recoverToolReviewTransaction(fx.approvedPath, { recipeRoot: fx.recipeRoot }),
        /invalid tool review transaction root/i,
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  },
);

test("Tool review transaction rejects a target collision before quarantining sources", () => {
  const fx = fixture();
  try {
    const target = fx.plan.targets[1]!.path;
    mkdirSync(join(fx.recipeRoot, "drafts"), { recursive: true });
    writeFileSync(target, '{"template":"concurrent"}\n');
    assert.throws(
      () => applyToolReviewPlan(fx.approvedPath, { recipeRoot: fx.recipeRoot }),
      /target appeared/,
    );
    assert.equal(existsSync(fx.sources[0]!.path), true);
    assert.equal(existsSync(fx.sources[1]!.path), true);
    assert.equal(existsSync(join(join(fx.root, "review"), "journal.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
