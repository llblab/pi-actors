/**
 * Actor recipe context bundle regression tests.
 * Covers JSONL provenance formatting and prompt injection for child pi actors.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { appendRecipeContextToPiArgs, formatRecipeContextJsonl } from "../lib/recipes-context.ts";

const records = [
  {
    depth: 0,
    file: "/recipes/parent.json",
    import_path: [],
    name: "parent",
    recipe: { imports: { child: "child.json" }, template: [{ name: "child" }] },
    role: "entry" as const,
  },
  {
    alias: "child",
    depth: 1,
    file: "/recipes/child.json",
    import_path: ["child"],
    name: "child-recipe",
    recipe: { template: "pi -p child prompt" },
    role: "import" as const,
  },
];

test("Actor recipe context JSONL marks the current recipe node", () => {
  const jsonl = formatRecipeContextJsonl(records, {
    alias: "child",
    file: "/recipes/child.json",
    name: "child-recipe",
    path: "child",
  });
  const lines = jsonl.split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].you_are_here, undefined);
  assert.equal(lines[1].you_are_here, true);
  assert.equal(lines[1].you_are_here_path, "child");
  assert.equal(lines[1].name, "child-recipe");
  assert.deepEqual(lines[1].recipe, { template: "pi -p child prompt" });
});

test("Actor recipe context is appended only to pi print prompts", () => {
  const args = appendRecipeContextToPiArgs(
    "pi",
    ["--model", "m", "-p", "Do work"],
    records,
    { alias: "child" },
  );
  assert.equal(args[3].startsWith("Do work\n\nActor recipe context bundle"), true);
  assert.match(args[3], /"you_are_here":true/);
  assert.deepEqual(
    appendRecipeContextToPiArgs("echo", ["-p", "Do work"], records),
    ["-p", "Do work"],
  );
  assert.deepEqual(
    appendRecipeContextToPiArgs("pi", ["--model", "m", "Do work"], records),
    ["--model", "m", "Do work"],
  );
});

test("Actor recipe context skips print-mode options before appending to the prompt", () => {
  const args = appendRecipeContextToPiArgs(
    "pi",
    [
      "-p",
      "--model",
      "m",
      "--thinking",
      "off",
      "--no-tools",
      "Review",
      "scope",
    ],
    records,
    { alias: "child" },
  );
  assert.deepEqual(args.slice(0, 7), [
    "-p",
    "--model",
    "m",
    "--thinking",
    "off",
    "--no-tools",
    "Review",
  ]);
  assert.equal(args[7].startsWith("scope\n\nActor recipe context bundle"), true);
});

test("Actor recipe context ignores pi file args when finding the print prompt", () => {
  const args = appendRecipeContextToPiArgs(
    "pi",
    ["-p", "@screen.png", "Describe", "image"],
    records,
    { alias: "child" },
  );
  assert.equal(args[1], "@screen.png");
  assert.equal(args[2], "Describe");
  assert.equal(args[3].startsWith("image\n\nActor recipe context bundle"), true);
});
