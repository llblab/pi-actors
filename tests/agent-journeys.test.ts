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
  const media = join(root, "skills", "media");
  const stale = join(root, "skills", "stale");
  const recipeRoot = join(root, "recipes");
  await mkdir(join(media, "recipes"), { recursive: true });
  await mkdir(join(stale, "recipes"), { recursive: true });
  await mkdir(recipeRoot, { recursive: true });
  await writeFile(join(media, "SKILL.md"), "---\nname: media\ndescription: Use for media.\n---\n");
  await writeFile(join(stale, "SKILL.md"), "---\nname: stale\ndescription: Stale fixture.\n---\n");
  await writeFile(
    join(media, "recipes", "player.json"),
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
    { name: "media", baseDir: media },
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
        recipe: "media/player",
        values: { command: "status", source: "~/Music/1MIX" },
      },
      undefined,
      undefined,
      { cwd: fixture.root, recipeResolutionContext: fixture.context },
    );
    assert.equal(oneOff.details.launch_kind, "spawn");
    assert.equal(
      oneOff.details.recipe_file,
      join(fixture.media, "recipes", "player.json"),
    );
    assert.deepEqual(await readdir(fixture.recipeRoot), []);
    await waitForFile(join(oneOffState, "result.json"));

    // Journeys B and C: exact valid resolution survives unrelated catalog damage,
    // registration activates the compact specialization, and the generated tool is called.
    const inventory = inventoryActiveSkillRecipeComponents(fixture.skillContext);
    assert.equal(inventory.partial, true);
    assert.equal(
      inventory.components.some((component) => component.identity === "media/player"),
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
        from: "media/player",
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
    assert.equal(registration.details.source, "media/player");
    assert.equal(registration.details.callable_now, true);
    assert.deepEqual(registration.details.next_actions?.[0], "call tool music_player");
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.recipeRoot, "music_player.json"), "utf8")),
      { defaults: { source: "~/Music/1MIX" }, template: "media/player" },
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
        { recipe: "media/player", values: { source: "~/Music/1MIX" } },
        undefined,
        undefined,
        { cwd: fixture.root, recipeResolutionContext: inactive },
      ),
      /Owning Skill "media" is not active.*Next: activate Skill media.*inspect target=recipes view=doctor identity=media\/player/s,
    );
    await assert.rejects(
      executeRegisterTool(
        { from: "media/player", name: "inactive_player" },
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
      /Recipe source "media\/player" validation failed:.*Owning Skill "media" is not active.*Next: inspect target=recipes view=doctor identity=media\/player/s,
    );
    assert.equal(existsSync(join(fixture.recipeRoot, "inactive_player.json")), false);
  } finally {
    await rm(oneOffState, { force: true, recursive: true });
    await rm(toolState, { force: true, recursive: true });
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("Fresh-agent Journey B evidence records packaged Skill-driven completion", () => {
  const evidence = readFileSync(
    ".agents/evidence/agent-journey-b.md",
    "utf8",
  );
  assert.match(evidence, /release-candidate `dist` extension and packaged `dist\/skills`/);
  assert.match(evidence, /no repository context/);
  assert.match(evidence, /read only the packaged `actors` and `media` Skill bodies/);
  assert.match(evidence, /`callable_now=true`/);
  assert.match(evidence, /generated `music_player` tool with `command=status`/);
  assert.match(evidence, /`launch_kind=tool`/);
  assert.match(evidence, /\*\*Accepted\.\*\*/);
  assert.match(evidence, /no README\/docs read.*helper\/script source read.*`bash -lc`.*copied Recipe contract.*`spawn` substituted/s);
});

test("Agent UX report closure retains an owner and evidence for every failure", () => {
  const closure = readFileSync(
    ".agents/evidence/agent-ux-report-closure.md",
    "utf8",
  );
  const closedRows = closure
    .split("\n")
    .filter((line) => line.startsWith("|") && line.endsWith("| Closed |"));
  assert.equal(closedRows.length, 14);
  for (const section of [
    "Knowledge architecture and precedence",
    "Actors operating protocol",
    "Persistent tool authoring",
    "Diagnosis and recovery",
    "Capability and swarm Skills",
    "Human/agent content ownership",
    "Journey and installed parity",
    "Residual assessment",
  ]) assert.match(closure, new RegExp(`## ${section}`));
  assert.match(closure, /No material finding from the report remains unowned or deferred/);
  assert.match(closure, /No row is deferred to a hypothetical `0\.48` cleanup release/);
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
