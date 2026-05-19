/**
 * Template recipe import regression tests
 * Covers recipe-layer imports, named import nodes, value references, and cycle checks
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readResolvedRecipeConfig } from "../lib/recipe-references.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Template recipes embed imported recipes as pipeline nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipes-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        name: "child",
        args: ["word:string", "suffix:string"],
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
        args: ["word:string", "suffix:string"],
        defaults: { suffix: "!", word: "hello" },
        template: "printf {word}{suffix}",
      },
      "wc -c",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reject unknown named import nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipes-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipes-"));
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
      label: "base-recipe:docs",
      fallback: "default-profile",
      enabled_label: "enabled",
      empty_label: "empty",
    });
    assert.deepEqual(config.template, {
      defaults: {
        inherited_profile: "safe",
        inherited_level: 3,
        target: "docs",
        label: "base-recipe:docs",
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

test("Template recipes preserve mailbox declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipes-"));
  try {
    const base = join(root, "base.json");
    const recipe = join(root, "mailbox.json");
    await writeFile(
      base,
      JSON.stringify({ defaults: { message_type: "checkpoint.ready" }, template: "echo base" }),
    );
    await writeFile(
      recipe,
      JSON.stringify({
        imports: { base: "base.json" },
        mailbox: {
          accepts: ["control.approve", "control.revise", 7],
          emits: ["{base.defaults.message_type}", "run.done", false],
        },
        template: "echo mailbox",
      }),
    );

    const config = readResolvedRecipeConfig(recipe)!;
    assert.deepEqual(config.mailbox, {
      accepts: ["control.approve", "control.revise"],
      emits: ["checkpoint.ready", "run.done"],
    });
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

test("Packaged actor message recipes expose envelope-aligned type args", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  for (const file of ["subagent-message.json", "utility-actor-message.json"]) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.ok(config?.args?.includes("type:string"), `${file} should expose type:string`);
    assert.ok(!config?.args?.some((arg) => arg.startsWith("event_type")), `${file} should not expose event_type`);
    assert.ok(!config?.args?.some((arg) => arg.startsWith("event_policy")), `${file} should not expose event_policy`);
  }
});

test("Packaged async recipes declare mailbox metadata", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) =>
    file.endsWith(".json"),
  );

  const missing: string[] = [];
  for (const file of files) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    if (config?.async === true && !config.mailbox) missing.push(file);
  }
  assert.deepEqual(missing, []);
});

test("Template recipe imports reject cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipes-"));
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
