/**
 * Recipe usage telemetry regressions
 * Covers launch counters used for muscle-memory cleanup decisions
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  discoverRecipeSources,
  summarizeDiscovery,
} from "../lib/recipes-discovery.ts";
import { readRecipeUsage, recordRecipeLaunch } from "../lib/recipes-usage.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function recordLaunchInChild(moduleUrl: string, recipe: string): Promise<void> {
  const script = `
    const { recordRecipeLaunch } = await import(process.argv[1]);
    if (!recordRecipeLaunch(process.argv[2], new Date(), "tool")) process.exit(2);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "-e", script, moduleUrl, recipe],
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

test("Recipe usage launch counter increments sidecar metadata", async () => {
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

test("Recipe usage counter resets after recipe content changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-usage-"));
  try {
    const recipe = join(root, "memory.json");
    await writeFile(recipe, JSON.stringify({ template: "echo one" }));

    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-02T03:04:05.000Z")), true);
    const beforeUsage = readRecipeUsage(recipe)!;
    await writeFile(recipe, JSON.stringify({ template: "echo two", external: true }));

    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-03T03:04:05.000Z")), true);
    const usage = readRecipeUsage(recipe)!;
    assert.equal(usage.calls, 1);
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
    assert.equal(summary.active?.[0]?.usage?.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
