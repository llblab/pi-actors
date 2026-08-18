/**
 * Template recipe import regression tests
 * Covers recipe-layer imports, named import nodes, value references, and cycle checks
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildRecipeContextRecords,
  createActiveSkillRecipeContext,
  getActiveSkillRecipeNamespaces,
  getRecipeIdFromPath,
  inventoryActiveSkillRecipeComponents,
  listActiveSkillRecipeComponents,
  readResolvedRecipeConfig,
  resolveRecipePath,
  resolveRecipeReferencePath,
} from "../lib/recipes-references.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const packageSkillContext = createActiveSkillRecipeContext(
  ["actors", "artifacts", "music-player", "project-work", "recipe-memory", "swarm"].map(
    (name) => ({ name, baseDir: join(packageRoot, "skills", name) }),
  ),
);

function readPackageRecipe(file: string) {
  return readResolvedRecipeConfig(file, [], {
    skillContext: packageSkillContext,
  });
}

test("Template recipes embed imported recipes as pipeline nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        args: ["word:string", "suffix:string=!"],
        defaults: { suffix: "!" },
        template: "printf {word}{suffix}",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: {
          child: {
            from: "child.json",
            values: { word: "hello" },
          },
        },
        template: [{ name: "child" }, "wc -c"],
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.template, [
      {
        args: ["word:string", "suffix:string=!"],
        defaults: { recipe_dir: root, suffix: "!", word: "hello" },
        template: "printf {word}{suffix}",
      },
      "wc -c",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe context records preserve raw composition identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-context-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        defaults: { message: "hello" },
        template: "pi -p child",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: { child_alias: "child.json" },
        template: [{ name: "child_alias" }],
      }),
    );
    const records = buildRecipeContextRecords(parent);
    assert.deepEqual(
      records.map((record) => ({
        alias: record.alias,
        depth: record.depth,
        import_path: record.import_path,
        name: record.name,
        role: record.role,
      })),
      [
        {
          alias: undefined,
          depth: 0,
          import_path: [],
          name: "parent",
          role: "entry",
        },
        {
          alias: "child_alias",
          depth: 1,
          import_path: ["child_alias"],
          name: "child",
          role: "import",
        },
      ],
    );
    assert.deepEqual(records[1].recipe, {
      defaults: { message: "hello" },
      template: "pi -p child",
    });
    const config = readResolvedRecipeConfig(parent, [], {
      includeActorRecipeContext: true,
    })!;
    assert.equal(
      JSON.stringify(config.template).includes('"actorRecipeContext"'),
      true,
    );
    assert.equal(
      JSON.stringify(config.template).includes('"alias":"child_alias"'),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("File-backed Recipes receive immutable recipe and Skill directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-origin-"));
  try {
    const skillDir = join(root, "sample-skill");
    const recipeDir = join(skillDir, "recipes", "nested");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeDir, { recursive: true }),
    );
    await writeFile(join(skillDir, "SKILL.md"), "# Sample\n");
    const file = join(recipeDir, "origin.json");
    await writeFile(
      file,
      JSON.stringify({ template: "echo {recipe_dir} {skill_dir}" }),
    );
    const config = readResolvedRecipeConfig(file)!;
    assert.equal(config.recipe_dir, recipeDir);
    assert.equal(config.skill_dir, skillDir);
    assert.equal(config.values?.recipe_dir, recipeDir);
    assert.equal(config.values?.skill_dir, skillDir);
    await writeFile(
      file,
      JSON.stringify({
        args: ["recipe_dir:string"],
        template: "echo {recipe_dir}",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(file),
      /Recipe runtime value is reserved: recipe_dir/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipes reject skill_dir outside an owning Skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-no-skill-"));
  try {
    const file = join(root, "outside.json");
    await writeFile(
      file,
      JSON.stringify({
        artifacts: { report: "{skill_dir}/report.md" },
        template: "echo ok",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(file),
      /uses \{skill_dir\} outside an owning Skill directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Skill and file Recipe references resolve without ambient fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-skill-recipes-"));
  try {
    const skillDir = join(root, "sample");
    const recipeDir = join(skillDir, "recipes");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeDir, { recursive: true }),
    );
    await writeFile(join(skillDir, "SKILL.md"), "# Sample\n");
    await writeFile(
      join(recipeDir, "task.json"),
      JSON.stringify({ template: "echo {skill_dir}" }),
    );
    const skillContext = createActiveSkillRecipeContext([
      { name: "sample", filePath: join(skillDir, "SKILL.md") },
    ]);
    const parent = join(root, "parent.json");
    await writeFile(parent, JSON.stringify({ template: "sample/task" }));
    const config = readResolvedRecipeConfig(parent, [], { skillContext })!;
    assert.match(JSON.stringify(config.template), /sample/);
    assert.equal(
      buildRecipeContextRecords(join(recipeDir, "task.json"), skillContext)[0]
        .logical_reference,
      "sample/task",
    );
    assert.deepEqual(getActiveSkillRecipeNamespaces(skillContext), {
      sample: [recipeDir],
    });
    assert.deepEqual(listActiveSkillRecipeComponents(skillContext), [
      {
        file: join(recipeDir, "task.json"),
        identity: "sample/task",
        imports: {},
        skill: "sample",
        stem: "task",
      },
    ]);
    assert.equal(
      resolveRecipeReferencePath("./parent.json", root, skillContext),
      parent,
    );
    assert.throws(
      () => resolveRecipeReferencePath("std:task"),
      /std: Recipe references were removed in pi-actors 0\.46\..*Next: inspect target=recipes view=status/,
    );
    assert.throws(
      () => resolveRecipeReferencePath("skill:sample/task"),
      /skill: Recipe references were removed in pi-actors 0\.46\..*Next: inspect target=recipes view=doctor identity=sample\/task/,
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Active Skill Recipe not found: sample\/task/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Nested and colliding active-Skill Recipe stems fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-skill-stems-"));
  try {
    const skillDir = join(root, "sample");
    const recipeDir = join(skillDir, "recipes");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(recipeDir, "nested"), { recursive: true }),
    );
    await writeFile(join(recipeDir, "task.json"), JSON.stringify({ template: "echo json" }));
    await writeFile(join(recipeDir, "task.md"), "---\ntemplate: echo md\n---\n");
    await writeFile(join(recipeDir, "nested", "task.json"), JSON.stringify({ template: "echo nested" }));
    const skillContext = createActiveSkillRecipeContext([
      { name: "sample", baseDir: skillDir },
    ]);
    assert.throws(
      () => resolveRecipeReferencePath("sample/task", root, skillContext),
      /Skill Recipe stem collision: sample\/task has both \.json and \.md files/,
    );
    assert.equal(
      resolveRecipeReferencePath("sample/nested/task", root, skillContext),
      undefined,
    );
    assert.equal(
      buildRecipeContextRecords(
        join(recipeDir, "nested", "task.json"),
        skillContext,
      )[0].source_kind,
      "explicit_file_recipe",
    );
    assert.throws(
      () => listActiveSkillRecipeComponents(skillContext),
      /Nested Skill Recipe file is not addressable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Active-Skill inventory quarantines invalid components while exact resolution stays independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-skill-inventory-"));
  try {
    const validSkill = join(root, "valid");
    const brokenSkill = join(root, "broken");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(join(validSkill, "recipes"), { recursive: true }),
        fs.mkdir(join(brokenSkill, "recipes", "nested"), { recursive: true }),
      ]),
    );
    const validRecipe = join(validSkill, "recipes", "task.json");
    await writeFile(validRecipe, JSON.stringify({ template: "echo valid" }));
    await writeFile(
      join(brokenSkill, "recipes", "stale.json"),
      JSON.stringify({ name: "stale", template: "echo stale" }),
    );
    await writeFile(
      join(brokenSkill, "recipes", "nested", "hidden.json"),
      JSON.stringify({ template: "echo hidden" }),
    );
    const context = createActiveSkillRecipeContext([
      { name: "valid", baseDir: validSkill },
      { name: "broken", baseDir: brokenSkill },
    ]);
    const inventory = inventoryActiveSkillRecipeComponents(context);
    assert.equal(inventory.partial, true);
    assert.deepEqual(
      inventory.components.map((component) => component.identity),
      ["valid/task"],
    );
    assert.equal(inventory.rejected.length, 2);
    assert.equal(inventory.rejected.every((item) => item.skill === "broken"), true);
    assert.equal(
      resolveRecipeReferencePath("valid/task", root, context),
      validRecipe,
    );
    assert.throws(
      () => resolveRecipeReferencePath("valid/missing", root, context),
      /Skill Recipe component not found: valid\/missing; owning Skill "valid" is active.*Next: inspect target=recipes view=doctor identity=valid\/missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Duplicate active Skill names fail with deterministic ambiguity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-skill-collision-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(join(first, "recipes"), { recursive: true }),
        fs.mkdir(join(second, "recipes"), { recursive: true }),
      ]),
    );
    const skillContext = createActiveSkillRecipeContext([
      { name: "duplicate", baseDir: first },
      { name: "duplicate", baseDir: second },
    ]);
    assert.throws(
      () => resolveRecipeReferencePath("duplicate/task", root, skillContext),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /Duplicate active Skill identity duplicate \(2 active definitions\).*Next: inspect target=recipes view=doctor identity=duplicate\/task/,
        );
        assert.doesNotMatch(error.message, new RegExp(root));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Immutable active-Skill contexts isolate concurrent sessions and captured graphs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-skill-sessions-"));
  try {
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(join(alpha, "recipes"), { recursive: true }),
        fs.mkdir(join(beta, "recipes"), { recursive: true }),
      ]),
    );
    const alphaRecipe = join(alpha, "recipes", "task.json");
    const betaRecipe = join(beta, "recipes", "task.json");
    await writeFile(alphaRecipe, JSON.stringify({ template: "echo alpha" }));
    await writeFile(betaRecipe, JSON.stringify({ template: "echo beta" }));
    const alphaContext = createActiveSkillRecipeContext([
      { name: "alpha", baseDir: alpha },
    ]);
    const betaContext = createActiveSkillRecipeContext([
      { name: "beta", baseDir: beta },
    ]);
    const [resolvedAlpha, resolvedBeta] = await Promise.all([
      Promise.resolve(resolveRecipeReferencePath("alpha/task", root, alphaContext)),
      Promise.resolve(resolveRecipeReferencePath("beta/task", root, betaContext)),
    ]);
    assert.equal(resolvedAlpha, alphaRecipe);
    assert.equal(resolvedBeta, betaRecipe);
    assert.throws(
      () => resolveRecipeReferencePath("beta/task", root, alphaContext),
      /Active Skill Recipe not found: beta\/task/,
    );
    assert.throws(
      () => resolveRecipeReferencePath("alpha/task", root, betaContext),
      /Active Skill Recipe not found: alpha\/task/,
    );
    const captured = buildRecipeContextRecords(alphaRecipe, alphaContext);
    await writeFile(alphaRecipe, JSON.stringify({ template: "echo changed" }));
    assert.equal(captured[0].recipe.template, "echo alpha");
    assert.equal(captured[0].logical_reference, "alpha/task");
    assert.equal(captured[0].skill, "alpha");
    assert.equal(captured[0].source_kind, "active_skill_component");
    assert.equal(Object.isFrozen(alphaContext.namespaces), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe file paths resolve exactly from the supplied base", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipeRoot = join(root, "recipes");
    assert.equal(
      resolveRecipePath("./base.json", recipeRoot),
      join(recipeRoot, "base.json"),
    );
    assert.equal(
      resolveRecipePath(join(root, "absolute.md"), recipeRoot),
      join(root, "absolute.md"),
    );
    assert.throws(
      () => resolveRecipePath("base", recipeRoot),
      /explicit \.json or \.md path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template Recipe imports require explicit paths and never use user shadowing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const userRoot = join(root, "user");
    const adHocRoot = join(root, "adhoc");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(userRoot, { recursive: true }),
        fs.mkdir(adHocRoot, { recursive: true }),
      ]),
    );
    await writeFile(join(userRoot, "shared.json"), JSON.stringify({ template: "echo user" }));
    await writeFile(join(adHocRoot, "shared.json"), JSON.stringify({ template: "echo adhoc" }));
    const parent = join(adHocRoot, "parent.json");
    await writeFile(
      parent,
      JSON.stringify({
        imports: { shared: "./shared.json" },
        template: { name: "shared" },
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.template, {
      defaults: { recipe_dir: adHocRoot },
      template: "echo adhoc",
    });
    await writeFile(
      parent,
      JSON.stringify({
        imports: { shared: "shared" },
        template: { name: "shared" },
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Recipe import must use <skill>\/<recipe> or an explicit \.json\/\.md file path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template Recipe direct delegation uses only canonical references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const child = join(root, "shared.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        async: true,
        args: ["message:string"],
        defaults: { message: "child" },
        control: ["stop"],
        retire_when: "children_terminal",
        template: "echo {message}",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        defaults: { message: "parent" },
        template: "./shared.json",
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.equal(config.async, true);
    assert.deepEqual(config.args, ["message:string"]);
    assert.deepEqual(config.control, ["stop"]);
    assert.deepEqual(config.template, {
      args: ["message:string"],
      defaults: { message: "parent", recipe_dir: root },
      template: "echo {message}",
    });
    await writeFile(parent, JSON.stringify({ template: "shared" }));
    assert.equal(readResolvedRecipeConfig(parent)?.template, "shared");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Direct delegation inherits singleton identity without retargeting it to the wrapper Skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-singleton-delegation-"));
  const ownerDir = join(root, "music-player");
  const aliasDir = join(root, "alias-skill");
  const ownerRecipe = join(ownerDir, "recipes", "playback.json");
  const wrapper = join(aliasDir, "recipes", "wrapper.json");
  try {
    await Promise.all([
      mkdir(join(ownerDir, "recipes"), { recursive: true }),
      mkdir(join(aliasDir, "recipes"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(ownerDir, "SKILL.md"), "---\nname: music-player\ndescription: Owner.\n---\n"),
      writeFile(join(aliasDir, "SKILL.md"), "---\nname: alias-skill\ndescription: Alias.\n---\n"),
    ]);
    await Promise.all([
      writeFile(ownerRecipe, JSON.stringify({
        async: true,
        singleton: true,
        template: "echo owner",
      })),
      writeFile(wrapper, JSON.stringify({
        singleton: true,
        template: "../../music-player/recipes/playback.json",
      })),
    ]);
    const skillContext = createActiveSkillRecipeContext([
      { name: "music-player", baseDir: ownerDir },
      { name: "alias-skill", baseDir: aliasDir },
    ]);
    const resolved = readResolvedRecipeConfig(wrapper, [], { skillContext })!;
    assert.equal(resolved.singleton, true);
    assert.equal(resolved.singleton_run_id, "music-player");
    assert.equal(resolved.singleton_recipe_id, "music-player/playback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Direct delegation preserves the inherited contract and validates wrapper overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delegation-contract-"));
  try {
    const child = join(root, "worker.json");
    const parent = join(root, "wrapper.json");
    await writeFile(
      child,
      JSON.stringify({
        async: true,
        args: [
          "mode:enum(check,fix)",
          "attempts:int",
          "dry_run:bool",
        ],
        artifacts: { report: "report.md" },
        control: ["status"],
        template: "worker {mode} {attempts} {dry_run}",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        args: ["attempts:int"],
        defaults: { attempts: "3" },
        template: { template: "./worker.json" },
      }),
    );
    const resolved = readResolvedRecipeConfig(parent)!;
    assert.equal(resolved.async, true);
    assert.deepEqual(resolved.args, [
      "mode:enum(check,fix)",
      "attempts:int",
      "dry_run:bool",
    ]);
    assert.deepEqual(resolved.defaults, { attempts: "3" });
    assert.deepEqual(resolved.artifacts, { report: "report.md" });
    assert.deepEqual(resolved.control, ["status"]);
    await writeFile(
      parent,
      JSON.stringify({
        args: ["attempts:bool"],
        template: "./worker.json",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Conflicting argument type for attempts/,
    );
    await writeFile(
      parent,
      JSON.stringify({
        defaults: { missing: "value" },
        template: "./worker.json",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Unknown delegated Recipe default argument: missing/,
    );
    await writeFile(
      parent,
      JSON.stringify({
        defaults: { attempts: "many" },
        template: "./worker.json",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Argument attempts must be an integer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe import and node values override defaults and inline defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-precedence-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        args: ["mode:enum(inline,default,recipe,binding,node)=inline"],
        defaults: { mode: "default" },
        values: { mode: "recipe" },
        template: "echo {mode}",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: {
          child: { from: "child.json", values: { mode: "binding" } },
        },
        template: { name: "child", values: { mode: "node" } },
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.template, {
      args: ["mode:enum(inline,default,recipe,binding,node)=inline"],
      defaults: { mode: "node", recipe_dir: root },
      template: "echo {mode}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reject duplicate args, unknown defaults, and invalid enums", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-declarations-"));
  try {
    const duplicate = join(root, "duplicate.json");
    await writeFile(
      duplicate,
      JSON.stringify({ args: ["mode:string", "mode:string"], template: "echo {mode}" }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(duplicate),
      /Duplicate argument name\(s\): mode/,
    );
    const conflictingType = join(root, "conflicting-type.json");
    await writeFile(
      conflictingType,
      JSON.stringify({
        args: ["mode:enum(check,fix)"],
        template: "echo {mode:int}",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(conflictingType),
      /Conflicting argument type for mode/,
    );
    const unknownDefault = join(root, "unknown-default.json");
    await writeFile(
      unknownDefault,
      JSON.stringify({
        args: ["mode:string"],
        defaults: { typo: "check" },
        template: "echo {mode}",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(unknownDefault),
      /Unknown Recipe default argument: typo/,
    );
    const invalidDefault = join(root, "invalid-default.json");
    await writeFile(
      invalidDefault,
      JSON.stringify({
        args: ["mode:enum(check,fix)"],
        defaults: { mode: "delete" },
        template: "echo {mode}",
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(invalidDefault),
      /Argument mode must be one of: check, fix/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports reject invalid enum bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-contract-"));
  try {
    const child = join(root, "child.json");
    await writeFile(
      child,
      JSON.stringify({
        args: ["mode:enum(check,fix)=check"],
        template: "echo {mode}",
      }),
    );
    const invalid = join(root, "invalid.json");
    await writeFile(
      invalid,
      JSON.stringify({
        imports: { child: { from: "child.json", values: { mode: "delete" } } },
        template: { name: "child" },
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(invalid),
      /Argument mode must be one of: check, fix/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template Recipe imports resolve relative to the importing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipeRoot = join(root, "recipes");
    const child = join(recipeRoot, "child.json");
    const parent = join(recipeRoot, "parent.json");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeRoot, { recursive: true }),
    );
    await writeFile(child, JSON.stringify({ template: "echo {word}" }));
    await writeFile(
      parent,
      JSON.stringify({
        imports: { child: "./child.json" },
        template: { name: "child", values: { word: "ok" } },
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.template, {
      defaults: { recipe_dir: recipeRoot, word: "ok" },
      template: "echo {word}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes derive recipe identity from filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipe = join(root, "file-identity.json");
    await writeFile(
      recipe,
      JSON.stringify({
        description: "File identity recipe",
        template: "echo ok",
      }),
    );
    const config = readResolvedRecipeConfig(recipe)!;
    assert.equal(getRecipeIdFromPath(recipe), "file-identity");
    assert.equal(config.name, "file-identity");
    assert.equal(config.description, "File identity recipe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON and Markdown Recipes reject a declared top-level name", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-name-"));
  const guidance = /Recipe\.name was removed in pi-actors 0\.46\..*Next: remove the name field.*inspect target=recipes view=doctor/;
  try {
    const json = join(root, "named.json");
    const markdown = join(root, "named.md");
    await writeFile(json, JSON.stringify({ name: "other", template: "echo json" }));
    await writeFile(markdown, "---\nname: other\ntemplate: echo markdown\n---\n");
    assert.throws(() => readResolvedRecipeConfig(json), guidance);
    assert.throws(() => readResolvedRecipeConfig(markdown), guidance);
    assert.throws(() => buildRecipeContextRecords(json), guidance);
    assert.throws(() => buildRecipeContextRecords(markdown), guidance);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown recipes compile frontmatter and fenced templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-md-"));
  try {
    const child = join(root, "child.md");
    const parent = join(root, "parent.md");
    await writeFile(
      child,
      `---
description: Markdown child
args:
  - word:string
  - suffix:string=!
defaults:
  suffix: "!"
---

Human notes are advisory.

\`\`\`template
printf {word}{suffix}
\`\`\`
`,
    );
    await writeFile(
      parent,
      `---
imports:
  child: ./child.md
---

\`\`\`json recipe
{
  "template": { "name": "child", "values": { "word": "hello" } }
}
\`\`\`
`,
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.equal(getRecipeIdFromPath(child), "child");
    assert.deepEqual(config.imports, { child: "./child.md" });
    assert.deepEqual(config.template, {
      args: ["word:string", "suffix:string=!"],
      defaults: { recipe_dir: root, suffix: "!", word: "hello" },
      template: "printf {word}{suffix}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown recipes accept compact args and defaults authoring", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-md-compact-"));
  try {
    const recipe = join(root, "compact.md");
    await writeFile(
      recipe,
      `---
description: Compact Markdown
args: word:string, suffix:string
defaults:
  - word: hello
  - suffix: "!"
---

\`\`\`template
printf {word}{suffix}
\`\`\`
`,
    );
    const config = readResolvedRecipeConfig(recipe)!;
    assert.deepEqual(config.args, ["word:string", "suffix:string"]);
    assert.deepEqual(config.defaults, { suffix: "!", word: "hello" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reject unknown named import nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const parent = join(root, "parent.json");
    await writeFile(
      parent,
      JSON.stringify({
        imports: {},
        template: [{ name: "missing" }],
      }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Unknown recipe import: missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reference imported defaults and explicit values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const base = join(root, "base.json");
    const parent = join(root, "parent.json");
    await writeFile(
      base,
      JSON.stringify({
        defaults: { profile: "safe", nested: { level: 3 }, enabled: true },
        template: "echo base",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: {
          base: {
            from: "base.json",
            values: { target: "docs", empty: "" },
          },
        },
        defaults: {
          inherited_profile: "{base.defaults.profile}",
          inherited_level: "{base.defaults.nested.level}",
          target: "{base.values.target}",
          label: "{base.name}:{base.values.target}",
          fallback: "{base.defaults.missing=default-profile}",
          enabled_label: "{base.defaults.enabled?enabled:disabled}",
          empty_label: "{base.values.empty?present:empty}",
        },
        template:
          "run {base.defaults.profile} {base.values.target} {base.defaults.missing=fallback} {base.values.empty?yes:no} {label}",
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.defaults, {
      inherited_profile: "safe",
      inherited_level: 3,
      target: "docs",
      label: "base:docs",
      fallback: "default-profile",
      enabled_label: "enabled",
      empty_label: "empty",
    });
    assert.deepEqual(config.template, {
      defaults: {
        inherited_profile: "safe",
        inherited_level: 3,
        target: "docs",
        label: "base:docs",
        fallback: "default-profile",
        enabled_label: "enabled",
        empty_label: "empty",
      },
      template: "run safe docs fallback no {label}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reject removed mailbox declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipe = join(root, "removed-mailbox.json");
    await writeFile(
      recipe,
      JSON.stringify({ mailbox: { accepts: ["control.approve"] }, template: "echo removed" }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(recipe),
      /recipe\.mailbox was removed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Swarm capability pack exposes the exact migrated inventory", () => {
  const identities = listActiveSkillRecipeComponents(packageSkillContext)
    .map((component) => component.identity)
    .filter((identity) => identity.startsWith("swarm/"));
  assert.deepEqual(identities, [
    "swarm/architect",
    "swarm/checkpoint-continuation",
    "swarm/development-tasking",
    "swarm/lens-review",
    "swarm/quorum-review",
    "swarm/research-synthesis",
    "swarm/review-readiness",
    "swarm/subagent-artifact",
    "swarm/subagent-checkpoint",
    "swarm/subagent-conflict-report",
    "swarm/subagent-contradiction-map",
    "swarm/subagent-critic",
    "swarm/subagent-evidence-map",
    "swarm/subagent-followup",
    "swarm/subagent-judge",
    "swarm/subagent-merge",
    "swarm/subagent-normalize",
    "swarm/subagent-plan",
    "swarm/subagent-preflight",
    "swarm/subagent-prompt",
    "swarm/subagent-prompts",
    "swarm/subagent-quorum",
    "swarm/subagent-review",
    "swarm/subagent-review-coordinator",
    "swarm/subagent-task-card",
    "swarm/subagent-tools",
    "swarm/subagent-verify",
  ]);
});

test("Actors and Recipe-memory capability packs expose the exact migrated inventory", () => {
  const identities = listActiveSkillRecipeComponents(packageSkillContext)
    .map((component) => component.identity)
    .filter((identity) =>
      identity.startsWith("actors/") || identity.startsWith("recipe-memory/"),
    );
  assert.deepEqual(identities, [
    "actors/command-validate",
    "actors/jsonl-tail",
    "actors/recipe-validate",
    "actors/resource-locker",
    "actors/resource-locker-snapshot",
    "actors/run-ops-snapshot",
    "actors/run-state-files",
    "actors/run-summary",
    "recipe-memory/draft-review",
    "recipe-memory/tool-review",
  ]);
});

test("Packaged Skill Recipes parse and resolve imports", () => {
  const components = listActiveSkillRecipeComponents(packageSkillContext);
  assert.equal(components.length, 55);
  for (const component of components) {
    const config = readPackageRecipe(component.file);
    assert.ok(config, `${component.identity} should resolve`);
    assert.ok(config.template, `${component.identity} should define a template`);
  }
});

test("Packaged async-run operations recipes expose actor run args", () => {
  for (const file of [
    join(packageRoot, "skills", "actors", "recipes", "run-ops-snapshot.json"),
    join(packageRoot, "skills", "project-work", "recipes", "run-ops.json"),
  ]) {
    const config = readPackageRecipe(file);
    assert.ok(
      config?.args?.includes("run_id:string"),
      `${file} should expose run_id:string`,
    );
    assert.ok(
      !config?.args?.some((arg) => arg.startsWith("message_file")),
      `${file} should not expose message_file`,
    );
    assert.ok(
      !config?.args?.some((arg) => arg.startsWith("event_file")),
      `${file} should not expose event_file`,
    );
  }
});

test("Skill Recipes contain no removed mailbox declarations", async () => {
  const components = listActiveSkillRecipeComponents(packageSkillContext);
  for (const component of components) {
    assert.doesNotMatch(await readFile(component.file, "utf8"), /\"mailbox\"\s*:/);
  }
});

test("Skill Recipes do not ship concrete model-version defaults", () => {
  const components = listActiveSkillRecipeComponents(packageSkillContext);
  const modelLikeKey = /(^|_)models?$/;
  const concreteModelValue =
    /\b(openai|gpt|claude|deepseek|gemini|mistral|codex)\b/i;
  for (const component of components) {
    const config = readPackageRecipe(component.file);
    const defaults = config?.defaults ?? {};
    for (const [key, value] of Object.entries(defaults)) {
      if (modelLikeKey.test(key)) {
        assert.equal(
          value,
          "{current_model}",
          `${component.identity} may default ${key} only through current-model inheritance`,
        );
      }
      assert.ok(
        !concreteModelValue.test(JSON.stringify(value)),
        `${component.identity} should not ship concrete model provider/version defaults in ${key}`,
      );
    }
  }
});

test("Packaged review recipes inherit current model and thinking by default", () => {
  const swarmDir = join(packageRoot, "skills", "swarm", "recipes");
  const projectDir = join(packageRoot, "skills", "project-work", "recipes");
  const expectedModelDefaults: Array<[string, string[]]> = [
    [join(swarmDir, "lens-review.json"), ["model"]],
    [join(swarmDir, "review-readiness.json"), ["reviewer_model", "verifier_model", "merger_model", "judge_model"]],
    [join(projectDir, "release-readiness.json"), ["reviewer_model", "verifier_model", "merger_model", "judge_model"]],
    [join(swarmDir, "subagent-review-coordinator.json"), ["reviewer_model", "verifier_model", "merger_model", "judge_model"]],
    [join(swarmDir, "subagent-preflight.json"), ["model"]],
    [join(swarmDir, "subagent-review.json"), ["model"]],
    [join(swarmDir, "subagent-verify.json"), ["model"]],
    [join(swarmDir, "subagent-merge.json"), ["model"]],
    [join(swarmDir, "subagent-judge.json"), ["model"]],
    [join(swarmDir, "subagent-normalize.json"), ["model"]],
  ];
  for (const [file, keys] of expectedModelDefaults) {
    const config = readPackageRecipe(file);
    for (const key of keys) {
      assert.equal(config?.defaults?.[key], "{current_model}", `${file}:${key}`);
    }
    assert.equal(config?.defaults?.thinking, "{current_thinking}", `${file}:thinking`);
  }
});

test("Packaged review stages require marked semantic evidence", () => {
  const recipeDir = join(packageRoot, "skills", "swarm", "recipes");
  for (const file of [
    "subagent-review.json",
    "subagent-verify.json",
    "subagent-merge.json",
    "subagent-judge.json",
    "subagent-normalize.json",
  ]) {
    const config = readPackageRecipe(join(recipeDir, file));
    assert.match(JSON.stringify(config?.template), /"accept_output":"review_evidence"/);
    assert.match(JSON.stringify(config?.template), /ACTOR_REVIEW_RESULT/);
  }
});

test("Packaged review coordinator preflights stage models before reviewer fanout", () => {
  const config = readPackageRecipe(
    join(packageRoot, "skills", "swarm", "recipes", "subagent-review-coordinator.json"),
  )!;
  const steps = (config.template as { template?: unknown }).template;
  assert.ok(Array.isArray(steps));
  const first = steps[0] as Record<string, unknown>;
  assert.equal(first.parallel, true);
  assert.equal(first.failure, "root");
  assert.match(JSON.stringify(first), /ACTOR_PREFLIGHT_OK|Preflight check/);
  assert.match(JSON.stringify(steps[1]), /repeat.*lenses|reviewer/);
});

test("Packaged controlled services declare only actor-local actions", () => {
  assert.deepEqual(readPackageRecipe(join(packageRoot, "skills", "actors", "recipes", "resource-locker.json"))?.control, [
    "enqueue", "claim", "complete", "fail", "acquire", "renew", "release", "stop",
  ]);
  const playback = readPackageRecipe(
    join(packageRoot, "skills", "music-player", "recipes", "playback.json"),
  );
  assert.equal(playback?.singleton, true);
  assert.equal(playback?.singleton_run_id, "music-player");
  assert.equal(playback?.singleton_recipe_id, "music-player/playback");
  assert.deepEqual(playback?.control, [
    "play", "pause", "resume", "toggle", "next", "previous", "seek", "volume", "stop", "status",
  ]);
});

test("Template recipe rejects oversized files before parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipe = join(root, "huge.json");
    await writeFile(
      recipe,
      JSON.stringify({ template: "echo ok", padding: "x".repeat(1024 * 1024) }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(recipe),
      /Recipe file exceeds size limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports reject excessive depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    for (let index = 0; index < 34; index += 1) {
      await writeFile(
        join(root, `r${index}.json`),
        JSON.stringify({
          ...(index < 33 ? { imports: { next: `r${index + 1}.json` } } : {}),
          template: "echo ok",
        }),
      );
    }
    assert.throws(
      () => readResolvedRecipeConfig(join(root, "r0.json")),
      /Recipe import depth exceeds limit 32/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports reject cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const a = join(root, "a.json");
    const b = join(root, "b.json");
    await writeFile(
      a,
      JSON.stringify({ imports: { b: "b.json" }, template: "echo a" }),
    );
    await writeFile(
      b,
      JSON.stringify({ imports: { a: "a.json" }, template: "echo b" }),
    );
    assert.throws(() => readResolvedRecipeConfig(a), /Cyclic recipe import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
