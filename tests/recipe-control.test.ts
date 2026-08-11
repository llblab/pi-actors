import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as Limits from "../lib/limits.ts";
import {
  assertRecipeHasNoMailbox,
  normalizeRecipeControl,
} from "../lib/recipe-control.ts";
import { readResolvedRecipeConfig } from "../lib/recipes-references.ts";

test("Recipe Control contracts preserve declared lowercase action order", () => {
  assert.equal(normalizeRecipeControl(undefined), undefined);
  assert.deepEqual(normalizeRecipeControl([]), []);
  assert.deepEqual(normalizeRecipeControl([" pause ", "review.continue", "seek_to"]), [
    "pause",
    "review.continue",
    "seek_to",
  ]);
  const longest = "a".repeat(Limits.CONTROL_ACTION_MAX_LENGTH);
  assert.deepEqual(normalizeRecipeControl([longest]), [longest]);
});

test("Recipe Control contracts reject malformed and duplicate actions", () => {
  assert.throws(() => normalizeRecipeControl("pause"), /must be an array/);
  assert.throws(() => normalizeRecipeControl([""]), /non-empty strings/);
  assert.throws(() => normalizeRecipeControl(["Pause"]), /invalid recipe.control action/);
  assert.throws(
    () => normalizeRecipeControl(["a".repeat(Limits.CONTROL_ACTION_MAX_LENGTH + 1)]),
    /exceeds 64 ASCII characters/,
  );
  assert.throws(() => normalizeRecipeControl(["pause", "pause"]), /duplicate recipe.control action/);
});

test("Recipe Control contracts reject runtime-owned Run actions", () => {
  for (const action of ["kill", "archive", "prune"]) {
    assert.throws(
      () => normalizeRecipeControl([action]),
      new RegExp(`runtime-reserved.*${action}`),
    );
  }
});

test("Recipe mailbox receives an exact breaking-migration error", () => {
  assert.doesNotThrow(() => assertRecipeHasNoMailbox({ template: "echo ok" }));
  assert.throws(
    () => assertRecipeHasNoMailbox({ mailbox: {}, template: "echo ok" }),
    /recipe\.mailbox was removed; replace it with control/,
  );
});

test("Resolved root Recipes own Control while direct delegation may inherit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-control-"));
  try {
    const child = join(root, "child.json");
    const delegated = join(root, "delegated.json");
    const overridden = join(root, "overridden.json");
    const composed = join(root, "composed.json");
    await writeFile(child, JSON.stringify({ control: ["pause"], template: "echo child" }));
    await writeFile(delegated, JSON.stringify({ template: child }));
    await writeFile(overridden, JSON.stringify({ control: ["resume"], template: child }));
    await writeFile(
      composed,
      JSON.stringify({
        imports: { child: child },
        template: [{ name: "child" }],
      }),
    );
    assert.deepEqual(readResolvedRecipeConfig(delegated)?.control, ["pause"]);
    assert.deepEqual(readResolvedRecipeConfig(overridden)?.control, ["resume"]);
    assert.equal(readResolvedRecipeConfig(composed)?.control, undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
