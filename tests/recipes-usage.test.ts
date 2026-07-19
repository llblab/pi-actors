/**
 * Recipe usage telemetry regressions
 * Covers launch counters used for muscle-memory cleanup decisions
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  discoverRecipeSources,
  summarizeDiscovery,
} from "../lib/recipes-discovery.ts";
import {
  getRecipeRevisionSnapshotPath,
  moveRecipeUsage,
  readRecipeUsage,
  recordRecipeReview,
  recordRecipeLaunch,
} from "../lib/recipes-usage.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Recipe revision snapshots use a bounded thirty-two-slot ring", () => {
  assert.equal(
    getRecipeRevisionSnapshotPath("tool", 1, "/agent"),
    getRecipeRevisionSnapshotPath("tool", 33, "/agent"),
  );
  assert.notEqual(
    getRecipeRevisionSnapshotPath("tool", 1, "/agent"),
    getRecipeRevisionSnapshotPath("tool", 32, "/agent"),
  );
});

function recordLaunchInChild(
  moduleUrl: string,
  recipe: string,
  recipeRoot = "",
  contentionPath = "",
): Promise<void> {
  const script = `
    const { writeFileSync } = await import("node:fs");
    const { recordRecipeLaunch } = await import(process.argv[1]);
    const options = process.argv[4]
      ? { onMutationLockContention: () => writeFileSync(process.argv[4], "contended") }
      : {};
    if (!recordRecipeLaunch(process.argv[2], new Date(), "tool", process.argv[3] || undefined, options)) process.exit(2);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "-e", script, moduleUrl, recipe, recipeRoot, contentionPath],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`usage child exited ${code}`)),
    );
  });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("Recipe usage launch counter increments lineage metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-"));
  try {
    const recipe = join(root, "memory.json");
    await writeFile(
      recipe,
      JSON.stringify({
        description: "Memory",
        template: "echo ok",
      }),
    );

    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-02T03:04:05.000Z"), "spawn"), true);
    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-03T03:04:05.000Z"), "tool"), true);

    const usage = readRecipeUsage(recipe)!;
    assert.equal(usage.calls, 2);
    assert.equal(usage.spawn_calls, 1);
    assert.equal(usage.tool_calls, 1);
    assert.equal(usage.launch_kind, "tool");
    assert.equal(usage.last_called, "2026-01-03T03:04:05.000Z");
    assert.equal(typeof usage.fingerprint, "string");
    const recipeContent = await readJson(recipe);
    assert.equal(recipeContent.template, "echo ok");
    assert.equal(recipeContent.usage, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe usage counters remain monotonic across sibling processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-process-"));
  const recipe = join(root, "memory.json");
  const moduleUrl = pathToFileURL(join(__dirname, "..", "lib", "recipes-usage.ts")).href;
  try {
    await writeFile(recipe, JSON.stringify({ template: "echo ok" }));
    await Promise.all([
      recordLaunchInChild(moduleUrl, recipe),
      recordLaunchInChild(moduleUrl, recipe),
    ]);
    const usage = readRecipeUsage(recipe)!;
    assert.equal(usage.calls, 2);
    assert.equal(usage.tool_calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe launch accounting shares the portfolio mutation fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-fence-"));
  const recipe = join(root, "memory.json");
  const acquired = join(root, "acquired");
  const contended = join(root, "contended");
  const release = join(root, "release");
  const usageModuleUrl = pathToFileURL(join(__dirname, "..", "lib", "recipes-usage.ts")).href;
  const fileStateModuleUrl = pathToFileURL(join(__dirname, "..", "lib", "file-state.ts")).href;
  const holderScript = `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { withFileMutationLock } = await import(process.argv[1]);
    withFileMutationLock(process.argv[2], () => {
      writeFileSync(process.argv[3], "acquired");
      while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    });
  `;
  const holder = spawn(
    process.execPath,
    ["--experimental-strip-types", "-e", holderScript, fileStateModuleUrl, root, acquired, release],
    { stdio: "ignore" },
  );
  try {
    await writeFile(recipe, JSON.stringify({ template: "echo ok" }));
    await waitForPath(acquired);
    const launch = recordLaunchInChild(usageModuleUrl, recipe, root, contended);
    await waitForPath(contended);
    assert.equal(readRecipeUsage(recipe, root), undefined);
    await writeFile(release, "release");
    await launch;
    assert.equal(readRecipeUsage(recipe, root)?.lifetime_calls, 1);
  } finally {
    await writeFile(release, "release").catch(() => {});
    holder.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe usage preserves lifetime calls across recipe revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-"));
  try {
    const recipe = join(root, "memory.json");
    await writeFile(recipe, JSON.stringify({ template: "echo one" }));

    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-02T03:04:05.000Z")), true);
    const beforeUsage = readRecipeUsage(recipe)!;
    await writeFile(recipe, JSON.stringify({ template: "echo two", external: true }));

    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-03T03:04:05.000Z")), true);
    const usage = readRecipeUsage(recipe)!;
    assert.equal(usage.calls, 2);
    assert.equal(usage.lifetime_calls, 2);
    assert.equal(usage.revision_calls, 1);
    assert.equal(usage.revision, 2);
    assert.deepEqual(
      (usage.revisions as Array<{ revision: number }>).map((revision) => revision.revision),
      [1, 2],
    );
    assert.equal(usage.last_called, "2026-01-03T03:04:05.000Z");
    assert.equal(usage.reset_at, "2026-01-03T03:04:05.000Z");
    assert.equal(usage.reset_reason, "recipe content fingerprint changed");
    assert.notEqual(usage.fingerprint, beforeUsage.fingerprint);
    assert.deepEqual(await readJson(recipe), { template: "echo two", external: true });
    const discovered = discoverRecipeSources([
      { root, defaultTool: true, mutableUsage: true },
    ]);
    assert.equal(discovered.active.get("memory")?.config?.template, "echo two");
    const summary = summarizeDiscovery(discovered) as { active?: Array<{ usage?: Record<string, unknown> }> };
    assert.equal(summary.active?.[0]?.usage?.calls, 2);
    assert.equal(summary.active?.[0]?.usage?.revision_calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe lineage and lifetime usage survive draft promotion and demotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-lineage-"));
  const drafts = join(root, "drafts");
  const draft = join(drafts, "memory.json");
  const active = join(root, "memory_tool.json");
  try {
    await mkdir(drafts, { recursive: true });
    await writeFile(draft, JSON.stringify({ template: "echo ok" }));
    assert.equal(recordRecipeLaunch(draft, new Date("2026-01-01T00:00:00.000Z")), true);
    const initial = readRecipeUsage(draft, root)!;

    await rename(draft, active);
    assert.equal(moveRecipeUsage(draft, active, root), true);
    assert.equal(recordRecipeLaunch(active, new Date("2026-01-02T00:00:00.000Z"), "tool", root), true);
    const promoted = readRecipeUsage(active, root)!;
    assert.equal(promoted.lineage_name, "memory_tool");
    assert.equal(initial.lineage_name, "memory");
    assert.equal(promoted.lifetime_calls, 2);
    assert.equal(promoted.revision_calls, 2);
    assert.deepEqual(promoted.former_paths, ["drafts/memory.json"]);

    await rename(active, draft);
    assert.equal(moveRecipeUsage(active, draft, root), true);
    const demoted = readRecipeUsage(draft, root)!;
    assert.equal(demoted.lineage_name, "memory");
    assert.equal(demoted.lifetime_calls, 2);
    assert.deepEqual(demoted.former_paths, [
      "drafts/memory.json",
      "memory_tool.json",
    ]);
    assert.deepEqual(
      (demoted.lineage_events as Array<{ type: string }>).map((event) => event.type),
      ["created", "promoted", "demoted"],
    );
    assert.equal(
      recordRecipeReview(draft, "draft-review-001", new Date("2026-01-03T00:00:00.000Z"), root),
      true,
    );
    const reviewed = readRecipeUsage(draft, root)!;
    assert.deepEqual(reviewed.review_epochs, ["draft-review-001"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe lineage follows one unambiguous external rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-rename-"));
  const before = join(root, "before.json");
  const after = join(root, "after.json");
  try {
    await writeFile(before, JSON.stringify({ template: "echo ok" }));
    assert.equal(recordRecipeLaunch(before, new Date("2026-01-01T00:00:00.000Z"), "tool", root), true);
    const initial = readRecipeUsage(before, root)!;
    await rename(before, after);
    assert.equal(recordRecipeLaunch(after, new Date("2026-01-02T00:00:00.000Z"), "tool", root), true);
    const renamed = readRecipeUsage(after, root)!;
    assert.equal(initial.lineage_name, "before");
    assert.equal(renamed.lineage_name, "after");
    assert.equal(renamed.lifetime_calls, 2);
    assert.deepEqual(renamed.former_paths, ["before.json"]);
    assert.deepEqual(renamed.former_names, ["before"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown recipes receive stable lineage and revision counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-markdown-"));
  const recipe = join(root, "memory.md");
  try {
    await writeFile(recipe, "---\ndescription: Memory\n---\n\n```command\necho one\n```\n");
    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-01T00:00:00.000Z"), "tool", root), true);
    const initial = readRecipeUsage(recipe, root)!;
    await writeFile(recipe, "---\ndescription: Memory\n---\n\n```command\necho two\n```\n");
    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-02T00:00:00.000Z"), "tool", root), true);
    const changed = readRecipeUsage(recipe, root)!;
    assert.equal(changed.lineage_name, initial.lineage_name);
    assert.equal(changed.lifetime_calls, 2);
    assert.equal(changed.revision_calls, 1);
    assert.equal(changed.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
