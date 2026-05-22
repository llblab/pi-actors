/**
 * File-discovered recipe registry regressions
 * Covers filename identity, priority shadowing, invalid blocking, disabled overrides, and tool exposure
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverRecipeSources, discoverRecipes, summarizeDiscovery } from "../lib/recipe-discovery.ts";

async function writeRecipe(root: string, name: string, body: Record<string, unknown>) {
  await writeFile(join(root, `${name}.json`), JSON.stringify(body));
}

test("Recipe discovery exposes tool recipes by filename identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    await writeRecipe(root, "docs-review", {
      tool: true,
      description: "Docs review",
      template: "echo review",
    });

    const result = discoverRecipes([root]);
    const recipe = result.active.get("docs-review")!;
    assert.equal(recipe.active, true);
    assert.equal(recipe.tool, true);
    assert.equal(recipe.config?.name, "docs-review");
    assert.equal(recipe.config?.description, "Docs review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery can expose user recipe roots as tools by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    await writeRecipe(root, "default-tool", {
      description: "Default tool recipe",
      template: "echo default",
    });
    await writeRecipe(root, "recipe-only", {
      tool: false,
      description: "Recipe-only override",
      template: "echo recipe-only",
    });

    const result = discoverRecipeSources([{ root, defaultTool: true, mutableUsage: true }]);
    assert.equal(result.active.get("default-tool")?.tool, true);
    assert.equal(result.active.get("default-tool")?.mutableUsage, true);
    assert.equal(result.active.get("recipe-only")?.tool, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery gives higher-priority roots shadowing control", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeRecipe(low, "repo-health", {
      tool: true,
      description: "Packaged repo health",
      template: "echo low",
    });
    await writeRecipe(high, "repo-health", {
      tool: false,
      description: "User repo health override",
      template: "echo high",
    });

    const result = discoverRecipes([high, low]);
    const active = result.active.get("repo-health")!;
    assert.equal(active.path, join(high, "repo-health.json"));
    assert.equal(active.tool, false);
    assert.deepEqual(active.shadows, [join(low, "repo-health.json")]);
    assert.equal(result.entries.find((entry) => entry.path === join(low, "repo-health.json"))?.shadowed, true);
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});

test("Recipe discovery invalid high-priority recipe blocks lower fallback", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeFile(join(high, "repo-health.json"), JSON.stringify({ tool: true }));
    await writeRecipe(low, "repo-health", {
      tool: true,
      description: "Packaged repo health",
      template: "echo low",
    });

    const result = discoverRecipes([high, low]);
    const active = result.active.get("repo-health")!;
    assert.equal(active.invalid, true);
    assert.equal(active.tool, false);
    assert.equal(active.path, join(high, "repo-health.json"));
    assert.match(result.diagnostics.join("\n"), /blocks lower-priority/);
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});

test("Recipe discovery priority models user recipes over ad hoc files over packaged stdlib", async () => {
  const agentRecipes = await mkdtemp(join(tmpdir(), "pi-actors-discovery-agent-"));
  const adHocRoot = await mkdtemp(join(tmpdir(), "pi-actors-discovery-adhoc-"));
  const packagedRoot = await mkdtemp(join(tmpdir(), "pi-actors-discovery-packaged-"));
  try {
    const adHocFile = join(adHocRoot, "same-name.json");
    await writeRecipe(packagedRoot, "same-name", {
      tool: true,
      description: "Packaged standard library recipe",
      template: "echo packaged",
    });
    await writeFile(
      adHocFile,
      JSON.stringify({
        tool: true,
        description: "Ad hoc selected recipe",
        template: "echo adhoc",
      }),
    );
    await writeRecipe(agentRecipes, "same-name", {
      tool: true,
      description: "Agent recipe override",
      template: "echo agent",
    });

    const result = discoverRecipeSources([
      { root: agentRecipes, defaultTool: true, mutableUsage: true },
      { file: adHocFile },
      { root: packagedRoot },
    ]);
    const active = result.active.get("same-name")!;
    assert.equal(active.path, join(agentRecipes, "same-name.json"));
    assert.deepEqual(active.shadows, [adHocFile, join(packagedRoot, "same-name.json")]);
  } finally {
    await rm(agentRecipes, { recursive: true, force: true });
    await rm(adHocRoot, { recursive: true, force: true });
    await rm(packagedRoot, { recursive: true, force: true });
  }
});

test("Recipe discovery summary exposes active shadowed invalid and disabled entries", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeFile(join(high, "broken.json"), JSON.stringify({ tool: true }));
    await writeRecipe(high, "disabled-one", {
      disabled: true,
      template: "echo disabled",
    });
    await writeRecipe(high, "same-name", {
      description: "High",
      template: "echo high",
    });
    await writeRecipe(low, "same-name", {
      description: "Low",
      template: "echo low",
    });

    const summary = summarizeDiscovery(
      discoverRecipeSources([{ root: high, defaultTool: true }, { root: low }]),
    );

    assert.equal((summary.active as Array<{ id: string }>).length, 3);
    assert.deepEqual(
      (summary.shadowed as Array<{ id: string }>).map((entry) => entry.id),
      ["same-name"],
    );
    assert.deepEqual(
      (summary.invalid as Array<{ id: string }>).map((entry) => entry.id),
      ["broken"],
    );
    assert.deepEqual(
      (summary.disabled as Array<{ id: string }>).map((entry) => entry.id),
      ["disabled-one"],
    );
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});

test("Recipe discovery disabled recipe blocks lower fallback", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeRecipe(high, "repo-health", {
      disabled: true,
      description: "Disable repo health",
      template: "echo disabled",
    });
    await writeRecipe(low, "repo-health", {
      tool: true,
      description: "Packaged repo health",
      template: "echo low",
    });

    const result = discoverRecipes([high, low]);
    const active = result.active.get("repo-health")!;
    assert.equal(active.disabled, true);
    assert.equal(active.tool, false);
    assert.deepEqual(active.shadows, [join(low, "repo-health.json")]);
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});
