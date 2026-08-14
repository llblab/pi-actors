/**
 * Registration-truth journey regression.
 * Proves the 0.46.0 live-context disagreement remains closed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import { createRecipeResolutionContext } from "../lib/recipes-context.ts";
import { executeRegisterTool } from "../lib/registry.ts";
import {
  createActiveSkillRecipeContext,
  inventoryActiveSkillRecipeComponents,
  readResolvedRecipeConfig,
} from "../lib/recipes-references.ts";
import {
  admitUserRecipe,
  discoverRecipeSources,
  toRegisteredTool,
} from "../lib/recipes-discovery.ts";
import { readRecipeUsage } from "../lib/recipes-usage.ts";
import {
  createAutoToolsRuntime,
  createRecipeToolReloadWatcher,
} from "../lib/runtime.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";
import { createRuntimeToolDefinition } from "../lib/tools-local.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";

const playerRecipe = {
  async: true,
  args: [
    "command:enum(play,pause,status)",
    "source:path",
    "loop:bool",
    "volume:int",
    "state_dir:path",
  ],
  defaults: { command: "play", loop: "true", volume: "70" },
  control: ["play", "pause", "status"],
  template: "echo {skill_dir} {command} {source} {loop} {volume} {state_dir}",
};

async function writeSkillRecipe(
  skillsRoot: string,
  skill: string,
  stem: string,
  recipe: Record<string, unknown>,
): Promise<string> {
  const skillDir = join(skillsRoot, skill);
  const recipesDir = join(skillDir, "recipes");
  await mkdir(recipesDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  await writeFile(join(recipesDir, `${stem}.json`), JSON.stringify(recipe));
  return skillDir;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`file did not appear: ${path}`);
}

test("0.46.1 registration truth journey closes the live Skill-wrapper contradiction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-registration-truth-"));
  const runId = `registration-truth-${process.pid}-${Date.now()}`;
  const wrapperRunId = `${runId}-wrapper`;
  const toolRunId = `${runId}-tool`;
  const runStateDir = join(getRunStateRoot(), runId);
  try {
    const skillsRoot = join(root, "skills");
    const recipeRoot = join(root, "user-recipes");
    const mediaDir = await writeSkillRecipe(
      skillsRoot,
      "media",
      "player",
      playerRecipe,
    );
    const staleDir = await writeSkillRecipe(skillsRoot, "stale", "broken", {
      name: "removed-identity",
      template: "echo broken",
    });
    const skillContext = createActiveSkillRecipeContext([
      { name: "media", baseDir: mediaDir },
      { name: "stale", baseDir: staleDir },
    ]);
    const qa = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "skills", "actors", "scripts", "validate-recipe.mjs"),
        join(mediaDir, "recipes", "player.json"),
        "--summary",
      ],
      { encoding: "utf8" },
    );
    assert.equal(qa.status, 0, qa.stderr || qa.stdout);

    const recipeResolutionContext = createRecipeResolutionContext(
      "registration-truth-session",
      root,
      skillContext,
    );
    const spawnResult = await createSpawnToolDefinition().execute(
      "registration-truth-spawn",
      {
        as: `run:${runId}`,
        recipe: "media/player",
        values: { source: "fixture-library" },
      },
      undefined,
      undefined,
      { recipeResolutionContext, cwd: root },
    );
    assert.equal(spawnResult.details.recipe_file, join(mediaDir, "recipes", "player.json"));
    await waitForFile(join(runStateDir, "result.json"));

    const tools = new Map<string, RegisteredTool>();
    const registered: RegisteredTool[] = [];
    const registration = await executeRegisterTool(
      {
        args: "source:path=~/Music/1MIX",
        description: "Play local music.",
        name: "music_player",
        template: { template: "media/player" },
      },
      { recipeResolutionContext },
      {
        configPath: join(root, "registry.json"),
        recipeRoot,
        getActiveTools: () => [],
        getToolNameBlocker: () => undefined,
        getTools: () => tools,
        notify: () => undefined,
        registerRuntimeTool: (tool) => {
          registered.push(tool);
          return {
            active_tool: true,
            activation: "current_session",
            callable_now: true,
            host_registered: true,
          };
        },
        reservedToolNames: new Set(),
        setActiveTools: () => undefined,
      },
    );
    assert.deepEqual(registration.details.args, [
      "command",
      "source",
      "loop",
      "volume",
    ]);
    assert.deepEqual(
      {
        active_tool: registration.details.active_tool,
        activation: registration.details.activation,
        callable_now: registration.details.callable_now,
        host_registered: registration.details.host_registered,
        persisted: registration.details.persisted,
        registry_active: registration.details.registry_active,
        resolved: registration.details.resolved,
        validated: registration.details.validated,
      },
      {
        active_tool: true,
        activation: "current_session",
        callable_now: true,
        host_registered: true,
        persisted: true,
        registry_active: true,
        resolved: true,
        validated: true,
      },
    );
    const wrapperPath = join(recipeRoot, "music_player.json");
    const authoredWrapper = JSON.parse(await readFile(wrapperPath, "utf8"));
    assert.deepEqual(authoredWrapper.template, {
      template: "media/player",
    });
    assert.equal(authoredWrapper.async, undefined);
    assert.deepEqual(authoredWrapper.args, ["source:path"]);
    assert.deepEqual(authoredWrapper.defaults, {
      source: "~/Music/1MIX",
    });
    const candidateAdmission = admitUserRecipe(
      wrapperPath,
      recipeResolutionContext,
      authoredWrapper,
    );
    const persistedAdmission = admitUserRecipe(
      wrapperPath,
      recipeResolutionContext,
    );
    assert.equal(candidateAdmission.validated, true);
    assert.deepEqual(candidateAdmission.tool, persistedAdmission.tool);

    const effective = readResolvedRecipeConfig(wrapperPath, [], { skillContext });
    assert.equal(effective?.async, true);
    assert.deepEqual(effective?.args, playerRecipe.args);
    assert.deepEqual(effective?.control, playerRecipe.control);

    const discovered = discoverRecipeSources([
      {
        root: recipeRoot,
        defaultTool: true,
        mutableUsage: true,
        resolutionContext: recipeResolutionContext,
      },
    ]);
    const discoveredWrapper = discovered.active.get("music_player")!;
    const discoveredTool = toRegisteredTool(discoveredWrapper)!;
    assert.equal(discoveredWrapper.invalid, false);
    assert.deepEqual(discoveredTool.args, registration.details.args);
    assert.deepEqual(discoveredTool.argTypes, registered[0].argTypes);
    assert.equal(discoveredTool.recipe?.async, true);
    assert.deepEqual(discoveredTool.recipe?.control, playerRecipe.control);
    const toolDefinition = createRuntimeToolDefinition(
      discoveredTool,
      async () => ({ code: 0, killed: false, stderr: "", stdout: "" }),
    );
    const inspectedTool = await createInspectToolDefinition({
      getTool: (name) => (name === "music_player" ? toolDefinition : undefined),
    }).execute(
      "inspect-music-player",
      { target: "tool:music_player", view: "schema" },
      undefined,
      undefined,
      {},
    );
    const properties = inspectedTool.details.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(Object.keys(properties).sort(), [
      "command",
      "loop",
      "run_id",
      "source",
      "transport_context",
      "volume",
    ]);
    assert.deepEqual(properties.command.enum, ["play", "pause", "status"]);
    assert.equal(properties.source.type, "string");
    assert.equal(properties.loop.type, "boolean");
    assert.equal(properties.volume.type, "integer");
    assert.equal(properties.state_dir, undefined);
    assert.equal(properties.skill_dir, undefined);
    const wrapperSpawn = await createSpawnToolDefinition().execute(
      "registration-truth-wrapper-spawn",
      {
        as: `run:${wrapperRunId}`,
        file: wrapperPath,
        values: { command: "status" },
      },
      undefined,
      undefined,
      { recipeResolutionContext, cwd: root },
    );
    const toolInvocation = await toolDefinition.execute(
      "registration-truth-tool-call",
      { command: "status", run_id: toolRunId },
      undefined,
      undefined,
      {
        cwd: root,
        recipeResolutionContext,
        sessionManager: { getSessionId: () => "registration-truth-session" },
      },
    );
    assert.equal(wrapperSpawn.details.launch_kind, "spawn");
    assert.equal(toolInvocation.details.launch_kind, "tool");
    const usage = readRecipeUsage(wrapperPath);
    assert.equal(usage?.launch_kind, "tool");
    assert.equal(usage?.tool_calls, 1);
    await assert.rejects(
      executeRegisterTool(
        {
          description: "Missing delegated capability",
          name: "missing_tool",
          template: "missing/task",
        },
        { recipeResolutionContext },
        {
          configPath: join(root, "registry.json"),
          recipeRoot,
          getActiveTools: () => [],
          getToolNameBlocker: () => undefined,
          getTools: () => tools,
          notify: () => undefined,
          registerRuntimeTool: (tool) => {
            registered.push(tool);
          },
          reservedToolNames: new Set(),
          setActiveTools: () => undefined,
        },
      ),
      /Active Skill Recipe not found: missing\/task/,
    );
    await assert.rejects(
      readFile(join(recipeRoot, "missing_tool.json"), "utf8"),
    );

    const inventory = inventoryActiveSkillRecipeComponents(skillContext);
    assert.equal(inventory.partial, true);
    assert.equal(
      inventory.components.some((component) => component.identity === "media/player"),
      true,
    );
    assert.match(inventory.rejected[0].reason, /Recipe\.name was removed/);
    assert.equal(
      readResolvedRecipeConfig(join(mediaDir, "recipes", "player.json"), [], {
        skillContext,
      })?.async,
      true,
    );
    assert.equal(registered.length, 1);
  } finally {
    await rm(runStateDir, { recursive: true, force: true });
    await rm(join(getRunStateRoot(), wrapperRunId), {
      recursive: true,
      force: true,
    });
    await rm(join(getRunStateRoot(), toolRunId), {
      recursive: true,
      force: true,
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("registration truth rejects inactive, malformed, mistyped, and ambiguous wrappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-registration-negative-"));
  try {
    const firstMedia = await writeSkillRecipe(
      join(root, "first-skills"),
      "media",
      "player",
      playerRecipe,
    );
    const secondMedia = await writeSkillRecipe(
      join(root, "second-skills"),
      "media",
      "player",
      playerRecipe,
    );
    const wrapperPath = join(root, "recipes", "music_player.json");
    const wrapper = {
      description: "Music wrapper",
      template: "media/player",
    };
    const inactive = admitUserRecipe(
      wrapperPath,
      createRecipeResolutionContext(
        "inactive-session",
        root,
        createActiveSkillRecipeContext([]),
      ),
      wrapper,
    );
    assert.equal(inactive.validated, false);
    assert.match(inactive.diagnostics[0], /Active Skill Recipe not found/);

    const liveContext = createRecipeResolutionContext(
      "live-session",
      root,
      createActiveSkillRecipeContext([{ name: "media", baseDir: firstMedia }]),
    );
    const malformed = admitUserRecipe(wrapperPath, liveContext, {
      description: "Malformed wrapper",
      template: 42,
    });
    assert.equal(malformed.validated, false);
    assert.match(malformed.diagnostics[0], /template/i);
    const mistyped = admitUserRecipe(wrapperPath, liveContext, {
      description: "Mistyped wrapper",
      defaults: { volume: "loud" },
      template: "media/player",
    });
    assert.equal(mistyped.validated, false);
    assert.match(mistyped.diagnostics[0], /volume.*integer/i);

    const ambiguous = admitUserRecipe(
      wrapperPath,
      createRecipeResolutionContext(
        "ambiguous-session",
        root,
        createActiveSkillRecipeContext([
          { name: "media", baseDir: firstMedia },
          { name: "media", baseDir: secondMedia },
        ]),
      ),
      wrapper,
    );
    assert.equal(ambiguous.validated, false);
    assert.match(ambiguous.diagnostics[0], /Duplicate active Skill identity media/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "registration truth watcher admits a repaired delegated wrapper",
  {
    skip:
      process.platform === "win32"
        ? "Node's Windows fs watcher asserts when its watched directory is removed"
        : process.platform === "darwin"
          ? "macOS fs watcher delivery is nondeterministic"
          : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-registration-watch-"));
    const recipeRoot = join(root, "recipes");
    let watcher: ReturnType<typeof createRecipeToolReloadWatcher> | undefined;
    try {
      const mediaDir = await writeSkillRecipe(
        join(root, "skills"),
        "media",
        "player",
        playerRecipe,
      );
      await mkdir(recipeRoot, { recursive: true });
      const wrapperPath = join(recipeRoot, "music_player.json");
      await writeFile(
        wrapperPath,
        JSON.stringify({
          description: "Broken wrapper",
          name: "removed-identity",
          template: "media/player",
        }),
      );
      const resolutionContext = createRecipeResolutionContext(
        "watch-session",
        root,
        createActiveSkillRecipeContext([{ name: "media", baseDir: mediaDir }]),
      );
      const definitions = new Map<string, { name: string }>();
      let activeTools: string[] = [];
      const runtime = createAutoToolsRuntime({
        configPath: join(root, "registry.json"),
        exec: async () => ({ code: 0, killed: false, stderr: "", stdout: "" }),
        getActiveTools: () => activeTools,
        getAllTools: () => [...definitions.values()],
        recipeRoot,
        registerTool: (definition) => definitions.set(definition.name, definition),
        reservedToolNames: new Set(),
        setActiveTools: (names) => {
          activeTools = names;
        },
      });
      const ctx = { hasUI: false, ui: { notify() {} } };
      runtime.loadTools(ctx, resolutionContext);
      assert.equal(runtime.getTools().has("music_player"), false);
      watcher = createRecipeToolReloadWatcher(runtime, {
        getResolutionContext: () => resolutionContext,
        recipeRoot,
      });
      watcher.watch(ctx);
      await writeFile(
        wrapperPath,
        JSON.stringify({
          description: "Repaired wrapper",
          defaults: { source: "~/Music/1MIX" },
          template: "media/player",
        }),
      );
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (runtime.getTools().has("music_player")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(runtime.getTools().has("music_player"), true);
      assert.equal(runtime.getToolStatus("music_player")?.callable_now, true);
      assert.equal(runtime.getStatus().resolution_generation, resolutionContext.generation);
    } finally {
      watcher?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
