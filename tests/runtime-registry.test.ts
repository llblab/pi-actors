/**
 * Runtime registry loading regressions
 * Covers 0.16 recipe-discovered tool activation
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandTemplateExecResult } from "../lib/command-templates.ts";
import { createAutoToolsRuntime } from "../lib/runtime.ts";

const exec = async (): Promise<CommandTemplateExecResult> => ({
  code: 0,
  killed: false,
  stderr: "",
  stdout: "ok",
});

async function writeRecipe(root: string, name: string, body: Record<string, unknown>) {
  await writeFile(join(root, `${name}.json`), JSON.stringify(body));
}

test("Runtime skips invalid user recipes without aborting load", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "bad-repeat", {
      description: "Bad repeat",
      template: { repeat: "{count}", template: "echo {item}" },
    });

    const notifications: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "legacy-tool-registry.json"),
      exec,
      getAllTools: () => [],
      packagedRecipeRoot,
      recipeRoot,
      registerTool: () => assert.fail("invalid recipe should not register"),
      reservedToolNames: new Set(),
    });

    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });

    assert.equal(runtime.getTools().has("bad-repeat"), false);
    assert.match(notifications.join("\n"), /Command template repeat/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime suppresses routine bash wrapper startup warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "bash-wrapper", {
      description: "Trusted local wrapper",
      template: "bash -- ./script.sh",
    });

    const notifications: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "legacy-tool-registry.json"),
      exec,
      getAllTools: () => [],
      packagedRecipeRoot,
      recipeRoot,
      registerTool: () => {},
      reservedToolNames: new Set(),
    });

    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });

    assert.equal(runtime.getTools().has("bash-wrapper"), true);
    assert.equal(notifications.join("\n"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime loads tools from discovered user recipes by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-registry-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRecipeRoot = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(recipeRoot, { recursive: true }),
        fs.mkdir(packagedRecipeRoot, { recursive: true }),
      ]),
    );
    await writeRecipe(recipeRoot, "user-tool", {
      description: "User tool",
      args: ["scope:path"],
      template: "echo {scope}",
    });
    await writeRecipe(recipeRoot, "recipe-only", {
      description: "Recipe only",
      template: "echo hidden",
    });
    await writeRecipe(packagedRecipeRoot, "stdlib-component", {
      description: "Packaged component",
      template: "echo component",
    });
    await writeRecipe(packagedRecipeRoot, "stdlib-tool", {
      description: "Packaged component",
      template: "echo component",
    });

    const registered: string[] = [];
    let activeTools = ["read"];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "legacy-tool-registry.json"),
      exec,
      getActiveTools: () => activeTools,
      getAllTools: () => [],
      packagedRecipeRoot,
      recipeRoot,
      registerTool: (definition) => {
        registered.push(definition.name);
        activeTools = [...new Set([...activeTools, definition.name])];
      },
      reservedToolNames: new Set(),
      setActiveTools: (toolNames) => {
        activeTools = toolNames;
      },
    });

    runtime.loadTools({ hasUI: false, ui: { notify() {} } });

    assert.deepEqual([...runtime.getTools().keys()].sort(), [
      "recipe-only",
      "user-tool",
    ]);
    assert.equal(runtime.getTools().get("user-tool")?.sourcePath, join(recipeRoot, "user-tool.json"));
    assert.equal(runtime.getTools().get("recipe-only")?.sourcePath, join(recipeRoot, "recipe-only.json"));
    assert.equal(runtime.getTools().get("stdlib-tool"), undefined);
    assert.deepEqual(registered.sort(), ["recipe-only", "user-tool"]);

    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.deepEqual(registered.sort(), ["recipe-only", "user-tool"]);

    await writeRecipe(recipeRoot, "user-tool", {
      description: "Updated user tool",
      args: ["scope:path"],
      template: "echo updated {scope}",
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.deepEqual(registered.sort(), ["recipe-only", "user-tool", "user-tool"]);

    await writeRecipe(packagedRecipeRoot, "fallback", {
      description: "Packaged fallback",
      template: "echo packaged",
    });
    await writeRecipe(recipeRoot, "fallback", {
      description: "Broken user winner",
      template: "echo broken",
      repeat: 0,
    });
    const warnings: string[] = [];
    runtime.loadTools({ hasUI: true, ui: { notify: (message) => warnings.push(message) } });
    assert.equal(runtime.getTools().has("fallback"), false);
    assert.match(warnings.join("\n"), /blocks lower-priority recipes/);

    await writeRecipe(recipeRoot, "fallback", {
      description: "Recovered user winner",
      template: "echo recovered {topic}",
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.equal(runtime.getTools().get("fallback")?.description, "Recovered user winner");
    assert.deepEqual(runtime.getTools().get("fallback")?.args, ["topic"]);

    await unlink(join(recipeRoot, "user-tool.json"));
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.equal(runtime.getTools().has("user-tool"), false);
    assert.deepEqual(activeTools.sort(), ["fallback", "read", "recipe-only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
