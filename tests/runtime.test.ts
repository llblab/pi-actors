/**
 * Runtime registry loading regressions
 * Covers 0.16 recipe-discovered tool activation
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandTemplateExecResult } from "../lib/command-templates.ts";
import {
  createAutoToolsRuntime,
  createRecipeToolReloadWatcher,
} from "../lib/runtime.ts";

const exec = async (): Promise<CommandTemplateExecResult> => ({
  code: 0,
  killed: false,
  stderr: "",
  stdout: "ok",
});

async function writeRecipe(
  root: string,
  name: string,
  body: Record<string, unknown>,
) {
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
      configPath: join(root, "tool-registry.json"),
      exec,
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
      configPath: join(root, "tool-registry.json"),
      exec,
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

test("Runtime treats same-id recipe shadowing as a normal override", async () => {
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
    await writeRecipe(packagedRecipeRoot, "music_player", {
      description: "Packaged player",
      template: "echo packaged",
    });
    await writeRecipe(recipeRoot, "music_player", {
      description: "User player",
      template: "echo user",
    });

    const notifications: string[] = [];
    const registered: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      packagedRecipeRoot,
      recipeRoot,
      registerTool: (definition) => registered.push(definition.name),
      reservedToolNames: new Set(),
    });

    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });

    assert.deepEqual(registered, ["music_player"]);
    assert.equal(
      runtime.getTools().get("music_player")?.description,
      "User player",
    );
    assert.equal(notifications.join("\n"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime keeps reserved tool names protected during recipe loading", async () => {
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
    await writeRecipe(recipeRoot, "read", {
      description: "Unsafe core override",
      template: "echo nope",
    });

    const notifications: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec,
      packagedRecipeRoot,
      recipeRoot,
      registerTool: () => assert.fail("reserved recipe should not register"),
      reservedToolNames: new Set(["read"]),
    });

    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    });

    assert.match(notifications.join("\n"), /Reserved tool name: read/);
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
      configPath: join(root, "tool-registry.json"),
      exec,
      getActiveTools: () => activeTools,
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
    assert.equal(
      runtime.getTools().get("user-tool")?.sourcePath,
      join(recipeRoot, "user-tool.json"),
    );
    assert.equal(
      runtime.getTools().get("recipe-only")?.sourcePath,
      join(recipeRoot, "recipe-only.json"),
    );
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
    assert.deepEqual(registered.sort(), [
      "recipe-only",
      "user-tool",
      "user-tool",
    ]);

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
    runtime.loadTools({
      hasUI: true,
      ui: { notify: (message) => warnings.push(message) },
    });
    assert.equal(runtime.getTools().has("fallback"), false);
    assert.match(warnings.join("\n"), /blocks lower-priority recipes/);

    await writeRecipe(recipeRoot, "fallback", {
      description: "Recovered user winner",
      template: "echo recovered {topic}",
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.equal(
      runtime.getTools().get("fallback")?.description,
      "Recovered user winner",
    );
    assert.deepEqual(runtime.getTools().get("fallback")?.args, ["topic"]);

    await unlink(join(recipeRoot, "user-tool.json"));
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.equal(runtime.getTools().has("user-tool"), false);
    assert.deepEqual(activeTools.sort(), ["fallback", "read", "recipe-only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stale recipe watcher callbacks cannot close a replacement watcher", async () => {
  class FakeWatcher extends EventEmitter {
    closed = false;
    readonly path: string;
    readonly listener: (event: string, changedFile: string | null) => void;

    constructor(
      path: string,
      listener: (event: string, changedFile: string | null) => void,
    ) {
      super();
      this.path = path;
      this.listener = listener;
    }

    close(): void {
      this.closed = true;
    }

    change(changedFile: string | null = null): void {
      this.listener("rename", changedFile);
    }
  }

  const recipeRoot = "/agent/recipes";
  let rootExists = true;
  let loads = 0;
  const watchers: FakeWatcher[] = [];
  const watcher = createRecipeToolReloadWatcher(
    { loadTools: () => { loads += 1; } },
    {
      exists: (path) => path === "/agent" || (path === recipeRoot && rootExists),
      recipeRoot,
      watchPath: ((path: string, listener: FakeWatcher["listener"]) => {
        const created = new FakeWatcher(path, listener);
        watchers.push(created);
        return created;
      }) as unknown as typeof import("node:fs").watch,
    },
  );
  const ctx = { hasUI: true, ui: { notify() {} } };

  watcher.watch(ctx);
  const firstRoot = watchers[0]!;
  rootExists = false;
  firstRoot.change();
  const parent = watchers[1]!;
  rootExists = true;
  parent.change("recipes");
  const replacementRoot = watchers[2]!;

  firstRoot.emit("error", new Error("delayed stale error"));
  firstRoot.change("stale-event.json");
  assert.equal(replacementRoot.closed, false);
  replacementRoot.change("tool.json");
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(loads, 1);
  assert.equal(replacementRoot.closed, false);
  watcher.close();
});

test("Recipe watcher rearms when the recipe root appears", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-runtime-watch-root-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let loads = 0;
  const notifications: string[] = [];
  const watcher = createRecipeToolReloadWatcher({
    loadTools() {
      loads += 1;
    },
  });
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  async function waitForLoad(previous: number): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (loads > previous) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`recipe watcher did not reload after ${previous}`);
  }
  try {
    watcher.watch(ctx);
    const recipeRoot = join(agentDir, "recipes");
    await mkdir(recipeRoot);
    await writeRecipe(recipeRoot, "first", {
      description: "First",
      template: "echo first",
    });
    await waitForLoad(0);
    assert.match(notifications.join("\n"), /Recipe tools refreshed/);

    let previousLoads = loads;
    await rm(recipeRoot, { recursive: true, force: true });
    await waitForLoad(previousLoads);
    previousLoads = loads;
    await mkdir(recipeRoot);
    await writeRecipe(recipeRoot, "second", {
      description: "Second",
      template: "echo second",
    });
    await waitForLoad(previousLoads);
    watcher.close();
    watcher.close();
  } finally {
    watcher.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
