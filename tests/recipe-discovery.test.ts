/**
 * File-discovered recipe registry regressions
 * Covers filename identity, priority shadowing, invalid blocking, disabled overrides, and tool exposure
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getPackagedRecipeRoot } from "../lib/paths.ts";
import { createRecipeIntegrityManifest, discoverRecipeSources, discoverRecipes, getShadowedLaunchDiagnostic, listCandidateRecipes, summarizeDiscovery } from "../lib/recipe-discovery.ts";

async function writeRecipe(root: string, name: string, body: Record<string, unknown>) {
  await writeFile(join(root, `${name}.json`), JSON.stringify(body));
}

test("Recipe discovery exposes tool recipes by location and filename identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-"));
  try {
    await writeRecipe(root, "docs-review", {
      name: "ignored-docs-review",
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

test("Recipe discovery loads packaged quorum review without repeat diagnostics", () => {
  const result = discoverRecipeSources([
    { root: getPackagedRecipeRoot(), defaultTool: true },
  ]);
  const recipe = result.active.get("pipeline-quorum-review");
  assert.equal(recipe?.active, true);
  assert.equal(recipe?.invalid, false);
  assert.doesNotMatch(result.diagnostics.join("\n"), /pipeline-quorum-review|repeat must/);
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
    await writeRecipe(root, "location-tool", {
      description: "Tool exposure comes from location",
      template: "echo recipe-only",
    });

    const result = discoverRecipeSources([{ root, defaultTool: true, mutableUsage: true }]);
    assert.equal(result.active.get("default-tool")?.tool, true);
    assert.equal(result.active.get("default-tool")?.mutableUsage, true);
    assert.equal(result.active.get("location-tool")?.tool, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery gives higher-priority roots shadowing control", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeRecipe(low, "repo-health", {
      description: "Packaged repo health",
      template: "echo low",
    });
    await writeRecipe(high, "repo-health", {
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

test("Recipe discovery diagnostics keep invalid recipe causes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-invalid-"));
  try {
    await writeFile(join(root, "bad-json.json"), "{ nope");
    await writeFile(join(root, "missing-template.json"), JSON.stringify({ description: "No template" }));
    await writeFile(join(root, "bad-md.md"), "---\ndescription: Bad\n---\n\nNo executable fence.\n");

    const result = discoverRecipeSources([{ root, defaultTool: true }]);
    const diagnostics = result.diagnostics.join("\n");
    assert.match(diagnostics, /bad-json\.json.*Expected property name|bad-json\.json.*JSON/);
    assert.match(diagnostics, /missing-template\.json: recipe must define template/);
    assert.match(diagnostics, /bad-md\.md: Markdown recipe has no executable recipe\/template fence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery invalid high-priority recipe blocks lower fallback", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeFile(join(high, "repo-health.json"), JSON.stringify({}));
    await writeRecipe(low, "repo-health", {
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

test("Recipe discovery keeps ad hoc recipe files as components", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-adhoc-"));
  try {
    const file = join(root, "selected.json");
    await writeFile(
      file,
      JSON.stringify({
        description: "Ad hoc selected recipe",
        template: "echo adhoc",
      }),
    );

    const result = discoverRecipeSources([{ file }]);
    const active = result.active.get("selected")!;
    assert.equal(active.path, file);
    assert.equal(active.tool, false);
    assert.equal(active.active, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery priority models user recipes over ad hoc files over packaged stdlib", async () => {
  const agentRecipes = await mkdtemp(join(tmpdir(), "pi-actors-discovery-agent-"));
  const adHocRoot = await mkdtemp(join(tmpdir(), "pi-actors-discovery-adhoc-"));
  const packagedRoot = await mkdtemp(join(tmpdir(), "pi-actors-discovery-packaged-"));
  try {
    const adHocFile = join(adHocRoot, "same-name.json");
    await writeRecipe(packagedRoot, "same-name", {
      description: "Packaged standard library recipe",
      template: "echo packaged",
    });
    await writeFile(
      adHocFile,
      JSON.stringify({
        description: "Ad hoc selected recipe",
        template: "echo adhoc",
      }),
    );
    await writeRecipe(agentRecipes, "same-name", {
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

test("Recipe discovery summary exposes structured diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-discovery-diagnostics-"));
  try {
    await writeFile(join(root, "broken.json"), "{ nope");
    const result = discoverRecipeSources([{ root, defaultTool: true }]);
    const summary = summarizeDiscovery(result);
    const details = summary.diagnostic_details as Array<Record<string, unknown>>;
    assert.ok(details.length > 0);
    assert.equal(details.some((item) => item.severity === "error"), true);
    assert.equal(details.some((item) => String(item.path).endsWith("broken.json")), true);
    assert.equal(details.every((item) => typeof item.action === "string"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery summary exposes active shadowed invalid and disabled entries", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-low-"));
  try {
    await writeFile(join(high, "broken.json"), JSON.stringify({}));
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

test("Recipe discovery summary exposes prioritized doctor remediations", async () => {
  const high = await mkdtemp(join(tmpdir(), "pi-actors-discovery-doctor-high-"));
  const low = await mkdtemp(join(tmpdir(), "pi-actors-discovery-doctor-low-"));
  try {
    await writeFile(join(high, "broken.json"), "{ nope");
    await writeRecipe(low, "broken", {
      description: "Fallback",
      template: "echo fallback",
    });
    await writeRecipe(high, "disabled-one", {
      disabled: true,
      template: "echo disabled",
    });
    await writeRecipe(low, "disabled-one", {
      template: "echo fallback disabled",
    });
    await writeRecipe(high, "shell-risk", {
      template: "bash -c 'echo risky'",
    });

    const summary = summarizeDiscovery(
      discoverRecipeSources([{ root: high, defaultTool: true }, { root: low }]),
    );
    const remediations = summary.remediations as Array<Record<string, unknown>>;

    assert.deepEqual(
      remediations.map((item) => item.kind),
      ["blocking_invalid", "blocking_disabled", "risky_shell_boundary", "shadowed", "shadowed"],
    );
    assert.deepEqual(summary.top_action, remediations[0]);
    assert.equal(remediations[0].id, "broken");
    assert.equal(
      String(remediations[0].blocked_candidate).endsWith("broken.json"),
      true,
    );
  } finally {
    await rm(high, { recursive: true, force: true });
    await rm(low, { recursive: true, force: true });
  }
});

test("Recipe discovery exposes quiet launch diagnostics only for broken shadowing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const high = join(root, "user");
    const low = join(root, "packaged");
    await mkdir(high, { recursive: true });
    await mkdir(low, { recursive: true });
    await writeRecipe(low, "worker", {
      template: "echo packaged",
    });
    await writeRecipe(high, "worker", {
      template: "echo user override",
    });
    let result = discoverRecipeSources([
      { root: high, defaultTool: true },
      { root: low, defaultTool: false },
    ]);
    assert.equal(getShadowedLaunchDiagnostic(result, "worker"), undefined);

    await writeRecipe(high, "worker", {
      disabled: true,
      template: "echo disabled override",
    });
    result = discoverRecipeSources([
      { root: high, defaultTool: true },
      { root: low, defaultTool: false },
    ]);
    assert.deepEqual(getShadowedLaunchDiagnostic(result, "worker"), {
      active_path: join(high, "worker.json"),
      blocked_candidate: join(low, "worker.json"),
      hint: "inspect_recipes_doctor",
      reason: "shadowed_disabled",
    });

    await writeFile(join(high, "worker.json"), "{ bad json", "utf8");
    result = discoverRecipeSources([
      { root: high, defaultTool: true },
      { root: low, defaultTool: false },
    ]);
    assert.deepEqual(getShadowedLaunchDiagnostic(result, "worker"), {
      active_path: join(high, "worker.json"),
      blocked_candidate: join(low, "worker.json"),
      hint: "inspect_recipes_doctor",
      reason: "shadowed_invalid",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe discovery lists candidate recipes outside the active tool root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidates-"));
  try {
    await writeRecipe(root, "draft", {
      description: "Draft capability",
      template: "echo draft",
    });
    assert.deepEqual(listCandidateRecipes(root), [
      {
        description: "Draft capability",
        id: "draft",
        path: join(root, "draft.json"),
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
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
