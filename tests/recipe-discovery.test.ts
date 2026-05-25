/**
 * File-discovered recipe registry regressions
 * Covers filename identity, priority shadowing, invalid blocking, disabled overrides, and tool exposure
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getPackagedRecipeRoot } from "../lib/paths.ts";
import { createRecipeIntegrityManifest, discoverRecipeSources, discoverRecipes, summarizeDiscovery } from "../lib/recipe-discovery.ts";

async function writeRecipe(root: string, name: string, body: Record<string, unknown>) {
  await writeFile(join(root, `${name}.json`), JSON.stringify(body));
}

test("Recipe discovery exposes tool recipes by location and filename identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    await writeRecipe(root, "docs-review", {
      name: "ignored-docs-review",
      tool: false,
      description: "Docs review",
      template: "echo review",
    });

    const result = discoverRecipeSources([{ root, defaultTool: true }]);
    const recipe = result.active.get("docs-review")!;
    assert.equal(recipe.active, true);
    assert.equal(recipe.tool, true);
    assert.equal(recipe.config?.name, "docs-review");
    assert.equal(recipe.config?.description, "Docs review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery surfaces risky recipe diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    await chmod(root, 0o777);
    await writeRecipe(root, "shell-risk", {
      description: "Shell risk",
      template: "bash -c {script}",
    });
    const result = discoverRecipeSources([{ root, defaultTool: true }]);
    const diagnostics = result.diagnostics.join("\n");
    assert.match(diagnostics, /world-writable/);
    assert.match(diagnostics, /group-writable/);
    assert.match(diagnostics, /invokes bash/);
    assert.match(result.active.get("shell-risk")?.diagnostics.join("\n") ?? "", /bash/);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery flags packaged validation wrapper as trusted shell boundary", () => {
  const result = discoverRecipeSources([
    { root: getPackagedRecipeRoot(), defaultTool: true },
  ]);
  const diagnostics =
    result.active.get("utility-validation-wrapper")?.diagnostics.join("\n") ?? "";
  assert.match(diagnostics, /invokes bash/);
  assert.match(diagnostics, /trusted executable content/);
});

test("Recipe discovery exposes an integrity manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    const body = JSON.stringify({ description: "Manifest", template: "echo manifest" });
    await writeFile(join(root, "manifest.json"), body);
    const result = discoverRecipeSources([{ root, defaultTool: true }]);
    const manifest = createRecipeIntegrityManifest(result);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, "manifest");
    assert.equal(manifest[0].size, Buffer.byteLength(body));
    assert.equal(
      manifest[0].sha256,
      createHash("sha256").update(body).digest("hex"),
    );
    const summary = summarizeDiscovery(result);
    assert.deepEqual(summary.integrity_manifest, manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery exposes user recipe roots as tools by location", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    await writeRecipe(root, "default-tool", {
      description: "Default tool recipe",
      template: "echo default",
    });
    await writeRecipe(root, "recipe-owned-flag", {
      tool: false,
      description: "Tool flag is ignored",
      template: "echo recipe-only",
    });

    const result = discoverRecipeSources([{ root, defaultTool: true, mutableUsage: true }]);
    assert.equal(result.active.get("default-tool")?.tool, true);
    assert.equal(result.active.get("default-tool")?.mutableUsage, true);
    assert.equal(result.active.get("recipe-owned-flag")?.tool, true);
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

    const result = discoverRecipeSources([{ root: high, defaultTool: true }, { root: low }]);
    const active = result.active.get("repo-health")!;
    assert.equal(active.path, join(high, "repo-health.json"));
    assert.equal(active.tool, true);
    assert.deepEqual(active.shadows, [join(low, "repo-health.json")]);
    assert.equal(result.entries.find((entry) => entry.path === join(low, "repo-health.json"))?.shadowed, true);
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});

test("Recipe discovery loads Markdown recipes and lets same-id JSON shadow Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-md-"));
  try {
    await writeFile(join(root, "literate.md"), "---\ndescription: Literate\n---\n\n```template\necho md\n```\n");
    await writeFile(join(root, "same.md"), "---\ndescription: Markdown\n---\n\n```template\necho md\n```\n");
    await writeRecipe(root, "same", { description: "JSON", template: "echo json" });

    const result = discoverRecipeSources([{ root, defaultTool: true }]);
    assert.equal(result.active.get("literate")?.config?.template, "echo md");
    assert.equal(result.active.get("same")?.path, join(root, "same.json"));
    const shadow = result.entries.find((entry) => entry.path === join(root, "same.md"));
    assert.equal(shadow?.shadowed, true);
    assert.match(shadow?.diagnostics.join("\n") ?? "", /shadowed by JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
      usage: { calls: 2, last_called: "2026-01-03T03:04:05.000Z" },
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
      (summary.active as Array<{ id: string; usage?: { calls?: number } }>).find(
        (entry) => entry.id === "same-name",
      )?.usage,
      { calls: 2, last_called: "2026-01-03T03:04:05.000Z" },
    );
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
    assert.deepEqual(
      (summary.recommendations as Array<{ id: string }>).map((entry) => entry.id),
      ["broken", "disabled-one", "same-name", "same-name"],
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
