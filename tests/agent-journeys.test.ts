import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandTemplateExecResult } from "../lib/command-templates.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import {
  createRecipeResolutionContext,
} from "../lib/recipes-context.ts";
import {
  createActiveSkillRecipeContext,
  inventoryActiveSkillRecipeComponents,
} from "../lib/recipes-references.ts";
import { executeRegisterTool } from "../lib/registry.ts";
import { createAutoToolsRuntime } from "../lib/runtime.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";
import { bindFixtureBirth, captureFixtureBirths, joinFixtureRunners, requireFreshFixtureAbsence, throwFixtureErrors, type FixtureBirth } from "./fixtures/runner-completion.ts";

const exec = async (): Promise<CommandTemplateExecResult> => ({
  code: 0,
  killed: false,
  stderr: "",
  stdout: "ok",
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function journeyFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-agent-journey-"));
  const media = join(root, "skills", "music-player");
  const stale = join(root, "skills", "stale");
  const recipeRoot = join(root, "recipes");
  await mkdir(join(media, "recipes"), { recursive: true });
  await mkdir(join(stale, "recipes"), { recursive: true });
  await mkdir(recipeRoot, { recursive: true });
  await writeFile(join(media, "SKILL.md"), "---\nname: music-player\ndescription: Use for media.\n---\n");
  await writeFile(join(stale, "SKILL.md"), "---\nname: stale\ndescription: Stale fixture.\n---\n");
  await writeFile(
    join(media, "recipes", "playback.json"),
    JSON.stringify({
      async: true,
      args: [
        "command:enum(play,status)",
        "source:path",
        "state_dir:path",
      ],
      control: ["play", "status"],
      defaults: { command: "play" },
      description: "Maintained media player fixture.",
      template: `${process.execPath} -e "console.log('media-ready')"`,
    }),
  );
  const stalePath = join(stale, "recipes", "broken.json");
  await writeFile(
    stalePath,
    JSON.stringify({ name: "removed", template: "echo stale" }),
  );
  const skillContext = createActiveSkillRecipeContext([
    { name: "music-player", baseDir: media },
    { name: "stale", baseDir: stale },
  ]);
  return {
    context: createRecipeResolutionContext("agent-journey", root, skillContext),
    media,
    recipeRoot,
    root,
    skillContext,
    stalePath,
  };
}

test("Agent Journeys A-D preserve one-off, persistent, degraded, and unavailable paths", async () => {
  const fixture = await journeyFixture();
  const oneOffRun = `journey-one-off-${process.pid}-${Date.now()}`;
  const toolRun = `journey-tool-${process.pid}-${Date.now()}`;
  const oneOffState = join(getRunStateRoot(), oneOffRun);
  const toolState = join(getRunStateRoot(), toolRun);
  try {
    // Journey A: the maintained capability is spawned once; no persistent tool appears.
    const spawn = createSpawnToolDefinition();
    const oneOff = await spawn.execute(
      "journey-a",
      {
        as: `run:${oneOffRun}`,
        recipe: "music-player/playback",
        values: { command: "status", source: "~/Music/1MIX" },
      },
      undefined,
      undefined,
      { cwd: fixture.root, recipeResolutionContext: fixture.context },
    );
    assert.equal(oneOff.details.launch_kind, "spawn");
    assert.equal(
      oneOff.details.recipe_file,
      join(fixture.media, "recipes", "playback.json"),
    );
    assert.deepEqual(await readdir(fixture.recipeRoot), []);
    await waitForFile(join(oneOffState, "result.json"));

    // Journeys B and C: exact valid resolution survives unrelated catalog damage,
    // registration activates the compact specialization, and the generated tool is called.
    const inventory = inventoryActiveSkillRecipeComponents(fixture.skillContext);
    assert.equal(inventory.partial, true);
    assert.equal(
      inventory.components.some((component) => component.identity === "music-player/playback"),
      true,
    );
    const staleBefore = await readFile(fixture.stalePath, "utf8");
    const definitions = new Map<string, any>();
    let activeTools: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(fixture.root, "tool-registry.json"),
      exec,
      getActiveTools: () => activeTools,
      getAllTools: () => [...definitions.values()],
      recipeRoot: fixture.recipeRoot,
      registerTool: (definition) => definitions.set(definition.name, definition),
      reservedToolNames: new Set(),
      setActiveTools: (names) => {
        activeTools = [...names];
      },
    });
    const registration = await executeRegisterTool(
      {
        defaults: { source: "~/Music/1MIX" },
        from: "music-player/playback",
        name: "music_player",
      },
      { recipeResolutionContext: fixture.context },
      {
        configPath: join(fixture.root, "tool-registry.json"),
        getActiveTools: () => activeTools,
        getToolNameBlocker: runtime.getToolNameBlocker,
        getTools: runtime.getTools,
        notify: () => undefined,
        recipeRoot: fixture.recipeRoot,
        registerRuntimeTool: runtime.registerRuntimeTool,
        reservedToolNames: new Set(),
        setActiveTools: (names) => {
          activeTools = [...names];
        },
      },
    );
    assert.equal(registration.details.source, "music-player/playback");
    assert.equal(registration.details.callable_now, true);
    assert.deepEqual(registration.details.next_actions?.[0], "call tool music_player");
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.recipeRoot, "music_player.json"), "utf8")),
      { defaults: { source: "~/Music/1MIX" }, template: "music-player/playback" },
    );
    const musicPlayer = definitions.get("music_player");
    assert.ok(musicPlayer);
    const invocation = await musicPlayer.execute(
      "journey-b-tool-call",
      { command: "status", run_id: toolRun },
      undefined,
      undefined,
      { cwd: fixture.root },
    );
    assert.equal(invocation.details.launch_kind, "tool");
    await waitForFile(join(toolState, "result.json"));
    assert.equal(runtime.getToolStatus("music_player")?.tool_calls, 1);
    assert.equal(await readFile(fixture.stalePath, "utf8"), staleBefore);

    // Journey D: inactive ownership stops at a focused public diagnostic.
    const inactive = createRecipeResolutionContext(
      "agent-journey-inactive",
      fixture.root,
      createActiveSkillRecipeContext([]),
    );
    await assert.rejects(
      spawn.execute(
        "journey-d",
        { recipe: "music-player/playback", values: { source: "~/Music/1MIX" } },
        undefined,
        undefined,
        { cwd: fixture.root, recipeResolutionContext: inactive },
      ),
      /Owning Skill "music-player" is not active.*Next: activate Skill music-player.*actors_inspect target=recipes view=doctor identity=music-player\/playback/s,
    );
    await assert.rejects(
      executeRegisterTool(
        { from: "music-player/playback", name: "inactive_player" },
        { recipeResolutionContext: inactive },
        {
          configPath: join(fixture.root, "tool-registry.json"),
          getActiveTools: () => activeTools,
          getToolNameBlocker: runtime.getToolNameBlocker,
          getTools: runtime.getTools,
          notify: () => undefined,
          recipeRoot: fixture.recipeRoot,
          registerRuntimeTool: runtime.registerRuntimeTool,
          reservedToolNames: new Set(),
          setActiveTools: (names) => {
            activeTools = [...names];
          },
        },
      ),
      /music-player\/playback.*validation failed.*Owning Skill \\"music-player\\" is not active.*instruction: "actors_inspect target=recipes view=doctor identity=music-player\/playback/s,
    );
    assert.equal(existsSync(join(fixture.recipeRoot, "inactive_playback.json")), false);
  } finally {
    await rm(oneOffState, { force: true, recursive: true });
    await rm(toolState, { force: true, recursive: true });
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("Retained agent journey saves, discovers, spawns, exposes and withdraws without erasing the source", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retained-journey-"));
  const recipeRoot = join(root, "recipes"), definitions = new Map<string, any>();
  const capture = captureFixtureBirths(t), entries: { birth: FixtureBirth; path: string }[] = [];
  const errors: unknown[] = [], states: string[] = [];
  let active: string[] = [];
  // Foreground execution uses the existing fake port; detached paths join actual runner births and close.
  const runtime = createAutoToolsRuntime({ configPath: join(root, "config.json"), recipeRoot, exec,
    reservedToolNames: new Set(), getActiveTools: () => active, getAllTools: () => [...definitions.values()],
    setActiveTools: names => { active = names; }, registerTool: definition => definitions.set(definition.name, definition) });
  const deps = { configPath: join(root, "config.json"), recipeRoot, getTools: runtime.getTools,
    getToolNameBlocker: runtime.getToolNameBlocker, getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; }, reservedToolNames: new Set<string>(),
    registerRuntimeTool: runtime.registerRuntimeTool, notify: () => undefined };
  const context = { cwd: root, sessionManager: { getSessionId: () => "retained-journey" } };
  const inspect = createInspectToolDefinition({ recipeRoot }), spawn = createSpawnToolDefinition();
  const retainRun = (meta: Record<string, any>) => {
    states.push(meta.state_dir);
    entries.push({ birth: bindFixtureBirth(capture.births, meta.pid), path: join(meta.state_dir, "result.json") });
  };
  try {
    for (const async of [false, true]) {
      const name = async ? "retained_async" : "retained_sync";
      const saved = await executeRegisterTool({ name, description: "Retained journey", async, expose: false,
        template: `${JSON.stringify(process.execPath)} -e "console.log('retained-result')"` }, context, deps);
      const path = saved.details.recipe!, before = await readFile(path, "utf8");
      assert.equal(definitions.has(name), false);
      assert.equal(active.includes(name), false);
      const inventory = await inspect.execute("retained-inventory", { target: "recipes", view: "summary" }, undefined, undefined, context);
      assert.equal(inventory.details.retained.find((row: Record<string, unknown>) => row.id === name).path, path);
      const reuse = await spawn.execute("retained-reuse", { recipe: path, as: `run:retained-reuse-${process.pid}-${name}` }, undefined, undefined, context);
      retainRun(reuse.details);
      assert.equal(reuse.details.launch_kind, "spawn");
      const exposed = await executeRegisterTool({ name, from: path }, context, deps);
      assert.equal(exposed.details.callable_now, true);
      assert.deepEqual(JSON.parse(await readFile(join(recipeRoot, name + ".json"), "utf8")), { template: path });
      const call = await definitions.get(name).execute("retained-tool", async ? { run_id: `retained-tool-${process.pid}` } : {}, undefined, undefined, context);
      if (async) retainRun(call.details);
      assert.equal(call.details.launch_kind, "tool");
      await executeRegisterTool({ name, template: null }, context, deps);
      assert.equal(active.includes(name), false);
      assert.equal(runtime.getTools().has(name), false);
      assert.equal(await readFile(path, "utf8"), before);
    }
  } catch (error) { errors.push(error); }
  finally {
    let settled = false;
    try {
      assert.equal(entries.length, capture.births.length, "Unbound runner; retain fixture roots");
      await joinFixtureRunners(entries);
      for (const { birth } of entries) requireFreshFixtureAbsence(birth);
      settled = true;
    } catch (error) { errors.push(error); }
    try { capture.restore(); } catch (error) { errors.push(error); }
    if (settled) {
      try {
        for (const { birth } of entries) requireFreshFixtureAbsence(birth);
        for (const state of states) await rm(state, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      } catch (error) { errors.push(error); }
    }
  }
  throwFixtureErrors(errors);
});

