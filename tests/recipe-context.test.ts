/** Live Recipe resolution environment regressions. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createActorExtensionRuntime } from "../lib/extension-runtime.ts";
import {
  createEmptyRecipeResolutionContext,
  createRecipeResolutionContext,
} from "../lib/recipes-context.ts";
import {
  createActiveSkillRecipeContext,
  resolveRecipeReferencePath,
} from "../lib/recipes-references.ts";

test("Recipe resolution contexts isolate session identity cwd and active Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-resolution-context-"));
  try {
    const alphaSkill = join(root, "alpha-skill");
    const betaSkill = join(root, "beta-skill");
    await Promise.all([
      mkdir(join(alphaSkill, "recipes"), { recursive: true }),
      mkdir(join(betaSkill, "recipes"), { recursive: true }),
    ]);
    await Promise.all([
      import("node:fs/promises").then((fs) =>
        fs.writeFile(join(alphaSkill, "recipes", "task.json"), JSON.stringify({ template: "echo alpha" })),
      ),
      import("node:fs/promises").then((fs) =>
        fs.writeFile(join(betaSkill, "recipes", "task.json"), JSON.stringify({ template: "echo beta" })),
      ),
    ]);
    const alpha = createRecipeResolutionContext(
      "session-alpha",
      join(root, "alpha-work"),
      createActiveSkillRecipeContext([{ name: "alpha", baseDir: alphaSkill }]),
    );
    const beta = createRecipeResolutionContext(
      "session-beta",
      join(root, "beta-work"),
      createActiveSkillRecipeContext([{ name: "beta", baseDir: betaSkill }]),
    );
    assert.equal(alpha.sessionId, "session-alpha");
    assert.equal(alpha.cwd, resolve(root, "alpha-work"));
    assert.notEqual(alpha.generation, beta.generation);
    assert.equal(Object.isFrozen(alpha), true);
    assert.equal(
      resolveRecipeReferencePath("alpha/task", alpha.cwd, alpha.activeSkills),
      join(alphaSkill, "recipes", "task.json"),
    );
    assert.throws(
      () => resolveRecipeReferencePath("beta/task", alpha.cwd, alpha.activeSkills),
      /Active Skill Recipe not found: beta\/task/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Live tool calls receive the current session Recipe resolution context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-live-resolution-"));
  try {
    const alphaSkill = join(root, "alpha");
    const betaSkill = join(root, "beta");
    await Promise.all([
      mkdir(join(alphaSkill, "recipes"), { recursive: true }),
      mkdir(join(betaSkill, "recipes"), { recursive: true }),
    ]);
    const definitions = new Map<string, any>();
    const runtime = createActorExtensionRuntime({
      getActiveTools: () => [...definitions.keys()],
      getAllTools: () => [...definitions.values()],
      getThinkingLevel: () => "off",
      registerTool: (definition: any) => definitions.set(definition.name, definition),
      setActiveTools: () => undefined,
    } as never);
    runtime.registerCoreTools();
    const alphaSession = {
      cwd: join(root, "alpha-work"),
      sessionManager: { getSessionId: () => "session-alpha" },
    } as never;
    const betaSession = {
      cwd: join(root, "beta-work"),
      sessionManager: { getSessionId: () => "session-beta" },
    } as never;
    runtime.beforeAgentStart("base", [{ name: "alpha", baseDir: alphaSkill }], alphaSession);
    runtime.beforeAgentStart("base", [{ name: "beta", baseDir: betaSkill }], betaSession);
    const inspect = definitions.get("inspect");
    const alphaResult = await inspect.execute(
      "alpha-inspect",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      alphaSession,
    );
    const betaResult = await inspect.execute(
      "beta-inspect",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      betaSession,
    );
    assert.deepEqual(alphaResult.details.active_skill_recipe_identities, ["alpha"]);
    assert.deepEqual(betaResult.details.active_skill_recipe_identities, ["beta"]);
    runtime.beforeAgentStart("base", [{ name: "beta", baseDir: betaSkill }], alphaSession);
    const replaced = await inspect.execute(
      "replaced-inspect",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      alphaSession,
    );
    assert.deepEqual(replaced.details.active_skill_recipe_identities, ["beta"]);
    await assert.rejects(
      inspect.execute(
        "missing-inspect",
        { target: "recipes", view: "imports", verbose: true },
        undefined,
        undefined,
        {
          cwd: root,
          sessionManager: { getSessionId: () => "missing-session" },
        },
      ),
      /Recipe resolution context is unavailable for session missing-session/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe resolution generation is stable and empty contexts are explicit", () => {
  const activeSkills = createActiveSkillRecipeContext([]);
  const first = createRecipeResolutionContext("session", ".", activeSkills);
  const second = createRecipeResolutionContext("session", ".", activeSkills);
  const empty = createEmptyRecipeResolutionContext("session", ".");
  assert.equal(first.generation, second.generation);
  assert.equal(first.generation, empty.generation);
  assert.deepEqual(empty.activeSkills.namespaces, {});
  assert.throws(
    () => createRecipeResolutionContext(" ", ".", activeSkills),
    /session id is required/,
  );
});
