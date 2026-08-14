/** Capability-pack migration proof. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { PACKAGE_RECIPE_MEMORY_CONTEXT } from "../lib/automatic-review-runtime.ts";
import { getRunStatus, killRun, startRun } from "../lib/async-runs.ts";
import {
  buildRecipeContextRecords,
  createActiveSkillRecipeContext,
  listActiveSkillRecipeComponents,
  readResolvedRecipeConfig,
  resolveRecipeReferencePath,
} from "../lib/recipes-references.ts";
import { createAutoToolsRuntime } from "../lib/runtime.ts";

const packageRoot = process.cwd();
const skillNames = ["actors", "artifacts", "media", "project-work", "recipe-memory", "swarm"];
const packageContext = createActiveSkillRecipeContext(
  skillNames.map((name) => ({ name, baseDir: join(packageRoot, "skills", name) })),
);

function noopExec() {
  return Promise.resolve({ code: 0, killed: false, stderr: "", stdout: "" });
}

async function waitForRunTerminal(stateDir: string): Promise<void> {
  const terminal = new Set(["cancelled", "done", "failed", "killed"]);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (terminal.has(String(getRunStatus(stateDir).status))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    killRun(stateDir);
  } catch {
    /* best effort cleanup */
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (terminal.has(String(getRunStatus(stateDir).status))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Capability packs cover same-Skill, cross-Skill, and explicit file imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-capability-references-"));
  try {
    const sameSkill = buildRecipeContextRecords(
      resolveRecipeReferencePath("swarm/quorum-review", packageRoot, packageContext)!,
      packageContext,
    );
    assert.ok(sameSkill.some((record) => record.logical_reference === "swarm/subagent-prompt"));
    const crossSkill = buildRecipeContextRecords(
      resolveRecipeReferencePath("project-work/repo-health", packageRoot, packageContext)!,
      packageContext,
    );
    assert.ok(crossSkill.some((record) => record.logical_reference === "actors/command-validate"));
    assert.ok(crossSkill.some((record) => record.logical_reference === "artifacts/report"));
    assert.ok(crossSkill.some((record) => record.logical_reference === "swarm/subagent-normalize"));

    const child = join(root, "child.json");
    const markdown = join(root, "absolute.md");
    const parent = join(root, "parent.json");
    await writeFile(child, JSON.stringify({ template: "echo relative" }));
    await writeFile(markdown, "---\ndescription: Absolute\n---\n\n```template\necho absolute\n```\n");
    await writeFile(parent, JSON.stringify({
      imports: { relative: "./child.json", absolute: markdown },
      template: [{ name: "relative" }, { name: "absolute" }],
    }));
    const explicit = buildRecipeContextRecords(parent, packageContext);
    assert.deepEqual(explicit.map((record) => record.logical_reference), [
      "parent.json", "child.json", "absolute.md",
    ]);
    assert.equal(isAbsolute(explicit[2].source_file), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Capability reference failures remain exact with no fallback aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-capability-failures-"));
  try {
    assert.throws(
      () => resolveRecipeReferencePath("media/player", root, createActiveSkillRecipeContext([])),
      /Active Skill Recipe not found: media\/player/,
    );
    const duplicate = createActiveSkillRecipeContext([
      { name: "media", baseDir: join(root, "first") },
      { name: "media", baseDir: join(root, "second") },
    ]);
    assert.throws(
      () => resolveRecipeReferencePath("media/player", root, duplicate),
      /Duplicate active Skill identity media/,
    );
    const collisionSkill = join(root, "collision");
    await mkdir(join(collisionSkill, "recipes"), { recursive: true });
    await writeFile(join(collisionSkill, "recipes", "task.json"), JSON.stringify({ template: "echo json" }));
    await writeFile(join(collisionSkill, "recipes", "task.md"), "```template\necho md\n```\n");
    const collision = createActiveSkillRecipeContext([{ name: "collision", baseDir: collisionSkill }]);
    assert.throws(
      () => resolveRecipeReferencePath("collision/task", root, collision),
      /stem collision/,
    );
    assert.throws(() => resolveRecipeReferencePath("std:task"), /std: Recipe references were removed/);
    assert.throws(() => resolveRecipeReferencePath("skill:media\/player"), /skill: Recipe references were removed/);
    const named = join(root, "named.json");
    await writeFile(named, JSON.stringify({ name: "declared", template: "echo bad" }));
    assert.throws(() => readResolvedRecipeConfig(named), /Recipe\.name was removed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Package reviewers, helpers, and tool discovery preserve Skill boundaries", async () => {
  const reviewer = resolveRecipeReferencePath(
    "recipe-memory/draft-review",
    packageRoot,
    PACKAGE_RECIPE_MEMORY_CONTEXT,
  );
  assert.match(reviewer ?? "", /skills[/\\]recipe-memory[/\\]recipes[/\\]draft-review\.json$/);
  const player = readResolvedRecipeConfig(
    resolveRecipeReferencePath("media/player", packageRoot, packageContext)!,
    [],
    { skillContext: packageContext },
  );
  assert.match(JSON.stringify(player?.template), /\{skill_dir\}\/scripts\/music-player\.mjs/);
  assert.match(player?.skill_dir ?? "", /skills[/\\]media$/);

  const root = await mkdtemp(join(tmpdir(), "pi-actors-capability-tools-"));
  try {
    const recipeRoot = join(root, "recipes");
    await mkdir(recipeRoot, { recursive: true });
    await writeFile(join(recipeRoot, "user-tool.json"), JSON.stringify({ template: "echo user" }));
    const registered: string[] = [];
    const runtime = createAutoToolsRuntime({
      configPath: join(root, "tool-registry.json"),
      exec: noopExec,
      recipeRoot,
      registerTool: (definition) => registered.push(definition.name),
      reservedToolNames: new Set(),
    });
    runtime.loadTools({ hasUI: false, ui: { notify() {} } });
    assert.deepEqual(registered, ["user-tool"]);
    assert.equal(runtime.getTools().has("media/player"), false);
    assert.equal(listActiveSkillRecipeComponents(packageContext).length, 58);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Direct qualified spawn captures Skill identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-capability-spawn-"));
  const stateDir = join(root, "run");
  try {
    const meta = startRun(
      {
        file: "media/player",
        run_id: `capability-direct-${process.pid}-${Date.now()}`,
        state_dir: stateDir,
        values: { command: "status", loop: false, player: "auto", source: root, volume: 70 },
      },
      packageRoot,
      { skillContext: packageContext },
    );
    assert.equal(meta.recipe_context_records?.[0].logical_reference, "media/player");
    assert.equal(meta.recipe_context_records?.[0].source_kind, "active_skill_component");
  } finally {
    await waitForRunTerminal(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});
