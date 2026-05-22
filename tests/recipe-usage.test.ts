/**
 * Recipe usage telemetry regressions
 * Covers launch counters used for muscle-memory cleanup decisions
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordRecipeLaunch } from "../lib/recipe-usage.ts";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("Recipe usage launch counter increments inline metadata", async () => {
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

    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-02T03:04:05.000Z")), true);
    assert.equal(recordRecipeLaunch(recipe, new Date("2026-01-03T03:04:05.000Z")), true);

    const updated = await readJson(recipe);
    assert.deepEqual(updated.usage, {
      calls: 2,
      last_called: "2026-01-03T03:04:05.000Z",
    });
    assert.equal(updated.template, "echo ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
