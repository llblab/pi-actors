/**
 * Template recipe import regression tests
 * Covers recipe-layer imports, named import nodes, value references, and cycle checks
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getPackagedRecipeRoot } from "../lib/paths.ts";
import {
  buildRecipeContextRecords,
  getActiveSkillRecipeNamespaces,
  getRecipeIdFromPath,
  readResolvedRecipeConfig,
  resolveRecipePath,
  setActiveSkillRecipeSources,
} from "../lib/recipes-references.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Template recipes embed imported recipes as pipeline nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        name: "child",
        args: ["word:string", "suffix:string=!"],
        defaults: { suffix: "!" },
        template: "printf {word}{suffix}",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        name: "parent",
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

test("Qualified std and active-Skill Recipe references resolve without bare shadowing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-skill-recipes-"));
  try {
    const skillDir = join(root, "sample");
    const recipeDir = join(skillDir, "recipes", "nested");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeDir, { recursive: true }),
    );
    await writeFile(join(skillDir, "SKILL.md"), "# Sample\n");
    await writeFile(
      join(recipeDir, "task.json"),
      JSON.stringify({ template: "echo {skill_dir}" }),
    );
    setActiveSkillRecipeSources([
      { name: "sample", filePath: join(skillDir, "SKILL.md") },
    ]);
    const parent = join(root, "parent.json");
    await writeFile(
      parent,
      JSON.stringify({ template: "skill:sample/nested/task" }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.match(JSON.stringify(config.template), /sample/);
    assert.equal(
      buildRecipeContextRecords(join(recipeDir, "task.json"))[0]
        .qualified_name,
      "skill:sample/nested/task",
    );
    assert.equal(JSON.stringify(config.template).includes("skill:sample"), false);
    const stdParent = join(root, "std.json");
    await writeFile(
      stdParent,
      JSON.stringify({ template: "std:utility-package-summary" }),
    );
    assert.match(
      JSON.stringify(readResolvedRecipeConfig(stdParent)?.template),
      /recipe-utils\.mjs/,
    );
    assert.deepEqual(getActiveSkillRecipeNamespaces(), {
      sample: [join(skillDir, "recipes")],
    });
    setActiveSkillRecipeSources([]);
    assert.deepEqual(getActiveSkillRecipeNamespaces(), {});
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Active Skill Recipe namespace not found: sample/,
    );
  } finally {
    setActiveSkillRecipeSources([]);
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
    setActiveSkillRecipeSources([
      { name: "duplicate", baseDir: first },
      { name: "duplicate", baseDir: second },
    ]);
    const parent = join(root, "parent.json");
    await writeFile(
      parent,
      JSON.stringify({ template: "skill:duplicate/task" }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Ambiguous active Skill Recipe namespace duplicate/,
    );
  } finally {
    setActiveSkillRecipeSources([]);
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe paths expand repo and agent placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipeRoot = join(root, "recipes");
    assert.equal(
      resolveRecipePath("{repo}/recipes/base.json", recipeRoot),
      join(root, "recipes", "base.json"),
    );
    assert.equal(
      resolveRecipePath("{agent}/recipes/base.json", recipeRoot),
      join(
        process.env.PI_CODING_AGENT_DIR ??
          join(process.env.HOME!, ".pi", "agent"),
        "recipes",
        "base.json",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports resolve bare names by recipe-root priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(root, "agent");
    const userRoot = join(agentDir, "recipes");
    const adHocRoot = join(root, "adhoc");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(userRoot, { recursive: true }),
        fs.mkdir(adHocRoot, { recursive: true }),
      ]),
    );
    await writeFile(
      join(userRoot, "shared.json"),
      JSON.stringify({ template: "echo user" }),
    );
    await writeFile(
      join(adHocRoot, "shared.json"),
      JSON.stringify({ template: "echo adhoc" }),
    );
    await writeFile(
      join(adHocRoot, "parent.json"),
      JSON.stringify({
        imports: { shared: "shared" },
        template: { name: "shared" },
      }),
    );
    await writeFile(
      join(adHocRoot, "stdlib-parent.json"),
      JSON.stringify({
        imports: { utility: "utility-package-summary" },
        template: { name: "utility" },
      }),
    );
    const config = readResolvedRecipeConfig(join(adHocRoot, "parent.json"))!;
    assert.deepEqual(config.template, {
      defaults: { recipe_dir: userRoot },
      template: "echo user",
    });
    await rm(join(userRoot, "shared.json"), { force: true });
    const fallbackConfig = readResolvedRecipeConfig(
      join(adHocRoot, "parent.json"),
    )!;
    assert.deepEqual(fallbackConfig.template, {
      defaults: { recipe_dir: adHocRoot },
      template: "echo adhoc",
    });
    const stdlibConfig = readResolvedRecipeConfig(
      join(adHocRoot, "stdlib-parent.json"),
    )!;
    assert.match(JSON.stringify(stdlibConfig.template), /recipe-utils\.mjs/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe direct delegation resolves by recipe priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(root, "agent");
    const userRoot = join(agentDir, "recipes");
    const adHocRoot = join(root, "adhoc");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(userRoot, { recursive: true }),
        fs.mkdir(adHocRoot, { recursive: true }),
      ]),
    );
    await writeFile(
      join(userRoot, "shared.json"),
      JSON.stringify({
        async: true,
        args: ["message:string"],
        defaults: { message: "user" },
        control: ["stop"],
        retire_when: "children_terminal",
        template: "echo {message}",
      }),
    );
    await writeFile(
      join(adHocRoot, "shared.json"),
      JSON.stringify({
        defaults: { message: "adhoc" },
        template: "echo {message}",
      }),
    );
    await writeFile(
      join(adHocRoot, "parent.json"),
      JSON.stringify({
        defaults: { message: "parent" },
        template: "shared",
      }),
    );
    await writeFile(
      join(adHocRoot, "stdlib-parent.json"),
      JSON.stringify({
        template: "utility-package-summary",
      }),
    );
    const config = readResolvedRecipeConfig(join(adHocRoot, "parent.json"))!;
    assert.equal(config.async, true);
    assert.deepEqual(config.args, ["message:string"]);
    assert.deepEqual(config.defaults, { message: "parent" });
    assert.deepEqual(config.control, ["stop"]);
    assert.equal(config.retire_when, "children_terminal");
    assert.deepEqual(config.template, {
      args: ["message:string"],
      defaults: { message: "parent", recipe_dir: userRoot },
      template: "echo {message}",
    });
    await rm(join(userRoot, "shared.json"), { force: true });
    const fallbackConfig = readResolvedRecipeConfig(
      join(adHocRoot, "parent.json"),
    )!;
    assert.deepEqual(fallbackConfig.template, {
      defaults: { message: "parent", recipe_dir: adHocRoot },
      template: "echo {message}",
    });
    const stdlibConfig = readResolvedRecipeConfig(
      join(adHocRoot, "stdlib-parent.json"),
    )!;
    assert.match(JSON.stringify(stdlibConfig.template), /recipe-utils\.mjs/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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

test("Template recipe imports expand repo placeholders", async () => {
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
        imports: { child: "{repo}/recipes/child.json" },
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
        name: "ignored-name",
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
  child: child
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
    assert.deepEqual(config.imports, { child: "child" });
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
        name: "base-recipe",
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

test("Packaged library recipes parse and resolve imports", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) =>
    file.endsWith(".json"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.ok(config, `${file} should resolve`);
    assert.ok(config.template, `${file} should define a template`);
  }
});

test("Packaged async-run operations recipes expose actor run args", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  for (const file of [
    "utility-run-ops-snapshot.json",
    "pipeline-async-run-ops.json",
  ]) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
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

test("Packaged recipes contain no removed mailbox declarations", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    assert.doesNotMatch(await readFile(join(recipeDir, file), "utf8"), /\"mailbox\"\s*:/);
  }
});

test("Packaged recipes do not ship concrete model-version defaults", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) =>
    file.endsWith(".json"),
  );
  const modelLikeKey = /(^|_)models?$/;
  const concreteModelValue =
    /\b(openai|gpt|claude|deepseek|gemini|mistral|codex)\b/i;
  for (const file of files) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    const defaults = config?.defaults ?? {};
    for (const [key, value] of Object.entries(defaults)) {
      if (modelLikeKey.test(key)) {
        assert.equal(
          value,
          "{current_model}",
          `${file} may default ${key} only through current-model inheritance`,
        );
      }
      assert.ok(
        !concreteModelValue.test(JSON.stringify(value)),
        `${file} should not ship concrete model provider/version defaults in ${key}`,
      );
    }
  }
});

test("Packaged review recipes inherit current model and thinking by default", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const expectedModelDefaults: Record<string, string[]> = {
    "lens-swarm.json": ["model"],
    "pipeline-review-readiness.json": [
      "reviewer_model",
      "verifier_model",
      "merger_model",
      "judge_model",
    ],
    "pipeline-release-readiness.json": [
      "reviewer_model",
      "verifier_model",
      "merger_model",
      "judge_model",
    ],
    "subagent-review-coordinator.json": [
      "reviewer_model",
      "verifier_model",
      "merger_model",
      "judge_model",
    ],
    "subagent-preflight.json": ["model"],
    "subagent-review.json": ["model"],
    "subagent-verify.json": ["model"],
    "subagent-merge.json": ["model"],
    "subagent-judge.json": ["model"],
    "subagent-normalize.json": ["model"],
  };
  const expectedThinkingDefaults = [
    "lens-swarm.json",
    "pipeline-review-readiness.json",
    "pipeline-release-readiness.json",
    "subagent-review-coordinator.json",
    "subagent-preflight.json",
    "subagent-review.json",
    "subagent-verify.json",
    "subagent-merge.json",
    "subagent-judge.json",
    "subagent-normalize.json",
  ];
  for (const [file, keys] of Object.entries(expectedModelDefaults)) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    for (const key of keys) {
      assert.equal(config?.defaults?.[key], "{current_model}", `${file}:${key}`);
    }
  }
  for (const file of expectedThinkingDefaults) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.equal(config?.defaults?.thinking, "{current_thinking}", `${file}:thinking`);
  }
});

test("Packaged review stages require marked semantic evidence", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  for (const file of [
    "subagent-review.json",
    "subagent-verify.json",
    "subagent-merge.json",
    "subagent-judge.json",
    "subagent-normalize.json",
  ]) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.match(JSON.stringify(config?.template), /"accept_output":"review_evidence"/);
    assert.match(JSON.stringify(config?.template), /ACTOR_REVIEW_RESULT/);
  }
});

test("Packaged review coordinator preflights stage models before reviewer fanout", () => {
  const config = readResolvedRecipeConfig(
    join(__dirname, "..", "recipes", "subagent-review-coordinator.json"),
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
  const recipeRoot = getPackagedRecipeRoot();
  assert.deepEqual(readResolvedRecipeConfig(join(recipeRoot, "resource-locker.json"))?.control, [
    "enqueue", "claim", "complete", "fail", "acquire", "renew", "release", "stop",
  ]);
  assert.deepEqual(readResolvedRecipeConfig(join(recipeRoot, "music-player.json"))?.control, [
    "play", "pause", "resume", "toggle", "next", "previous", "stop", "status",
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
