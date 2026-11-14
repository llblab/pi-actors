/**
 * Registration-truth journey regression.
 * Proves the 0.46.0 live-context disagreement remains closed.
 */

import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
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
import { observeFixtureBirth, captureFixtureBirths, bindFixtureBirth, joinFixtureRunners, requireFreshFixtureAbsence, throwFixtureErrors, type FixtureBirth } from "./fixtures/runner-completion.ts";

test("Normalized foreign host collisions refuse registration, update and discovery without migrating saved Recipe identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-tool-names-"));
  const recipeRoot = join(root, "recipes"); await mkdir(recipeRoot);
  const host = new Map<string, { name: string; sourceInfo: { path: string } }>();
  let active: string[] = [];
  const runtime = createAutoToolsRuntime({ configPath: join(root, "config.json"), recipeRoot,
    exec: async () => { throw new Error("No command execution belongs to this admission test"); },
    getAllTools: () => [...host.values()], getActiveTools: () => active,
    setActiveTools: names => { active = names; }, reservedToolNames: new Set(["actors_inspect"]),
    registerTool: definition => { host.set(definition.name, { name: definition.name, sourceInfo: { path: "actors" } }); },
  });
  const ctx = { cwd: root, hasUI: false, ui: { notify() {} } };
  const deps = { configPath: join(root, "config.json"), recipeRoot,
    getRecipeResolutionContext: () => createRecipeResolutionContext("names", root, createActiveSkillRecipeContext([])),
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    getTools: runtime.getTools, getToolNameBlocker: runtime.getToolNameBlocker,
    registerRuntimeTool: runtime.registerRuntimeTool, notify: runtime.notify,
    reservedToolNames: new Set<string>(),
  };
  const definition = JSON.stringify({ description: "Saved identity", template: "echo saved" });
  try {
    for (const [foreign, requested] of [["Audio-Transcribe", "audio_transcribe"], ["audio_transcribe", "Audio Transcribe"], ["x".repeat(65), "x".repeat(64)]]) {
      host.clear(); host.set(foreign, { name: foreign, sourceInfo: { path: "foreign-extension" } });
      assert.match(runtime.getToolNameBlocker(requested)!, /Host tool name collision/);
      for (const update of [false, true]) await assert.rejects(async () => executeRegisterTool({ name: requested, update,
        description: "Refused", template: "echo refused" }, ctx, deps), /Host tool name collision/);
      assert.deepEqual(await import("node:fs/promises").then(fs => fs.readdir(recipeRoot)), []);
      assert.deepEqual(active, []); assert.equal(host.size, 1);
    }
    host.clear(); host.set("Audio-Transcribe", { name: "Audio-Transcribe", sourceInfo: { path: "foreign-extension" } });
    const path = join(recipeRoot, "audio_transcribe.json"); await writeFile(path, definition);
    runtime.loadTools(ctx, deps.getRecipeResolutionContext());
    assert.equal(runtime.getTools().has("audio_transcribe"), false); assert.equal(runtime.getToolStatus("audio_transcribe"), undefined);
    assert.equal(await readFile(path, "utf8"), definition); assert.deepEqual(active, []);
    assert.match(runtime.getToolNameBlocker("Actors Inspect")!, /Reserved/);
    host.clear(); await writeFile(join(recipeRoot, "legacy.json"), definition);
    runtime.loadTools(ctx, deps.getRecipeResolutionContext());
    assert.equal(runtime.getToolStatus("legacy")?.callable_now, true);
    runtime.loadTools(ctx, deps.getRecipeResolutionContext()); // Owned registrations are not foreign collisions on reload.
    assert.equal(runtime.getToolStatus("legacy")?.callable_now, true);
    host.set("legacy", { name: "legacy", sourceInfo: { path: "replacement-extension" } });
    assert.match(runtime.getToolNameBlocker("legacy")!, /Host tool name collision/);
    assert.equal(runtime.getToolStatus("legacy"), undefined);
    assert.equal(await readFile(join(recipeRoot, "legacy.json"), "utf8"), definition);
    await assert.rejects(async () => executeRegisterTool({ name: "legacy", template: null }, ctx, deps), /Host tool name collision/);
    assert.equal(await readFile(join(recipeRoot, "legacy.json"), "utf8"), definition);
    await rm(join(recipeRoot, "legacy.json"));
    runtime.loadTools(ctx, deps.getRecipeResolutionContext());
    assert.equal((active as string[]).includes("legacy"), true, "Removing an old Recipe must not deactivate the foreign replacement");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained host declarations allow Recipe restoration after discovery loss but never foreign replacement", async () => {
  for (const loss of ["delete", "remove", "disable", "invalidate"] as const) {
    for (const replacement of ["owned", "foreign_exact", "foreign_normalized"] as const) {
      const root = await mkdtemp(join(tmpdir(), "pi-actors-tool-restoration-"));
      const recipeRoot = join(root, "recipes"); await mkdir(recipeRoot);
      const host = new Map<string, { name: string; sourceInfo: { path: string } }>();
      let active: string[] = [], registrations = 0;
      const runtime = createAutoToolsRuntime({ configPath: join(root, "config.json"), recipeRoot,
        exec: async () => { throw new Error("Restoration must not execute work"); },
        getAllTools: () => [...host.values()], getActiveTools: () => active,
        setActiveTools: names => { active = names; }, reservedToolNames: new Set(),
        registerTool: definition => {
          registrations++;
          host.set(definition.name, { name: definition.name, sourceInfo: { path: "actors" } });
        },
      });
      const ctx = { cwd: root, hasUI: false, ui: { notify() {} } };
      const deps = { configPath: join(root, "config.json"), recipeRoot,
        getRecipeResolutionContext: () => createRecipeResolutionContext("restoration", root, createActiveSkillRecipeContext([])),
        getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
        getTools: runtime.getTools, getToolNameBlocker: runtime.getToolNameBlocker,
        registerRuntimeTool: runtime.registerRuntimeTool, notify: runtime.notify,
        reservedToolNames: new Set<string>(),
      };
      const path = join(recipeRoot, "legacy.json");
      const saved = { description: "Saved logical identity", template: "echo saved" };
      const scan = () => runtime.loadTools(ctx, deps.getRecipeResolutionContext());
      try {
        await executeRegisterTool({ name: "legacy", ...saved }, ctx, deps);
        const bytes = await readFile(path, "utf8");
        assert.equal(runtime.getToolStatus("legacy")?.callable_now, true);
        if (loss === "delete") await executeRegisterTool({ name: "legacy", template: null }, ctx, deps);
        else if (loss === "remove") await rm(path);
        else await writeFile(path, loss === "disable" ? JSON.stringify({ ...saved, disabled: true }) : "{");
        scan(); scan();
        assert.equal(runtime.getToolStatus("legacy"), undefined, loss);
        assert.deepEqual(active, [], loss);
        assert.equal(host.has("legacy"), true, "Deactivation is not complete host unregister");
        assert.equal(runtime.getToolNameBlocker("legacy"), undefined, "Own inactive declaration retains provenance");
        if (replacement !== "owned") {
          host.clear();
          const name = replacement === "foreign_exact" ? "legacy" : "Legacy";
          host.set(name, { name, sourceInfo: { path: "foreign-extension" } });
          assert.match(runtime.getToolNameBlocker("legacy")!, /Host tool name collision/);
          for (const update of [false, true]) await assert.rejects(
            executeRegisterTool({ name: "legacy", update, ...saved }, ctx, deps), /Host tool name collision/);
        }
        if (loss === "delete" && replacement === "owned") {
          await executeRegisterTool({ name: "legacy", ...saved }, ctx, deps);
        } else await writeFile(path, bytes);
        scan(); scan();
        assert.equal(await readFile(path, "utf8"), bytes, "Saved name and definition remain exact");
        if (replacement === "owned") {
          assert.equal(registrations, 2, "Restoration refreshes the declaration once");
          assert.equal(runtime.getToolStatus("legacy")?.activation, "current_session");
          assert.equal(runtime.getToolStatus("legacy")?.callable_now, true);
          assert.deepEqual(active, ["legacy"]);
          active = [];
          assert.equal(runtime.getToolStatus("legacy")?.callable_now, false, "Ownership is not activation proof");
        } else {
          assert.equal(registrations, 1, "Foreign replacement must not be overwritten");
          assert.equal(runtime.getToolStatus("legacy"), undefined);
          assert.equal(runtime.getTools().has("legacy"), false);
          assert.deepEqual(active, [], "Inactive foreign declarations still block restoration");
          const foreign = [...host.keys()][0]; active = [foreign];
          await rm(path); scan();
          assert.deepEqual(active, [foreign], "Discovery loss must not deactivate a foreign replacement");
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});

const playerRecipe = {
  async: true,
  description: "Control local music.",
  args: [
    "command:enum(play,pause,status)",
    "source:path",
    "loop:bool",
    "volume:int",
    "state_dir:path",
  ],
  defaults: { command: "play", loop: "true", volume: "70" },
  control: ["play", "pause", "status"],
  template: `${JSON.stringify(process.execPath)} -e "console.log(process.argv.slice(1).join(' '))" {skill_dir} {command} {source} {loop} {volume} {state_dir}`,
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

test("0.46.1 registration truth journey closes the live Skill-wrapper contradiction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-registration-truth-"));
  const timingModule = "./fixtures/windows-native-timing.mjs";
  const { enrollTiming, markTiming } = await import(timingModule);
  const timing = enrollTiming(root, "registration", true);
  const errors: unknown[] = [];
  const capture = captureFixtureBirths(t);
  const joins: { birth: FixtureBirth; path: string }[] = [];
  const runId = `registration-truth-${process.pid}-${Date.now()}`;
  const wrapperRunId = `${runId}-wrapper`;
  const toolRunId = `${runId}-tool`;
  const runStateDir = join(getRunStateRoot(), runId);
  let dispatchEntered = false, cleanupProven = false;
  try {
    markTiming("registration_launch");
    const skillsRoot = join(root, "skills");
    const recipeRoot = join(root, "user-recipes");
    const mediaDir = await writeSkillRecipe(
      skillsRoot,
      "music-player",
      "playback",
      playerRecipe,
    );
    const staleDir = await writeSkillRecipe(skillsRoot, "stale", "broken", {
      name: "removed-identity",
      template: "echo broken",
    });
    const skillContext = createActiveSkillRecipeContext([
      { name: "music-player", baseDir: mediaDir },
      { name: "stale", baseDir: staleDir },
    ]);
    const qa = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "skills", "actors", "scripts", "validate-recipe.mjs"),
        join(mediaDir, "recipes", "playback.json"),
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
    dispatchEntered = true;
    const spawnResult = await createSpawnToolDefinition().execute(
      "registration-truth-spawn",
      {
        as: `run:${runId}`,
        recipe: "music-player/playback",
        values: { source: "fixture-library" },
      },
      undefined,
      undefined,
      { recipeResolutionContext, cwd: root },
    );
    joins.push({ birth: bindFixtureBirth(capture.births, spawnResult.details.pid), path: join(runStateDir, "result.json") });
    assert.equal(spawnResult.details.recipe_file, join(mediaDir, "recipes", "playback.json"));
    const tools = new Map<string, RegisteredTool>();
    const registered: RegisteredTool[] = [];
    const registration = await executeRegisterTool(
      {
        defaults: { source: "~/Music/1MIX" },
        from: "music-player/playback",
        name: "music_player",
      },
      {},
      {
        configPath: join(root, "registry.json"),
        recipeRoot,
        getActiveTools: () => [],
        getToolNameBlocker: () => undefined,
        getTools: () => tools,
        getRecipeResolutionContext: () => recipeResolutionContext,
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
    assert.equal(registration.details.source, "music-player/playback");
    assert.equal(registration.details.activation_boundary, "current_session");
    assert.deepEqual(registration.details.required_args, []);
    assert.deepEqual(registration.details.optional_args, [
      "command",
      "source",
      "loop",
      "volume",
      "run_id",
      "transport_context",
    ]);
    assert.deepEqual(registration.details.next_actions, [
      "call tool music_player",
      "actors_inspect target=tool:music_player view=status",
    ]);
    assert.equal("config" in registration.details, false);
    assert.equal("template" in registration.details, false);
    const wrapperPath = join(recipeRoot, "music_player.json");
    const authoredWrapper = JSON.parse(await readFile(wrapperPath, "utf8"));
    assert.equal(authoredWrapper.template, "music-player/playback");
    assert.equal(authoredWrapper.description, undefined);
    assert.equal(authoredWrapper.async, undefined);
    assert.equal(authoredWrapper.args, undefined);
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
    assert.equal(discoveredTool.description, playerRecipe.description);
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
    joins.push({ birth: bindFixtureBirth(capture.births, wrapperSpawn.details.pid), path: join(getRunStateRoot(), wrapperRunId, "result.json") });
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
    joins.push({ birth: bindFixtureBirth(capture.births, toolInvocation.details.pid), path: join(getRunStateRoot(), toolRunId, "result.json") });
    assert.equal(capture.births.length, 3);
    assert.equal(new Set(joins.map(({ birth }) => birth)).size, 3);
    assert.equal(wrapperSpawn.details.launch_kind, "spawn");
    assert.equal(toolInvocation.details.launch_kind, "tool");
    const usage = readRecipeUsage(wrapperPath);
    assert.equal(usage?.launch_kind, "tool");
    assert.equal(usage?.tool_calls, 1);
    await assert.rejects(
      executeRegisterTool(
        {
          from: "missing/task",
          name: "missing_tool",
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
      /missing\/task.*validation failed.*diagnostics_summary: "Active Skill Recipe not found: missing\/task.*active_skills_summary: "music-player, stale".*instruction: "actors_inspect target=recipes view=doctor identity=missing\/task/s,
    );
    await assert.rejects(
      readFile(join(recipeRoot, "missing_tool.json"), "utf8"),
    );

    const inventory = inventoryActiveSkillRecipeComponents(skillContext);
    assert.equal(inventory.partial, true);
    assert.equal(
      inventory.components.some((component) => component.identity === "music-player/playback"),
      true,
    );
    assert.match(inventory.rejected[0].reason, /Recipe\.name was removed/);
    assert.equal(
      readResolvedRecipeConfig(join(mediaDir, "recipes", "playback.json"), [], {
        skillContext,
      })?.async,
      true,
    );
    assert.equal(registered.length, 1);
  } catch (error) { errors.push(error); }
  finally {
    // Birth-time listeners record close during the independent journey. All joins
    // now share one deliberately amended 10s acceptance-phase watchdog.
    try { markTiming("result_wait"); } catch (error) { errors.push(error); }
    try { await joinFixtureRunners(joins); cleanupProven = joins.length === 3; } catch (error) { errors.push(error); }
    try { capture.restore(); } catch (error) { errors.push(error); }
    try { timing.finish(); } catch (error) { errors.push(error); }
    if (errors.length === 0 && (!dispatchEntered || cleanupProven)) {
      try {
        const stateDirs = [runStateDir, join(getRunStateRoot(), wrapperRunId), join(getRunStateRoot(), toolRunId)];
        for (const [index, { birth }] of joins.entries()) {
          requireFreshFixtureAbsence(birth);
          await rm(stateDirs[index], { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        }
        for (const { birth } of joins) requireFreshFixtureAbsence(birth);
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (error) { errors.push(error); }
    }
  }
  throwFixtureErrors(errors);
});

test("Synthetic registration joins preserve launch-order causes, falsy originals and restoration after failure", async (t) => {
  const originalSpawn = childProcess.spawn;
  const fake = t.mock.method(childProcess, "spawn", () => Object.assign(new EventEmitter(), { pid: 321 }) as unknown as childProcess.ChildProcess);
  syncBuiltinESMExports();
  const capture = captureFixtureBirths(t);
  const later = new Error("third result invalid"), restoration = new Error("restoration fault");
  const causes: unknown[] = [undefined, 0, later];
  const children = causes.map((_, index) => Object.assign(new EventEmitter(), { pid: 100 + index }));
  const entries = children.map((child, index) => ({ birth: observeFixtureBirth(child), path: String(index) }));
  let expire!: () => void, timers = 0, canceled = 0, retained = true;
  const joined = joinFixtureRunners(entries, {
    async read(path) { throw causes[Number(path)]; },
    liveness: () => "dead",
    watchdog(callback, ms) { timers++; assert.equal(ms, 10_000); expire = callback; return () => { canceled++; }; },
  });
  const errors: unknown[] = [false]; // A falsy original launch/assertion rejection is still primary.
  try {
    // Driver-spawned runners only: exclude unrelated children from capture.
    childProcess.spawn(process.execPath, ["unrelated.mjs"]);
    childProcess.spawn(process.execPath, ["async-runner.mjs"]);
    assert.equal(capture.births.length, 1);
    children[2].emit("close", 0, null); children[0].emit("close", 0, null);
    children[1].emit("close", 0, null);
    try { await joined; retained = false; } catch (error) {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, causes);
      assert.equal(error.cause, undefined);
      errors.push(error);
    }
  } finally {
    try { capture.restore(); } finally { fake.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal(childProcess.spawn, originalSpawn);
  assert.equal(timers, 1); assert.equal(canceled, 1); assert.equal(retained, true);
  assert.equal(typeof expire, "function");
  errors.push(restoration);
  try { throwFixtureErrors(errors); assert.fail("must reject"); } catch (error) {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], false); assert.equal(error.errors[2], restoration);
    assert.equal(error.cause, false);
    assert.equal(Object.getOwnPropertyDescriptor(error, "errors")?.enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable, false);
  }
  let timeout!: () => void, reads = 0;
  const pending = children.map((_, index) => {
    const child = Object.assign(new EventEmitter(), { pid: 200 + index });
    return { birth: observeFixtureBirth(child), path: String(index) };
  });
  const expired = joinFixtureRunners(pending, {
    async read() { reads++; return '{"code":0}'; }, liveness: () => "dead",
    watchdog(callback, ms) { assert.equal(ms, 10_000); timeout = callback; return () => { throw restoration; }; },
  });
  timeout();
  try { await expired; assert.fail("must retain timed-out roots"); } catch (error) {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 4);
    assert.equal(error.errors[3], restoration);
    for (const cause of error.errors.slice(0, 3)) assert.match(cause.message, /watchdog expired/);
  }
  assert.equal(reads, 0); assert.ok(pending.every(({ birth }) => birth.close === undefined));
  for (const original of [undefined, null, false, 0, later]) {
    let caught = false;
    try { throwFixtureErrors([original]); } catch (error) { caught = true; assert.equal(error, original); }
    assert.equal(caught, true);
  }
});

test("registration truth rejects inactive, malformed, mistyped, and ambiguous wrappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-registration-negative-"));
  try {
    const firstMedia = await writeSkillRecipe(
      join(root, "first-skills"),
      "music-player",
      "playback",
      playerRecipe,
    );
    const secondMedia = await writeSkillRecipe(
      join(root, "second-skills"),
      "music-player",
      "playback",
      playerRecipe,
    );
    const wrapperPath = join(root, "recipes", "music_player.json");
    const wrapper = {
      description: "Music wrapper",
      template: "music-player/playback",
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
    assert.match(
      inactive.diagnostics[0],
      /Active Skill Recipe not found: music-player\/playback.*Owning Skill "music-player" is not active.*Next: activate Skill music-player.*actors_inspect target=recipes view=doctor identity=music-player\/playback/s,
    );

    const liveContext = createRecipeResolutionContext(
      "live-session",
      root,
      createActiveSkillRecipeContext([{ name: "music-player", baseDir: firstMedia }]),
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
      template: "music-player/playback",
    });
    assert.equal(mistyped.validated, false);
    assert.match(mistyped.diagnostics[0], /volume.*integer/i);

    const ambiguous = admitUserRecipe(
      wrapperPath,
      createRecipeResolutionContext(
        "ambiguous-session",
        root,
        createActiveSkillRecipeContext([
          { name: "music-player", baseDir: firstMedia },
          { name: "music-player", baseDir: secondMedia },
        ]),
      ),
      wrapper,
    );
    assert.equal(ambiguous.validated, false);
    assert.match(
      ambiguous.diagnostics[0],
      /Duplicate active Skill identity music-player \(2 active definitions\).*Next: actors_inspect target=recipes view=doctor identity=music-player\/playback/s,
    );
    assert.doesNotMatch(ambiguous.diagnostics[0], new RegExp(root));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
        "music-player",
        "playback",
        playerRecipe,
      );
      await mkdir(recipeRoot, { recursive: true });
      const wrapperPath = join(recipeRoot, "music_player.json");
      await writeFile(
        wrapperPath,
        JSON.stringify({
          description: "Broken wrapper",
          name: "removed-identity",
          template: "music-player/playback",
        }),
      );
      const resolutionContext = createRecipeResolutionContext(
        "watch-session",
        root,
        createActiveSkillRecipeContext([{ name: "music-player", baseDir: mediaDir }]),
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
          template: "music-player/playback",
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
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);