test("Capability memory guidance separates execution, retention and exposure without advertising future operations", () => {
  const actors = readFileSync("skills/actors/SKILL.md", "utf8");
  const persistent = readFileSync("skills/actors/references/persistent-tools.md", "utf8");
  const memory = readFileSync("skills/recipe-memory/SKILL.md", "utf8");
  assert.match(actors, /Sync\/async is an execution contract, not a usefulness or tool-exposure rule/);
  assert.match(persistent, /Both sync and async Recipes can be tools/);
  assert.match(persistent, /async invocation returns a launch receipt and the eventual result arrives separately/);
  assert.match(persistent, /Synchronous tools execute inline; non-singleton async calls launch Run executions, while singleton attachment follows its existing compatibility contract/);
  assert.match(actors, /subagent-backed tool is a capability launcher, not a persisted live subagent/);
  for (const guidance of [actors, persistent, memory]) {
    assert.match(guidance, /Automatic retained lifecycle is not implemented/);
  }
  assert.match(persistent, /do not invent review actions or bypass unsupported retained mutations/);
  assert.match(persistent, /`kind: retained_recipe`, `activation: not_requested` receipt/);
  assert.match(actors, /When tool exposure was requested, stop if registration persists but is not callable/);
  assert.match(persistent, /Read-only `actors_inspect target=recipes view=summary` reports retained counts/);
  assert.match(persistent, /A stored definition is not review, activation or Run evidence/);
  assert.match(persistent, /Existing explicit `actors_tool_register` works for both modes/);
  assert.match(memory, /Structural evidence and launch counts alone do not establish semantic purpose/);
  assert.match(memory, /Current draft promote\/discard and tool-review behavior are unchanged/);
  assert.match(memory, /Do not bypass confidentiality or edit review state/);
});

