/**
 * Legacy registry migration regressions
 * Covers actors-tools.json migration into file-discovered recipes
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateLegacyToolRegistry } from "../lib/recipe-migration.ts";
import { readResolvedRecipeConfig } from "../lib/recipe-references.ts";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("Legacy registry migration writes tool recipes and archives source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-migration-"));
  try {
    const configPath = join(root, "actors-tools.json");
    const recipeRoot = join(root, "recipes");
    await writeFile(
      configPath,
      JSON.stringify({
        hello_tool: {
          description: "Say hello",
          args: ["name:string=world"],
          template: "echo hello {name}",
        },
      }),
    );

    const result = migrateLegacyToolRegistry({
      configPath,
      recipeRoot,
      reservedToolNames: new Set(),
    });

    assert.deepEqual(result.migrated, ["hello_tool"]);
    assert.ok(result.archive);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(result.archive!), true);
    assert.equal(existsSync(result.report!), true);

    const recipePath = join(recipeRoot, "hello_tool.json");
    const recipe = await readJson(recipePath);
    assert.equal(recipe.tool, true);
    assert.equal(recipe.description, "Say hello");
    assert.deepEqual(recipe.args, ["name"]);
    assert.deepEqual(recipe.defaults, { name: "world" });
    assert.equal(recipe.template, "echo hello {name}");

    const parsed = readResolvedRecipeConfig(recipePath)!;
    assert.equal(parsed.name, "hello_tool");
    assert.equal(parsed.tool, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Legacy registry migration does not overwrite existing recipe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-migration-"));
  try {
    const configPath = join(root, "actors-tools.json");
    const recipeRoot = join(root, "recipes");
    await writeFile(
      configPath,
      JSON.stringify({
        hello_tool: {
          description: "Say hello",
          template: "echo hello",
        },
      }),
    );
    await writeFile(join(recipeRoot, "placeholder"), "").catch(async () => {
      await import("node:fs/promises").then((fs) => fs.mkdir(recipeRoot, { recursive: true }));
      await writeFile(join(recipeRoot, "placeholder"), "");
    });
    await writeFile(
      join(recipeRoot, "hello_tool.json"),
      JSON.stringify({ description: "Existing", template: "echo existing" }),
    );

    const result = migrateLegacyToolRegistry({
      configPath,
      recipeRoot,
      reservedToolNames: new Set(),
    });

    assert.deepEqual(result.conflicts, ["hello_tool"]);
    assert.equal(result.archive, undefined);
    assert.equal(existsSync(configPath), true);
    const recipe = await readJson(join(recipeRoot, "hello_tool.json"));
    assert.equal(recipe.description, "Existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
