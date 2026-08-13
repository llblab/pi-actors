/**
 * Packaged skill regressions
 * Ensures extension-owned skills remain discoverable and self-contained
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import packageJson from "../package.json" with { type: "json" };

const packagedSkillPaths = readdirSync("skills", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("skills", entry.name, "SKILL.md").replaceAll("\\", "/"))
  .sort();

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function readSkillFrontmatter(path: string): string {
  const content = readFileSync(path, "utf8");
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

test("Package extension entrypoint uses compiled dist output", () => {
  assert.deepEqual(packageJson.pi.extensions, ["./dist/pi-actors/index.js"]);
  assert.equal(packageJson.files.includes("index.ts"), true);
  assert.equal(packageJson.files.includes("dist"), true);
  assert.equal(packageJson.files.includes("index.js"), false);
  assert.equal(existsSync("index.ts"), true);
  assert.equal(existsSync("index.js"), false);
});

test("Packaged skills are registered through dist metadata", () => {
  assert.deepEqual(packagedSkillPaths, [
    "skills/actors/SKILL.md",
    "skills/artifacts/SKILL.md",
    "skills/media/SKILL.md",
    "skills/project-work/SKILL.md",
    "skills/recipe-memory/SKILL.md",
    "skills/swarm/SKILL.md",
  ]);
  assert.deepEqual(packageJson.pi.skills, ["./dist/skills"]);
  assert.deepEqual(packageJson.pi.sourceSkills, ["./skills"]);
});

test("Auto-discovered extension contributes co-located skills", () => {
  const extensionSource = readFileSync("index.ts", "utf8");
  const extensionRuntimeSource = readFileSync("lib/extension-runtime.ts", "utf8");
  const pathsSource = readFileSync("lib/paths.ts", "utf8");
  assert.match(extensionSource, /pi\.on\("resources_discover"/);
  assert.match(extensionSource, /runtime\.discoverResources/);
  assert.match(extensionRuntimeSource, /Paths\.getExistingExtensionSkillPaths/);
  assert.match(pathsSource, /getExtensionSkillsDir/);
});

test("Packaged Skill identity matches its directory exactly", () => {
  for (const skillPath of packagedSkillPaths) {
    const frontmatter = readSkillFrontmatter(skillPath);
    const declared = frontmatter.match(/^name:\s*(\S+)$/m)?.[1];
    assert.equal(declared, dirname(skillPath).split(/[\\/]/).at(-1));
  }
});

test("Packaged skill frontmatter scalar lines avoid extra colons", () => {
  for (const skillPath of packagedSkillPaths) {
    const frontmatter = readSkillFrontmatter(skillPath);
    const scalarLines = frontmatter
      .split("\n")
      .filter((line) => /^\w+:\s*\S/.test(line));
    for (const line of scalarLines) {
      assert.equal(
        (line.match(/:/g) ?? []).length,
        1,
        `${skillPath} frontmatter line should contain only the key separator colon: ${line}`,
      );
    }
  }
});

test("Packaged swarm skill stays independent of pi-actors concrete runtime", () => {
  const forbiddenPatterns = [
    /pi-actors/i,
    /coordinator-locker/i,
    /\brun:/,
    /\btool:/,
    /\boutbox\b/i,
    /\bFIFO\b/i,
  ];
  for (const path of listMarkdownFiles("skills/swarm")) {
    const content = readFileSync(path, "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(
        content,
        pattern,
        `${path} should not mention ${pattern}`,
      );
    }
  }
});

test("Packaged skill markdown links resolve inside package", () => {
  const localMarkdownLink = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const path of listMarkdownFiles("skills")) {
    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(localMarkdownLink)) {
      const href = match[1].split("#")[0];
      if (!href) continue;
      const target = normalize(join(dirname(path), href));
      assert.ok(existsSync(target), `${path} link should resolve: ${match[1]}`);
    }
  }
});

test("Packaged actors skill stays focused on agent operations, not Inspector UI", () => {
  const actorSkill = readFileSync("skills/actors/SKILL.md", "utf8");
  assert.doesNotMatch(actorSkill, /\/actors-inspector|actor inspector|inside the overlay/i);
});

test("Packaged actors skill top recipes link prioritized recipes and deep inventory", () => {
  const actorSkill = readFileSync("skills/actors/SKILL.md", "utf8");
  const topRecipes = actorSkill.match(
    /## Top Recipes\r?\n(?<body>[\s\S]*?)\r?\n## Deep References/,
  )?.groups?.body;
  assert.ok(topRecipes, "actors skill should contain a Top Recipes section");
  assert.match(actorSkill, /docs\/async-runs\.md/);
  assert.match(actorSkill, /docs\/recipe-library\.md/);
  const linkedRecipes = [
    ...topRecipes.matchAll(/\[[^\]]+\]\(([^\)]+\.json)\)/g),
  ].map((match) => match[1]);
  assert.equal(linkedRecipes.length, 5, "top recipes should stay curated");
  for (const recipeFile of linkedRecipes) {
    assert.ok(
      existsSync(normalize(join("skills", "actors", recipeFile))),
      `${recipeFile} should exist`,
    );
  }
});