test("Music Player routes Telegram control intent to its maintained Generative App", () => {
  const music = readFileSync("skills/music-player/SKILL.md", "utf8");

  assert.match(
    music,
    /Telegram-originated turn.*prefer the maintained Telegram view.*one-shot prompt buttons/s,
  );
  assert.match(
    music,
    /`telegram_bind` is available.*operating guidance that owns Generative Apps.*capability-owned adapter/s,
  );
  assert.match(music, /do not re-author it or move playback authority into the view/);
});

test("Agent Journeys E-G route multi-actor, project, and artifact intent to owning Skills", () => {
  const prompt = readFileSync("lib/prompts.ts", "utf8");
  const actors = readFileSync("skills/actors/SKILL.md", "utf8");
  const swarm = readFileSync("skills/swarm/SKILL.md", "utf8");
  const project = readFileSync("skills/project-work/SKILL.md", "utf8");
  const artifacts = readFileSync("skills/artifacts/SKILL.md", "utf8");

  assert.match(prompt, /multiple actors or subagents.*swarm Skill/s);
  assert.match(actors, /Coordinate several independent actors or subagents.*read the swarm Skill/s);
  assert.match(swarm, /Read `actors` first for generic Recipe, spawn, Run, Trace, Control, artifact, and lifecycle operation/);
  assert.match(swarm, /swarm\/lens-review/);
  assert.doesNotMatch(swarm, /room:|task tree|task-tree/i);
  assert.match(swarm, /Coordinator checkpoints are bounded decision requests, not free-form actor chat/);

  assert.match(project, /project-work\/repo-health/);
  assert.match(project, /project-work\/release-readiness/);
  assert.match(project, /Readiness only; does not publish/);

  assert.match(artifacts, /Desired outcome/);
  assert.match(artifacts, /artifacts\/bundle/);
  assert.match(artifacts, /without committing a filesystem write.*artifacts\/report/s);
  assert.match(artifacts, /artifacts\/write.*Declared artifact path written/s);
});
